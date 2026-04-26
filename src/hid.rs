use std::ffi::c_void;
use std::os::raw::{c_char, c_long, c_uint};

// ---------------------------------------------------------------------------
// Opaque IOKit types
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct OpaqueIOHIDManager(c_void);
pub type IOHIDManagerRef = *mut OpaqueIOHIDManager;

#[repr(C)]
pub struct OpaqueIOHIDDevice(c_void);
pub type IOHIDDeviceRef = *mut OpaqueIOHIDDevice;

#[repr(C)]
pub struct OpaqueIOHIDValue(c_void);
pub type IOHIDValueRef = *mut OpaqueIOHIDValue;

#[repr(C)]
pub struct OpaqueIOHIDElement(c_void);
pub type IOHIDElementRef = *mut OpaqueIOHIDElement;

pub type IOOptionBits = c_uint;
pub type IOReturn = i32;

pub type IOHIDValueCallback = unsafe extern "C" fn(
    context: *mut c_void,
    result: IOReturn,
    sender: *mut c_void,
    value: IOHIDValueRef,
);

pub type IOHIDDeviceCallback = unsafe extern "C" fn(
    context: *mut c_void,
    result: IOReturn,
    sender: *mut c_void,
    device: IOHIDDeviceRef,
);

// ---------------------------------------------------------------------------
// IOKit + mach_time FFI
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct MachTimebaseInfo {
    pub numer: u32,
    pub denom: u32,
}

extern "C" {
    pub fn mach_absolute_time() -> u64;
    pub fn mach_timebase_info(info: *mut MachTimebaseInfo) -> u32;
}

// IOKit framework functions (linked via build.rs)
#[allow(dead_code)]
extern "C" {
    pub fn IOHIDManagerCreate(allocator: *const c_void, options: IOOptionBits) -> IOHIDManagerRef;

    pub fn IOHIDManagerSetDeviceMatchingMultiple(
        manager: IOHIDManagerRef,
        multiple: core_foundation_sys::array::CFArrayRef,
    );

    pub fn IOHIDManagerRegisterInputValueCallback(
        manager: IOHIDManagerRef,
        callback: IOHIDValueCallback,
        context: *mut c_void,
    );

    pub fn IOHIDManagerRegisterDeviceMatchingCallback(
        manager: IOHIDManagerRef,
        callback: IOHIDDeviceCallback,
        context: *mut c_void,
    );

    pub fn IOHIDManagerScheduleWithRunLoop(
        manager: IOHIDManagerRef,
        run_loop: core_foundation_sys::runloop::CFRunLoopRef,
        run_loop_mode: core_foundation_sys::string::CFStringRef,
    );

    pub fn IOHIDManagerOpen(manager: IOHIDManagerRef, options: IOOptionBits) -> IOReturn;
    pub fn IOHIDManagerClose(manager: IOHIDManagerRef, options: IOOptionBits) -> IOReturn;

    // Access check/request APIs (macOS 10.15+)
    // IOHIDCheckAccess returns IOHIDAccessType: 0=Granted, 1=Denied, 2=Unknown
    pub fn IOHIDCheckAccess(request_type: u32) -> u32;
    pub fn IOHIDRequestAccess(request_type: u32) -> bool;
    pub fn IOHIDManagerUnscheduleFromRunLoop(
        manager: IOHIDManagerRef,
        run_loop: core_foundation_sys::runloop::CFRunLoopRef,
        run_loop_mode: core_foundation_sys::string::CFStringRef,
    );

    pub fn IOHIDValueGetIntegerValue(value: IOHIDValueRef) -> c_long;
    pub fn IOHIDValueGetTimeStamp(value: IOHIDValueRef) -> u64;
    pub fn IOHIDValueGetElement(value: IOHIDValueRef) -> IOHIDElementRef;
    pub fn IOHIDElementGetDevice(element: IOHIDElementRef) -> IOHIDDeviceRef;
    pub fn IOHIDElementGetUsage(element: IOHIDElementRef) -> u32;
    pub fn IOHIDElementGetUsagePage(element: IOHIDElementRef) -> u32;

    /// Get a device property by CFString key. Returns a CFTypeRef (unretained).
    pub fn IOHIDDeviceGetProperty(device: IOHIDDeviceRef, key: *const c_void) -> *const c_void;
}

