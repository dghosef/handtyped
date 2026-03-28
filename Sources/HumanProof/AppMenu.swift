import AppKit
import WebKit

// Retainable closure target for NSMenuItem actions.
private final class MenuTarget: NSObject {
    private let handler: () -> Void
    init(_ handler: @escaping () -> Void) { self.handler = handler }
    @objc func fire(_ sender: Any?) { handler() }
}

@MainActor
final class AppMenu {
    private var targets: [MenuTarget] = []
    private weak var webView: WKWebView?

    func setup(webView: WKWebView) {
        self.webView = webView
        let main = NSMenu()
        main.addItem(sub("HumanProof", buildApp()))
        main.addItem(sub("File",       buildFile()))
        main.addItem(sub("Edit",       buildEdit()))
        main.addItem(sub("Format",     buildFormat()))
        main.addItem(sub("View",       buildView()))
        NSApp.mainMenu = main
    }

    // MARK: – Menus

    private func buildApp() -> NSMenu {
        let m = NSMenu()
        m.addItem(.init(title: "About HumanProof",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: ""))
        m.addItem(.separator())
        m.addItem(.init(title: "Quit HumanProof",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q"))
        return m
    }

    private func buildFile() -> NSMenu {
        let m = NSMenu(title: "File")
        m.addItem(js("New Document",    "window.__menuCmd('new')",    key: "n"))
        m.addItem(.separator())
        m.addItem(js("Save Session",    "window.__menuCmd('save')",   key: "s"))
        m.addItem(js("Export Bundle…",  "window.__menuCmd('export')", key: "E", mods: [.command, .shift]))
        m.addItem(.separator())
        m.addItem(js("Print…",          "window.__menuCmd('print')",  key: "p"))
        return m
    }

    private func buildEdit() -> NSMenu {
        let m = NSMenu(title: "Edit")
        m.addItem(js("Undo", "window.__menuCmd('undo')", key: "z"))
        m.addItem(js("Redo", "window.__menuCmd('redo')", key: "Z", mods: [.command, .shift]))
        m.addItem(.separator())
        // Cut is disabled — clipboard extraction would break attestation.
        m.addItem(off("Cut",   key: "x"))
        m.addItem(responder("Copy",  #selector(NSText.copy(_:)),  key: "c"))
        m.addItem(off("Paste", key: "v"))
        m.addItem(.separator())
        m.addItem(js("Select All",    "window.__menuCmd('selectAll')", key: "a"))
        m.addItem(.separator())
        m.addItem(js("Find…",         "window.__menuCmd('find')",      key: "f"))
        m.addItem(js("Find Next",     "window.__menuCmd('find-next')", key: "g"))
        m.addItem(js("Find Previous", "window.__menuCmd('find-prev')", key: "G", mods: [.command, .shift]))
        return m
    }

    private func buildFormat() -> NSMenu {
        let m = NSMenu(title: "Format")
        m.addItem(js("Bold",          "window.__menuCmd('bold')",        key: "b"))
        m.addItem(js("Italic",        "window.__menuCmd('italic')",      key: "i"))
        m.addItem(js("Underline",     "window.__menuCmd('underline')",   key: "u"))
        m.addItem(js("Strikethrough", "window.__menuCmd('strike')"))
        m.addItem(.separator())
        m.addItem(js("Subscript",     "window.__menuCmd('subscript')",   key: ",", mods: [.command, .shift]))
        m.addItem(js("Superscript",   "window.__menuCmd('superscript')", key: ".", mods: [.command, .shift]))
        m.addItem(.separator())
        m.addItem(js("Increase Font Size", "window.__menuCmd('font-bigger')",  key: "+", mods: [.command, .shift]))
        m.addItem(js("Decrease Font Size", "window.__menuCmd('font-smaller')", key: "-"))
        m.addItem(.separator())

        let align = NSMenu(title: "Alignment")
        align.addItem(js("Align Left",    "window.__menuCmd('align-left')",    key: "l"))
        align.addItem(js("Center",        "window.__menuCmd('align-center')",  key: "e"))
        align.addItem(js("Align Right",   "window.__menuCmd('align-right')",   key: "r"))
        align.addItem(js("Justify",       "window.__menuCmd('align-justify')", key: "j"))
        m.addItem(sub("Alignment", align))

        m.addItem(.separator())

        let lists = NSMenu(title: "Lists")
        lists.addItem(js("Bullet List",     "window.__menuCmd('bullet-list')"))
        lists.addItem(js("Numbered List",   "window.__menuCmd('ordered-list')"))
        lists.addItem(.separator())
        lists.addItem(js("Increase Indent", "window.__menuCmd('indent')"))
        lists.addItem(js("Decrease Indent", "window.__menuCmd('outdent')"))
        m.addItem(sub("Lists", lists))

        m.addItem(.separator())
        m.addItem(js("Blockquote",        "window.__menuCmd('blockquote')"))
        m.addItem(js("Horizontal Rule",   "window.__menuCmd('hr')"))
        m.addItem(.separator())
        m.addItem(js("Clear Formatting",  "window.__menuCmd('clear-format')", key: "\\"))
        return m
    }

    private func buildView() -> NSMenu {
        let m = NSMenu(title: "View")
        m.addItem(js("Toggle Dark Mode", "window.__menuCmd('dark-mode')"))
        m.addItem(.separator())
        m.addItem(action("Zoom In",    key: "=") { [weak self] in self?.zoom(+0.1) })
        m.addItem(action("Zoom Out",   key: "-") { [weak self] in self?.zoom(-0.1) })
        m.addItem(action("Reset Zoom", key: "0") { [weak self] in
            self?.webView?.setMagnification(1.0, centeredAt: .zero)
        })
        return m
    }

    // MARK: – Helpers

    private func zoom(_ delta: CGFloat) {
        guard let wv = webView else { return }
        let next = max(0.25, min(4.0, wv.magnification + delta))
        wv.setMagnification(next, centeredAt: CGPoint(x: wv.bounds.midX, y: wv.bounds.midY))
    }

    // Menu item that fires a JS snippet via evaluateJavaScript
    private func js(_ title: String, _ script: String,
                    key: String = "", mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        action(title, key: key, mods: mods) { [weak self] in
            self?.webView?.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    // Menu item with a closure action
    @discardableResult
    private func action(_ title: String, key: String = "",
                        mods: NSEvent.ModifierFlags = .command,
                        handler: @escaping () -> Void) -> NSMenuItem {
        let t = MenuTarget(handler)
        targets.append(t)
        let item = NSMenuItem(title: title,
                              action: #selector(MenuTarget.fire(_:)),
                              keyEquivalent: key)
        item.keyEquivalentModifierMask = key.isEmpty ? [] : mods
        item.target = t
        return item
    }

    // Menu item that sends action through the responder chain (standard AppKit behaviour)
    private func responder(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        item.keyEquivalentModifierMask = key.isEmpty ? [] : .command
        return item
    }

    // Disabled / greyed-out item (shown but non-interactive)
    private func off(_ title: String, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: key)
        item.keyEquivalentModifierMask = key.isEmpty ? [] : .command
        item.isEnabled = false
        return item
    }

    // Submenu container item
    private func sub(_ title: String, _ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem()
        item.title = title
        item.submenu = menu
        return item
    }
}
