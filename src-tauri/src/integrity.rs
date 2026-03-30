use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use sha2::{Sha256, Digest};
use serde::{Serialize, Deserialize};

const PT_DENY_ATTACH: c_int = 31;
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

// Code signing flags (from <cs_blobs.h>)
const CS_VALID: u32 = 0x00000001;

extern "C" {
    fn ptrace(request: c_int, pid: i32, addr: *mut c_void, data: c_int) -> c_int;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn sysctlbyname(
        name: *const c_char,
        oldp: *mut c_void,
        oldlenp: *mut usize,
        newp: *mut c_void,
        newlen: usize,
    ) -> c_int;
    fn _NSGetExecutablePath(buf: *mut c_char, bufsize: *mut u32) -> c_int;
    /// <sys/codesign.h> — pid=0 means self, ops=0=CS_OPS_STATUS
    fn csops(pid: i32, ops: u32, useraddr: *mut c_void, usersize: usize) -> c_int;
    /// <mach-o/dyld.h>
    fn _dyld_image_count() -> u32;
    fn _dyld_get_image_name(image_index: u32) -> *const c_char;
}

// ---------------------------------------------------------------------------
// Startup hardening
// ---------------------------------------------------------------------------

/// Call PT_DENY_ATTACH so any debugger that attaches receives SIGSEGV.
/// Must be called at process startup before any other work.
pub fn deny_debugger_attach() {
    unsafe { ptrace(PT_DENY_ATTACH, 0, std::ptr::null_mut(), 0); }
}

// ---------------------------------------------------------------------------
// sysctl helpers
// ---------------------------------------------------------------------------

fn sysctl_string(name: &str) -> Option<String> {
    let name_c = CString::new(name).ok()?;
    let mut len: usize = 0;
    unsafe {
        if sysctlbyname(name_c.as_ptr(), std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0) != 0
            || len == 0
        {
            return None;
        }
    }
    let mut buf = vec![0u8; len];
    unsafe {
        if sysctlbyname(
            name_c.as_ptr(),
            buf.as_mut_ptr() as *mut c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return None;
        }
    }
    while buf.last() == Some(&0) {
        buf.pop();
    }
    String::from_utf8(buf).ok()
}

fn sysctl_i32(name: &str) -> Option<i32> {
    let name_c = CString::new(name).ok()?;
    let mut val: i32 = 0;
    let mut len = std::mem::size_of::<i32>();
    unsafe {
        if sysctlbyname(
            name_c.as_ptr(),
            &mut val as *mut i32 as *mut c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return None;
        }
    }
    Some(val)
}

// ---------------------------------------------------------------------------
// Code signing
// ---------------------------------------------------------------------------

/// Returns true if the running binary carries a valid code signature.
/// Uses csops(2) with CS_OPS_STATUS (ops=0).
pub fn check_code_signing() -> bool {
    let mut flags: u32 = 0;
    let ret = unsafe {
        csops(
            0, // pid 0 = self
            0, // CS_OPS_STATUS
            &mut flags as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>(),
        )
    };
    ret == 0 && (flags & CS_VALID != 0)
}

// ---------------------------------------------------------------------------
// Frida / runtime injection detection
// ---------------------------------------------------------------------------

/// Checks for the Frida agent symbol injected into the process address space.
/// `__frida_agent_main` is exported by FridaGadget and re.frida.agent dylibs.
fn frida_symbol_present() -> bool {
    let sym = unsafe { dlsym(RTLD_DEFAULT, b"__frida_agent_main\0".as_ptr() as *const c_char) };
    !sym.is_null()
}

/// Returns true if any loaded dylib path looks like Frida, Substrate, or other
/// common dynamic analysis / hooking frameworks, OR is in a suspicious location
/// (e.g. /tmp) that a legitimate app would never load from.
pub fn check_dylib_injection() -> bool {
    let count = unsafe { _dyld_image_count() };
    for i in 0..count {
        let raw = unsafe { _dyld_get_image_name(i) };
        if raw.is_null() {
            continue;
        }
        let path = unsafe { CStr::from_ptr(raw) }.to_string_lossy().to_lowercase();

        // Known analysis / hooking framework strings
        let suspicious_substrings = [
            "frida",
            "gadget",
            "cynject",
            "objection",
            "substrate",
            "substitute",
            "cycript",
            "revealserver",
            "dtrace",
            "inject",
        ];
        if suspicious_substrings.iter().any(|s| path.contains(s)) {
            return true;
        }

        // Dylibs loaded from /tmp or world-writable staging areas are a red flag
        if path.starts_with("/tmp/") || path.starts_with("/private/tmp/") {
            return true;
        }
    }
    false
}

