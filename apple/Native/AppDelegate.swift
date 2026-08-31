import AppKit
import SwiftUI

@main
enum ParamountApplication {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var sheet: NSWindow?
    private var setup: SetupModel?
    private var router: SupportRouter?
    private var store: TipStore?
    private let commerce = StoreKitCommerce()
    private var pendingURLs: [URL] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let config = try AppleConfiguration.load()
            let model = SetupModel(config: config)
            setup = model
            let store = TipStore(ids: config.products.map(\.id), commerce: commerce)
            self.store = store
            store.start()
            let router = SupportRouter(scheme: config.urlScheme)
            self.router = router
            router.presentIfReady = { [weak self] in self?.presentSupport() ?? false }
            let controller = NSHostingController(rootView: SetupView(model: model) { [weak self] in self?.requestSupport() })
            let window = NSWindow(contentViewController: controller)
            window.title = config.name
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            window.setContentSize(NSSize(width: 560, height: 640))
            window.minSize = NSSize(width: 480, height: 570)
            window.delegate = self
            window.isReleasedWhenClosed = false
            self.window = window
            installMenu(name: config.name)
            showWindow()
            model.refresh()
            pendingURLs.forEach { _ = router.handle($0) }
            pendingURLs.removeAll()
        } catch {
            let alert = NSAlert()
            alert.messageText = "App configuration is unavailable"
            alert.informativeText = "Reinstall a valid build of Paramount Quality+."
            alert.runModal()
            NSApp.terminate(nil)
        }
    }
    private func installMenu(name: String) {
        let menu = NSMenu()
        let app = NSMenuItem()
        menu.addItem(app)
        app.submenu = NSMenu()
        app.submenu?.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.submenu?.addItem(.separator())
        app.submenu?.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
    }
    private func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { [weak self] in self?.router?.flush() }
    }
    private func requestSupport() { router?.requestSupport() }
    private func presentSupport() -> Bool {
        guard let window, window.isVisible, let store else { showWindow(); return false }
        if sheet != nil { sheet?.makeKeyAndOrderFront(nil); return true }
        let content = TipSheet(store: store) { [weak self] in self?.dismissSupport() }
        let hosting = NSHostingController(rootView: content)
        // StoreKit may insert NSRemoteView into the presenting controller's root.
        let container = NSViewController()
        container.view = NSView()
        container.addChild(hosting)
        container.view.addSubview(hosting.view)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: container.view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: container.view.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: container.view.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: container.view.bottomAnchor)
        ])
        let sheet = NSWindow(contentViewController: container)
        sheet.title = NSLocalizedString("Support options", comment: "")
        hosting.view.frame.size = NSSize(width: 480, height: 460)
        hosting.view.layoutSubtreeIfNeeded()
        let fitting = hosting.view.fittingSize
        let maximumHeight = (window.screen?.visibleFrame.height ?? 800) * 0.8
        sheet.setContentSize(NSSize(width: max(480, fitting.width), height: min(maximumHeight, max(460, fitting.height))))
        sheet.styleMask = [.titled, .resizable]
        sheet.minSize = NSSize(width: 440, height: 380)
        sheet.delegate = self
        self.sheet = sheet
        commerce.purchaseWindow = { [weak sheet] in sheet }
        window.beginSheet(sheet) { [weak self] _ in
            self?.commerce.purchaseWindow = nil
            self?.sheet = nil
        }
        return true
    }
    private func dismissSupport() {
        guard store?.purchasingID == nil, let sheet else { return }
        window?.endSheet(sheet)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if store?.purchasingID != nil { return false }
        if sheet != nil { dismissSupport() }
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        store?.purchasingID == nil ? .terminateNow : .terminateCancel
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationDidBecomeActive(_ notification: Notification) { setup?.refresh(); store?.reconcile(); router?.flush() }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let router else { pendingURLs.append(contentsOf: urls); return }
        for url in urls where router.handle(url) { showWindow() }
    }
}
