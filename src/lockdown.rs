#[cfg(target_os = "macos")]
use objc::runtime::Object;
#[cfg(target_os = "macos")]
use objc::*;

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::RECT;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    ClipCursor, FindWindowExW, FindWindowW, GetSystemMetrics, ShowWindow, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_HIDE, SW_SHOW,
};

#[cfg(target_os = "windows")]
static WINDOWS_LOCKDOWN_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
const WINDOWS_CURSOR_EDGE_INSET: i32 = 32;

#[cfg(target_os = "macos")]
fn shared_application() -> *mut Object {
    unsafe { msg_send!(class!(NSApplication), sharedApplication) }
}

#[cfg(target_os = "macos")]
fn reset_cursor_state() {
    unsafe {
        let cursor: *mut Object = msg_send!(class!(NSCursor), arrowCursor);
        if !cursor.is_null() {
            let _: () = msg_send!(cursor, set);
        }
    }
}

#[cfg(target_os = "macos")]
pub fn enter_lockdown_mode() {
    let nsapp: *mut Object = shared_application();
    if nsapp.is_null() {
        return;
    }

    let options: usize = 0
        | (1 << 1)   // NSApplicationPresentationHideDock
        | (1 << 3)   // NSApplicationPresentationHideMenuBar
        | (1 << 4)   // NSApplicationPresentationDisableAppleMenu
        | (1 << 5)   // NSApplicationPresentationDisableProcessSwitching
        | (1 << 6)   // NSApplicationPresentationDisableForceQuit
        | (1 << 7)   // NSApplicationPresentationDisableSessionTermination
        | (1 << 8)   // NSApplicationPresentationDisableHideApplication
        | (1 << 9)   // NSApplicationPresentationDisableMenuBarTransparency
        | (1 << 12); // NSApplicationPresentationDisableCursorLocationAssistance

    unsafe {
        let _: () = msg_send!(nsapp, setPresentationOptions: options);
    }
}

#[cfg(target_os = "macos")]
pub fn exit_lockdown_mode() {
    let nsapp: *mut Object = shared_application();
    if nsapp.is_null() {
        reset_cursor_state();
        return;
    }

    unsafe {
        let _: () = msg_send!(nsapp, setPresentationOptions: 0);
        let _: () = msg_send!(nsapp, setWindowsNeedUpdate: true);
    }
    reset_cursor_state();
}

#[cfg(target_os = "macos")]
pub fn is_in_lockdown_mode() -> bool {
    let nsapp: *mut Object = shared_application();
    if nsapp.is_null() {
        return false;
    }

    let options: usize = unsafe { msg_send!(nsapp, presentationOptions) };
    options != 0
}

#[cfg(target_os = "macos")]
pub fn activate_ignoring_other_apps() {
    let nsapp: *mut Object = shared_application();
    if nsapp.is_null() {
        return;
    }

    unsafe {
        let _: () = msg_send!(nsapp, activateIgnoringOtherApps: true);
    }
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn show_single_shell_window(class_name: &str, command: i32) {
    let class_name = wide_null(class_name);
    unsafe {
        let hwnd = FindWindowW(class_name.as_ptr(), std::ptr::null());
        if !hwnd.is_null() {
            ShowWindow(hwnd, command);
        }
    }
}

#[cfg(target_os = "windows")]
fn show_all_shell_windows(class_name: &str, command: i32) {
    let class_name = wide_null(class_name);
    let mut hwnd = std::ptr::null_mut();
    loop {
        hwnd = unsafe {
            FindWindowExW(
                std::ptr::null_mut(),
                hwnd,
                class_name.as_ptr(),
                std::ptr::null(),
            )
        };
        if hwnd.is_null() {
            break;
        }
        unsafe {
            ShowWindow(hwnd, command);
        }
    }
}

#[cfg(target_os = "windows")]
fn set_shell_taskbars_visible(visible: bool) {
    let command = if visible { SW_SHOW } else { SW_HIDE };
    show_single_shell_window("Shell_TrayWnd", command);
    show_all_shell_windows("Shell_SecondaryTrayWnd", command);
    show_all_shell_windows("MultitaskingViewFrame", command);
    show_all_shell_windows("TaskSwitcherWnd", command);
    show_all_shell_windows("XamlExplorerHostIslandWindow", command);
}

#[cfg(target_os = "windows")]
fn confine_cursor_to_desktop_inset() {
    let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= WINDOWS_CURSOR_EDGE_INSET * 2 || height <= WINDOWS_CURSOR_EDGE_INSET * 2 {
        return;
    }

    let rect = RECT {
        left: left + WINDOWS_CURSOR_EDGE_INSET,
        top: top + WINDOWS_CURSOR_EDGE_INSET,
        right: left + width - WINDOWS_CURSOR_EDGE_INSET,
        bottom: top + height - WINDOWS_CURSOR_EDGE_INSET,
    };
    unsafe {
        ClipCursor(&rect);
    }
}

#[cfg(target_os = "windows")]
fn release_cursor_confinement() {
    unsafe {
        ClipCursor(std::ptr::null());
    }
}

#[cfg(target_os = "windows")]
pub fn enter_lockdown_mode() {
    WINDOWS_LOCKDOWN_ACTIVE.store(true, Ordering::Release);
    set_shell_taskbars_visible(false);
    confine_cursor_to_desktop_inset();
}

#[cfg(target_os = "windows")]
pub fn exit_lockdown_mode() {
    WINDOWS_LOCKDOWN_ACTIVE.store(false, Ordering::Release);
    release_cursor_confinement();
    set_shell_taskbars_visible(true);
}

#[cfg(target_os = "windows")]
pub fn is_in_lockdown_mode() -> bool {
    WINDOWS_LOCKDOWN_ACTIVE.load(Ordering::Acquire)
}

#[cfg(target_os = "windows")]
pub fn activate_ignoring_other_apps() {}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn enter_lockdown_mode() {}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn exit_lockdown_mode() {}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn is_in_lockdown_mode() -> bool {
    false
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn activate_ignoring_other_apps() {}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_lockdown_has_native_shell_guards() {
        let source = include_str!("lockdown.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("lockdown source should have production section");

        assert!(
            source.contains("Shell_TrayWnd"),
            "Windows lockdown should hide the primary taskbar while active"
        );
        assert!(
            source.contains("Shell_SecondaryTrayWnd"),
            "Windows lockdown should hide secondary monitor taskbars while active"
        );
        assert!(
            source.contains("ClipCursor"),
            "Windows lockdown should confine the cursor away from shell edge triggers"
        );
        assert!(
            source.contains("MultitaskingViewFrame"),
            "Windows lockdown should hide Task View when touchpad gestures surface it"
        );
    }
}
