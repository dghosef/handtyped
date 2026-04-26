#![cfg(target_os = "macos")]

use objc::runtime::Object;
use objc::*;

fn shared_application() -> *mut Object {
    unsafe { msg_send!(class!(NSApplication), sharedApplication) }
}

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

pub fn exit_lockdown_mode() {
    let nsapp: *mut Object = shared_application();
    if nsapp.is_null() {
        return;
    }

    unsafe {
        let _: () = msg_send!(nsapp, setPresentationOptions: 0);
    }
}

pub fn is_in_lockdown_mode() -> bool {
    let nsapp: *mut Object = shared_application();
    if nsapp.is_null() {
        return false;
    }

    let options: usize = unsafe { msg_send!(nsapp, presentationOptions) };
    options != 0
}

pub fn activate_ignoring_other_apps() {
    let nsapp: *mut Object = shared_application();
    if nsapp.is_null() {
        return;
    }

    unsafe {
        let _: () = msg_send!(nsapp, activateIgnoringOtherApps: true);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn enter_lockdown_mode() {}

#[cfg(not(target_os = "macos"))]
pub fn exit_lockdown_mode() {}

#[cfg(not(target_os = "macos"))]
pub fn is_in_lockdown_mode() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn activate_ignoring_other_apps() {}
