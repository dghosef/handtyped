use std::ffi::c_void;
use std::os::raw::{c_long, c_uint};

// ---------------------------------------------------------------------------
// Opaque IOKit types
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct OpaqueIOHIDManager(c_void);
pub type IOHIDManagerRef = *mut OpaqueIOHIDManager;

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
    pub fn IOHIDManagerCreate(
        allocator: *const c_void,
        options: IOOptionBits,
    ) -> IOHIDManagerRef;

    pub fn IOHIDManagerSetDeviceMatchingMultiple(
        manager: IOHIDManagerRef,
        multiple: core_foundation_sys::array::CFArrayRef,
    );

    pub fn IOHIDManagerRegisterInputValueCallback(
        manager: IOHIDManagerRef,
        callback: IOHIDValueCallback,
        context: *mut c_void,
    );

    pub fn IOHIDManagerScheduleWithRunLoop(
        manager: IOHIDManagerRef,
        run_loop: core_foundation_sys::runloop::CFRunLoopRef,
        run_loop_mode: core_foundation_sys::string::CFStringRef,
    );

    pub fn IOHIDManagerOpen(manager: IOHIDManagerRef, options: IOOptionBits) -> IOReturn;

    pub fn IOHIDValueGetIntegerValue(value: IOHIDValueRef) -> c_long;
    pub fn IOHIDValueGetTimeStamp(value: IOHIDValueRef) -> u64;
    pub fn IOHIDValueGetElement(value: IOHIDValueRef) -> IOHIDElementRef;
    pub fn IOHIDElementGetUsage(element: IOHIDElementRef) -> u32;
    pub fn IOHIDElementGetUsagePage(element: IOHIDElementRef) -> u32;
}

// ---------------------------------------------------------------------------
// Mach time → wall-clock nanoseconds conversion
// ---------------------------------------------------------------------------

pub struct TimebaseInfo {
    pub numer: u32,
    pub denom: u32,
}

impl TimebaseInfo {
    pub fn get() -> Self {
        let mut info = MachTimebaseInfo { numer: 0, denom: 0 };
        unsafe { mach_timebase_info(&mut info) };
        Self { numer: info.numer, denom: info.denom }
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

use core_foundation::dictionary::CFMutableDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation::base::TCFType;
use core_foundation::array::CFArray;
use core_foundation_sys::runloop::{CFRunLoopRun, CFRunLoopGetCurrent};
use std::sync::Arc;
use crate::session::{AppState, KeyEvent};

// HID usage page for keyboard/keypad
const K_HID_PAGE_KEYBOARD: u32 = 0x07;

// Device matching dictionary keys
const K_USAGE_PAGE_KEY: &str = "DeviceUsagePage";
const K_USAGE_KEY: &str = "DeviceUsage";
// Generic Desktop page = 0x01, Keyboard usage = 0x06
const K_HID_USAGE_GD_KEYBOARD: i32 = 0x06;
const K_HID_PAGE_GENERIC_DESKTOP: i32 = 0x01;

const K_OPTIONS_NONE: IOOptionBits = 0;

struct CallbackContext {
    state: Arc<AppState>,
    start_mach: u64,
    start_wall_ns: u64,
    tb: TimebaseInfo,
}

unsafe extern "C" fn hid_input_callback(
    context: *mut c_void,
    _result: IOReturn,
    _sender: *mut c_void,
    value: IOHIDValueRef,
) {
    if context.is_null() || value.is_null() { return; }

    let ctx = &*(context as *const CallbackContext);

    let element = IOHIDValueGetElement(value);
    if element.is_null() { return; }

    // Only process keyboard/keypad usage page events
    let usage_page = IOHIDElementGetUsagePage(element);
    if usage_page != K_HID_PAGE_KEYBOARD { return; }

    let usage = IOHIDElementGetUsage(element);
    if usage == 0 { return; }

    let int_val = IOHIDValueGetIntegerValue(value);
    let kind = if int_val != 0 { "down" } else { "up" };

    let mach_ts = IOHIDValueGetTimeStamp(value);
    let wall_ns = mach_to_wall_ns(mach_ts, ctx.start_mach, ctx.start_wall_ns, &ctx.tb);

    let event = KeyEvent { t: wall_ns, kind: kind.into(), key: usage, flags: 0 };

    if let Ok(mut s) = ctx.state.session.lock() {
        s.append_key(event);
    }
}

/// Spawns a dedicated thread that runs an IOHIDManager on its own CFRunLoop.
/// Returns immediately. The thread runs for the process lifetime.
pub fn start_hid_capture(state: Arc<AppState>) {
    std::thread::Builder::new()
        .name("hid-capture".into())
        .spawn(move || {
            unsafe {
                let start_mach = mach_absolute_time();
                let start_wall_ns = state.session.lock().unwrap().start_wall_ns;
                let tb = TimebaseInfo::get();

                // Build device matching dictionary: GenericDesktop / Keyboard
                let usage_page_key = CFString::new(K_USAGE_PAGE_KEY);
                let usage_key = CFString::new(K_USAGE_KEY);
                let page_val = CFNumber::from(K_HID_PAGE_GENERIC_DESKTOP);
                let usage_val = CFNumber::from(K_HID_USAGE_GD_KEYBOARD);

                let matching: CFMutableDictionary<CFString, CFNumber> =
                    CFMutableDictionary::from_CFType_pairs(&[
                        (usage_page_key.clone(), page_val.clone()),
                        (usage_key.clone(), usage_val.clone()),
                    ]);

                let matching_array = CFArray::from_CFTypes(&[matching.to_immutable()]);

                let manager = IOHIDManagerCreate(
                    core_foundation_sys::base::kCFAllocatorDefault as *const c_void,
                    K_OPTIONS_NONE,
                );
                if manager.is_null() {
                    eprintln!("[hid] IOHIDManagerCreate failed");
                    return;
                }

                IOHIDManagerSetDeviceMatchingMultiple(manager, matching_array.as_concrete_TypeRef());

                let ctx = Box::new(CallbackContext {
                    state,
                    start_mach,
                    start_wall_ns,
                    tb,
                });
                let ctx_ptr = Box::into_raw(ctx) as *mut c_void;

                IOHIDManagerRegisterInputValueCallback(manager, hid_input_callback, ctx_ptr);

                let run_loop = CFRunLoopGetCurrent();
                let mode = core_foundation_sys::runloop::kCFRunLoopDefaultMode;
                IOHIDManagerScheduleWithRunLoop(manager, run_loop, mode);

                let ret = IOHIDManagerOpen(manager, K_OPTIONS_NONE);
                if ret != 0 {
                    eprintln!("[hid] IOHIDManagerOpen failed: {}", ret);
                    // Reclaim context to avoid leak on failure
                    drop(Box::from_raw(ctx_ptr as *mut CallbackContext));
                    return;
                }

                CFRunLoopRun();
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
        let tb = TimebaseInfo { numer: 125, denom: 3 };
        let result = mach_to_wall_ns(1003, 1000, 0, &tb);
        assert_eq!(result, 125);
    }

    #[test]
    fn test_mach_to_wall_ns_no_underflow() {
        let tb = TimebaseInfo { numer: 1, denom: 1 };
        let result = mach_to_wall_ns(500, 1000, 5_000_000_000, &tb);
        assert_eq!(result, 5_000_000_000);
    }
}