/// Returns true if Frida is detected via symbol lookup OR dylib enumeration.
pub fn check_frida() -> bool {
    frida_symbol_present() || check_dylib_injection()
}

// ---------------------------------------------------------------------------
// Environment sanity
// ---------------------------------------------------------------------------

/// Returns true if DYLD injection environment variables are present.
/// With SIP + hardened runtime these are stripped by the OS, so their
/// presence implies the binary was launched outside normal TCC controls.
pub fn check_dyld_env_injection() -> bool {
    ["DYLD_INSERT_LIBRARIES", "DYLD_FRAMEWORK_PATH", "DYLD_LIBRARY_PATH"]
        .iter()
        .any(|v| std::env::var(v).is_ok())
}

// ---------------------------------------------------------------------------
// SIP
// ---------------------------------------------------------------------------

/// Returns true when SIP is fully enabled (csr config == 0, no bits cleared).
/// Looks up csr_get_active_config via dlsym to avoid a hard private-SPI link.
pub fn check_sip() -> bool {
    let handle = unsafe { dlsym(RTLD_DEFAULT, b"csr_get_active_config\0".as_ptr() as *const c_char) };
    if handle.is_null() {
        return false;
    }
    let func: unsafe extern "C" fn(*mut u32) -> c_int = unsafe { std::mem::transmute(handle) };
    let mut config: u32 = u32::MAX;
    let ret = unsafe { func(&mut config) };
    ret == 0 && config == 0
}

// ---------------------------------------------------------------------------
// VM detection
// ---------------------------------------------------------------------------

/// Returns true when the hw.model string does NOT match any known VM vendor
/// and kern.hv_vmm_present (macOS 11+) is not set.
pub fn check_not_vm() -> bool {
    let model = hardware_model();
    let model_lower = model.to_lowercase();
    let is_vm_model = ["vmware", "virtualbox", "qemu", "parallels"]
        .iter()
        .any(|s| model_lower.contains(s));
    if is_vm_model {
        return false;
    }
    let hv_vmm_present = sysctl_i32("kern.hv_vmm_present").unwrap_or(0);
    hv_vmm_present == 0
}

// ---------------------------------------------------------------------------
// Hardware / OS identification
// ---------------------------------------------------------------------------

pub fn hardware_model() -> String {
    sysctl_string("hw.model").unwrap_or_else(|| "unknown".into())
}

pub fn os_version() -> String {
    sysctl_string("kern.osproductversion").unwrap_or_else(|| "unknown".into())
}

/// Unique hardware UUID (not user-resettable). Useful for server-side machine binding.
pub fn hardware_uuid() -> String {
    sysctl_string("kern.uuid").unwrap_or_else(|| "unknown".into())
}

/// SHA-256 of the running executable binary.
pub fn self_binary_hash() -> String {
    let mut buf = vec![0i8; 4096];
    let mut size = buf.len() as u32;
    let ret = unsafe { _NSGetExecutablePath(buf.as_mut_ptr(), &mut size) };
    if ret != 0 {
        return "unknown".into();
    }
    let path = unsafe { CStr::from_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .to_string();
    match std::fs::read(&path) {
        Ok(data) => {
            let mut h = Sha256::new();
            h.update(&data);
            hex::encode(h.finalize())
        }
        Err(_) => "unknown".into(),
    }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IntegrityReport {
    pub sip_enabled: bool,
    pub vm_detected: bool,
    pub hardware_model: String,
    pub os_version: String,
    pub hardware_uuid: String,
    pub app_binary_hash: String,
    pub code_signing_valid: bool,
    pub frida_detected: bool,
    pub dylib_injection_detected: bool,
    pub dyld_env_injection: bool,
}

pub fn run_checks() -> IntegrityReport {
    IntegrityReport {
        sip_enabled: check_sip(),
        vm_detected: !check_not_vm(),
        hardware_model: hardware_model(),
        os_version: os_version(),
        hardware_uuid: hardware_uuid(),
        app_binary_hash: self_binary_hash(),
        code_signing_valid: check_code_signing(),
        frida_detected: frida_symbol_present(),
        dylib_injection_detected: check_dylib_injection(),
        dyld_env_injection: check_dyld_env_injection(),
    }
}