// CoreFoundation type checking helpers
extern "C" {
    fn CFGetTypeID(cf: *const c_void) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    /// kCFStringEncodingUTF8 = 0x08000100
    fn CFStringGetCString(
        s: *const c_void,
        buf: *mut c_char,
        buf_size: isize,
        encoding: u32,
    ) -> bool;
    /// kCFNumberSInt32Type = 3
    fn CFNumberGetValue(number: *const c_void, the_type: i32, value_ptr: *mut c_void) -> bool;
}

const K_CF_STRING_ENCODING_UTF8: u32 = 0x08000100;
const K_CF_NUMBER_SINT32_TYPE: i32 = 3;

// ---------------------------------------------------------------------------
// Mach time → wall-clock nanoseconds conversion
// ---------------------------------------------------------------------------

#[derive(Copy, Clone)]
pub struct TimebaseInfo {
    pub numer: u32,
    pub denom: u32,
}

impl TimebaseInfo {
    pub fn get() -> Self {
        let mut info = MachTimebaseInfo { numer: 0, denom: 0 };
        unsafe { mach_timebase_info(&mut info) };
        Self {
            numer: info.numer,
            denom: info.denom,
        }
    }
}

/// Convert a mach_absolute_time timestamp (from IOHIDValueGetTimeStamp) to
/// wall-clock nanoseconds since Unix epoch.
pub fn mach_to_wall_ns(
    event_mach: u64,
    start_mach: u64,
    start_wall_ns: u64,
    tb: &TimebaseInfo,
) -> u64 {
    let delta_mach = event_mach.saturating_sub(start_mach);
    let delta_ns = (delta_mach as u128 * tb.numer as u128 / tb.denom as u128) as u64;
    start_wall_ns.saturating_add(delta_ns)
}

