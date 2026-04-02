import AppKit

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate {
    var windowController: WindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        HIDCapture.shared.requestAccess()
        HIDCapture.shared.start()

        let wc = WindowController()
        self.windowController = wc
        wc.showWindow(nil)

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}
