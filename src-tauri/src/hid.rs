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