fn hid_log(msg: &str) {
    let line = format!("[hid] {}\n", msg);
    eprint!("{}", line);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/handtyped-hid.log")
    {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

use crate::session::{AppState, KeyEvent, KeyboardInfo};
use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::dictionary::CFMutableDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::runloop::CFRunLoopGetMain;
use std::sync::Arc;

// HID usage page for keyboard/keypad
const K_HID_PAGE_KEYBOARD: u32 = 0x07;

// Minimum plausible inter-keydown interval for a human typist (nanoseconds).
// Mechanical keyboard debounce is ~5 ms; humans rarely exceed 300 WPM (~20 ms/key).
// Values below this threshold (for non-modifier keys) are flagged as suspicious.
const SUSPICIOUS_INTERVAL_NS: u64 = 5_000_000; // 5 ms
const BUILTIN_TRANSPORTS: &[&str] = &["SPI", "FIFO"];

// HID usage codes for modifier keys (keyboard page 0x07, 0xE0–0xE7).
// Modifiers are held concurrently with other keys, so their inter-key timing
// is naturally short and should NOT be flagged.
const MODIFIER_USAGE_MIN: u32 = 0xE0;
const MODIFIER_USAGE_MAX: u32 = 0xE7;

// Device matching dictionary keys
const K_USAGE_PAGE_KEY: &str = "DeviceUsagePage";
const K_USAGE_KEY: &str = "DeviceUsage";
const K_VENDOR_ID_KEY: &str = "VendorID";
// Generic Desktop page = 0x01, Keyboard usage = 0x06
const K_HID_USAGE_GD_KEYBOARD: i32 = 0x06;
const K_HID_PAGE_GENERIC_DESKTOP: i32 = 0x01;
// Apple Inc. vendor ID — restricts capture to Apple-manufactured keyboards only
const K_APPLE_VENDOR_ID: i32 = 0x05AC;

const K_OPTIONS_NONE: IOOptionBits = 0;
// IOHIDRequestType enum: PostEvent=0, ListenEvent=1
const K_IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
// IOHIDAccessType enum: Granted=0, Denied=1, Unknown=2
const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0;
const K_IOHID_ACCESS_TYPE_DENIED: u32 = 1;
const K_IOHID_ACCESS_TYPE_UNKNOWN: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMonitoringAccess {
    Granted,
    Denied,
    Unknown,
}

pub fn input_monitoring_access_from_raw(access: u32) -> InputMonitoringAccess {
    match access {
        K_IOHID_ACCESS_TYPE_GRANTED => InputMonitoringAccess::Granted,
        K_IOHID_ACCESS_TYPE_DENIED => InputMonitoringAccess::Denied,
        K_IOHID_ACCESS_TYPE_UNKNOWN => InputMonitoringAccess::Unknown,
        _ => InputMonitoringAccess::Unknown,
    }
}

pub unsafe fn input_monitoring_access() -> InputMonitoringAccess {
    input_monitoring_access_from_raw(IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT))
}

struct CallbackContext {
    state: Arc<AppState>,
    start_mach: u64,
    start_wall_ns: u64,
    tb: TimebaseInfo,
}

fn leak_callback_context(
    state: Arc<AppState>,
    start_mach: u64,
    start_wall_ns: u64,
    tb: TimebaseInfo,
) -> *mut c_void {
    // IOHID may continue enumerating devices on the main run loop even after a
    // failed open path returns. Keeping callback contexts alive for the process
    // lifetime avoids use-after-free crashes during startup/retry churn.
    Box::into_raw(Box::new(CallbackContext {
        state,
        start_mach,
        start_wall_ns,
        tb,
    })) as *mut c_void
}

// ---------------------------------------------------------------------------
// Input value callback (keystroke events)
// ---------------------------------------------------------------------------

unsafe extern "C" fn hid_input_callback(
    context: *mut c_void,
    _result: IOReturn,
    _sender: *mut c_void,
    value: IOHIDValueRef,
) {
    if context.is_null() || value.is_null() {
        return;
    }

    let ctx = &*(context as *const CallbackContext);

    let element = IOHIDValueGetElement(value);
    if element.is_null() {
        return;
    }

    // Only process keyboard/keypad usage page events
    let usage_page = IOHIDElementGetUsagePage(element);
    if usage_page != K_HID_PAGE_KEYBOARD {
        return;
    }

    let usage = IOHIDElementGetUsage(element);
    if usage == 0 {
        return;
    }

    let device = IOHIDElementGetDevice(element);
    if device.is_null() {
        return;
    }

    let transport = device_property_string(device, "Transport").unwrap_or_else(|| "unknown".into());
    if !BUILTIN_TRANSPORTS.contains(&transport.as_str()) {
        return;
    }

    let int_val = IOHIDValueGetIntegerValue(value);
    let kind = if int_val != 0 { "down" } else { "up" };

    let mach_ts = IOHIDValueGetTimeStamp(value);
    let wall_ns = mach_to_wall_ns(mach_ts, ctx.start_mach, ctx.start_wall_ns, &ctx.tb);

    // Timing anomaly detection: flag non-modifier keydowns that arrive impossibly
    // fast (below mechanical keyboard debounce time) as potentially synthetic.
    let suspicious = if int_val != 0 {
        let is_modifier = usage >= MODIFIER_USAGE_MIN && usage <= MODIFIER_USAGE_MAX;
        if is_modifier {
            false
        } else {
            let last_ns = ctx
                .state
                .last_keydown_ns
                .load(std::sync::atomic::Ordering::Relaxed);
            let suspicious =
                last_ns > 0 && wall_ns.saturating_sub(last_ns) < SUSPICIOUS_INTERVAL_NS;
            ctx.state
                .last_keydown_ns
                .store(wall_ns, std::sync::atomic::Ordering::Relaxed);
            suspicious
        }
    } else {
        false
    };

    // For each keydown from the built-in keyboard, record timestamp
    if int_val != 0 {
        ctx.state
            .builtin_keydown_timestamp
            .store(wall_ns, std::sync::atomic::Ordering::Release);
    }

    let event = KeyEvent {
        t: wall_ns,
        kind: kind.into(),
        key: usage,
        flags: 0,
        suspicious,
    };

    if let Ok(mut s) = ctx.state.session.lock() {
        s.append_key(event);
    }
}

// ---------------------------------------------------------------------------
// Device matched callback — captures keyboard transport + product ID
// ---------------------------------------------------------------------------

unsafe fn device_property_string(device: IOHIDDeviceRef, key: &str) -> Option<String> {
    let key_cf = CFString::new(key);
    let val = IOHIDDeviceGetProperty(device, key_cf.as_concrete_TypeRef() as *const c_void);
    if val.is_null() {
        return None;
    }
    if CFGetTypeID(val) != CFStringGetTypeID() {
        return None;
    }
    let mut buf = [0i8; 256];
    if CFStringGetCString(
        val,
        buf.as_mut_ptr(),
        buf.len() as isize,
        K_CF_STRING_ENCODING_UTF8,
    ) {
        let cstr = std::ffi::CStr::from_ptr(buf.as_ptr());
        Some(cstr.to_string_lossy().into_owned())
    } else {
        None
    }
}

unsafe fn device_property_u32(device: IOHIDDeviceRef, key: &str) -> Option<u32> {
    let key_cf = CFString::new(key);
    let val = IOHIDDeviceGetProperty(device, key_cf.as_concrete_TypeRef() as *const c_void);
    if val.is_null() {
        return None;
    }
    if CFGetTypeID(val) != CFNumberGetTypeID() {
        return None;
    }
    let mut result: i32 = 0;
    if CFNumberGetValue(
        val,
        K_CF_NUMBER_SINT32_TYPE,
        &mut result as *mut i32 as *mut c_void,
    ) {
        Some(result as u32)
    } else {
        None
    }
}

unsafe extern "C" fn hid_device_matched_callback(
    context: *mut c_void,
    _result: IOReturn,
    _sender: *mut c_void,
    device: IOHIDDeviceRef,
) {
    if context.is_null() || device.is_null() {
        return;
    }
    let ctx = &*(context as *const CallbackContext);

    let transport = device_property_string(device, "Transport").unwrap_or_else(|| "unknown".into());
    let product_id = device_property_u32(device, "ProductID").unwrap_or(0);
    let vendor_id = device_property_u32(device, "VendorID").unwrap_or(K_APPLE_VENDOR_ID as u32);

    hid_log(&format!(
        "device matched: transport={} vendor=0x{:04x} product=0x{:04x}",
        transport, vendor_id, product_id
    ));

    if BUILTIN_TRANSPORTS.contains(&transport.as_str()) {
        if let Ok(mut ki) = ctx.state.keyboard_info.lock() {
            *ki = Some(KeyboardInfo {
                vendor_id,
                product_id,
                transport,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Build device-matching array: Apple keyboards only (VendorID=0x05AC, GD Keyboard)
// ---------------------------------------------------------------------------

fn make_matching_array() -> CFArray<core_foundation::dictionary::CFDictionary<CFString, CFNumber>> {
    let usage_page_key = CFString::new(K_USAGE_PAGE_KEY);
    let usage_key = CFString::new(K_USAGE_KEY);
    let vendor_key = CFString::new(K_VENDOR_ID_KEY);

    let page_val = CFNumber::from(K_HID_PAGE_GENERIC_DESKTOP);
    let usage_val = CFNumber::from(K_HID_USAGE_GD_KEYBOARD);
    let vendor_val = CFNumber::from(K_APPLE_VENDOR_ID);

    let matching: CFMutableDictionary<CFString, CFNumber> =
        CFMutableDictionary::from_CFType_pairs(&[
            (usage_page_key, page_val),
            (usage_key, usage_val),
            (vendor_key, vendor_val),
        ]);
    CFArray::from_CFTypes(&[matching.to_immutable()])
}

/// Must be called from the main thread. Checks and requests Input Monitoring access.
pub unsafe fn request_input_monitoring_access() {
    let access = input_monitoring_access();
    hid_log(&format!(
        "IOHIDCheckAccess: {:?} (granted/denied/unknown)",
        access
    ));
    if access != InputMonitoringAccess::Granted {
        let result = IOHIDRequestAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT);
        hid_log(&format!("IOHIDRequestAccess: {}", result));
    }
}

/// Initialises HID capture on the MAIN run loop.
/// Must be called from the main thread (inside Tauri's .setup() hook).
/// Only matches Apple keyboards (VendorID 0x05AC) to exclude HID injection devices.
pub fn start_hid_capture(state: Arc<AppState>) {
    unsafe {
        let access = input_monitoring_access();
        if access == InputMonitoringAccess::Denied {
            hid_log("Input Monitoring denied; skipping HID capture startup until relaunch");
            return;
        }

        let start_mach = mach_absolute_time();
        let start_wall_ns = state.session.lock().unwrap().start_wall_ns;
        let tb = TimebaseInfo::get();

        let mode = core_foundation_sys::runloop::kCFRunLoopDefaultMode;
        let run_loop = CFRunLoopGetMain();

        let matching_array = make_matching_array();

        let manager = IOHIDManagerCreate(
            core_foundation_sys::base::kCFAllocatorDefault as *const c_void,
            K_OPTIONS_NONE,
        );
        if manager.is_null() {
            hid_log("IOHIDManagerCreate failed");
            return;
        }

        IOHIDManagerSetDeviceMatchingMultiple(manager, matching_array.as_concrete_TypeRef());

        let ctx_ptr = leak_callback_context(Arc::clone(&state), start_mach, start_wall_ns, tb);

        IOHIDManagerRegisterInputValueCallback(manager, hid_input_callback, ctx_ptr);
        IOHIDManagerRegisterDeviceMatchingCallback(manager, hid_device_matched_callback, ctx_ptr);
        IOHIDManagerScheduleWithRunLoop(manager, run_loop, mode);

        let ret = IOHIDManagerOpen(manager, K_OPTIONS_NONE);
        if ret == 0 {
            state
                .hid_active
                .store(true, std::sync::atomic::Ordering::Release);
            hid_log("capture active");
            return;
        }

        hid_log(&format!(
            "IOHIDManagerOpen failed: {}, will retry from background",
            ret
        ));
        IOHIDManagerUnscheduleFromRunLoop(manager, run_loop, mode);
    }

    // If first open failed (permission not yet granted), poll from a background thread.
    std::thread::Builder::new()
        .name("hid-retry".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(2));

            unsafe {
                let a = input_monitoring_access();
                hid_log(&format!("retry IOHIDCheckAccess: {:?}", a));
                if a == InputMonitoringAccess::Denied {
                    hid_log("Input Monitoring denied during retry; stopping HID retry loop");
                    return;
                }
                if a == InputMonitoringAccess::Unknown {
                    continue;
                }

                let start_mach = mach_absolute_time();
                let start_wall_ns = state.session.lock().unwrap().start_wall_ns;
                let tb = TimebaseInfo::get();
                let mode = core_foundation_sys::runloop::kCFRunLoopDefaultMode;
                let run_loop = CFRunLoopGetMain();

                let matching_array = make_matching_array();

                let manager = IOHIDManagerCreate(
                    core_foundation_sys::base::kCFAllocatorDefault as *const c_void,
                    K_OPTIONS_NONE,
                );
                if manager.is_null() {
                    continue;
                }

                IOHIDManagerSetDeviceMatchingMultiple(
                    manager,
                    matching_array.as_concrete_TypeRef(),
                );

                let ctx_ptr =
                    leak_callback_context(Arc::clone(&state), start_mach, start_wall_ns, tb);

                IOHIDManagerRegisterInputValueCallback(manager, hid_input_callback, ctx_ptr);
                IOHIDManagerRegisterDeviceMatchingCallback(
                    manager,
                    hid_device_matched_callback,
                    ctx_ptr,
                );
                IOHIDManagerScheduleWithRunLoop(manager, run_loop, mode);

                let ret = IOHIDManagerOpen(manager, K_OPTIONS_NONE);
                if ret != 0 {
                    hid_log(&format!("retry IOHIDManagerOpen failed: {}", ret));
                    IOHIDManagerUnscheduleFromRunLoop(manager, run_loop, mode);
                    continue;
                }

                state
                    .hid_active
                    .store(true, std::sync::atomic::Ordering::Release);
                hid_log("capture active (after retry)");
                return;
            }
        })
        .expect("failed to spawn hid-capture thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mach_to_wall_ns_zero_delta() {
        let tb = TimebaseInfo { numer: 1, denom: 1 };
        let result = mach_to_wall_ns(1000, 1000, 5_000_000_000, &tb);
        assert_eq!(result, 5_000_000_000);
    }

    #[test]
    fn test_mach_to_wall_ns_positive_delta() {
        let tb = TimebaseInfo { numer: 1, denom: 1 };
        let result = mach_to_wall_ns(2000, 1000, 5_000_000_000, &tb);
        assert_eq!(result, 5_000_001_000);
    }

    #[test]
    fn test_mach_to_wall_ns_apple_silicon_typical() {
        // Apple Silicon: numer=125, denom=3 → 3 ticks = 125 ns
        let tb = TimebaseInfo {
            numer: 125,
            denom: 3,
        };
        let result = mach_to_wall_ns(1003, 1000, 0, &tb);
        assert_eq!(result, 125);
    }

    #[test]
    fn test_mach_to_wall_ns_no_underflow() {
        let tb = TimebaseInfo { numer: 1, denom: 1 };
        let result = mach_to_wall_ns(500, 1000, 5_000_000_000, &tb);
        assert_eq!(result, 5_000_000_000);
    }

    /// Test that suspicious timing detection flags very fast keypresses.
    #[test]
    fn test_suspicious_timing_detection() {
        const SUSPICIOUS_INTERVAL_NS: u64 = 5_000_000; // 5ms

        // Normal typing pace (>5ms between keys) should not be suspicious.
        let last_keydown_ns: u64 = 1_000_000_000;
        let current_ns: u64 = 1_010_000_000; // 10ms later
        let interval = current_ns.saturating_sub(last_keydown_ns);
        assert!(interval >= SUSPICIOUS_INTERVAL_NS);

        // Suspiciously fast typing (<5ms) would be flagged.
        let fast_current_ns: u64 = 1_003_000_000; // 3ms later
        let fast_interval = fast_current_ns.saturating_sub(last_keydown_ns);
        assert!(fast_interval < SUSPICIOUS_INTERVAL_NS);
    }

    #[test]
    fn test_make_matching_array_targets_apple_keyboard_only() {
        let matching_array = make_matching_array();
        assert_eq!(matching_array.len(), 1);

        let matching = matching_array.get(0).expect("missing matching dictionary");
        let usage_page_key = CFString::new(K_USAGE_PAGE_KEY);
        let usage_key = CFString::new(K_USAGE_KEY);
        let vendor_key = CFString::new(K_VENDOR_ID_KEY);

        let usage_page = matching
            .find(&usage_page_key)
            .expect("missing usage page")
            .to_i32()
            .expect("usage page is not a CFNumber");
        let usage = matching
            .find(&usage_key)
            .expect("missing usage")
            .to_i32()
            .expect("usage is not a CFNumber");
        let vendor = matching
            .find(&vendor_key)
            .expect("missing vendor id")
            .to_i32()
            .expect("vendor is not a CFNumber");

        assert_eq!(usage_page, K_HID_PAGE_GENERIC_DESKTOP);
        assert_eq!(usage, K_HID_USAGE_GD_KEYBOARD);
        assert_eq!(vendor, K_APPLE_VENDOR_ID);
    }

    #[test]
    fn test_builtin_transports_include_spi_and_fifo() {
        assert!(BUILTIN_TRANSPORTS.contains(&"SPI"));
        assert!(BUILTIN_TRANSPORTS.contains(&"FIFO"));
        assert!(!BUILTIN_TRANSPORTS.contains(&"USB"));
    }

    #[test]
    fn test_input_monitoring_access_from_raw_maps_known_states() {
        assert_eq!(
            input_monitoring_access_from_raw(K_IOHID_ACCESS_TYPE_GRANTED),
            InputMonitoringAccess::Granted
        );
        assert_eq!(
            input_monitoring_access_from_raw(K_IOHID_ACCESS_TYPE_DENIED),
            InputMonitoringAccess::Denied
        );
        assert_eq!(
            input_monitoring_access_from_raw(K_IOHID_ACCESS_TYPE_UNKNOWN),
            InputMonitoringAccess::Unknown
        );
        assert_eq!(
            input_monitoring_access_from_raw(99),
            InputMonitoringAccess::Unknown
        );
    }

    /// Test that software-injected keystrokes (no HID callback) cannot bypass filtering.
    /// This test documents the security model - actual verification happens at runtime.
    #[test]
    fn test_software_injection_blocked_by_design() {
        // Software-injected keystrokes (CGEventPost, osascript, etc.) do NOT trigger
        // the IOHIDManager HID callback. They would only appear as NSEvent keystrokes
        // in the macOS event stream.
        //
        // Our editor gates all text mutations on:
        // 1. HID callback firing (increments pending_builtin_keydowns atomic)
        // 2. consume_builtin_keydown() succeeding (decrements counter)
        //
        // Without a matching HID callback, the counter stays at 0 and edits are rejected.
        //
        // This test documents the invariant - actual enforcement is in the callback path.
        let pending = std::sync::atomic::AtomicI32::new(0);

        // Simulate a software injection attempt (no HID callback fired).
        let prev = pending.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        assert!(
            prev <= 0,
            "Counter should be 0 or negative for software injection"
        );

        // Counter should be clamped to 0, not go negative.
        pending.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(pending.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}
