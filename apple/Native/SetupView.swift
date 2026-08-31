import SwiftUI
import Combine
import SafariServices

@MainActor
final class SetupModel: ObservableObject {
    @Published var enabled: Bool?
    @Published var message: String?
    let config: AppleConfiguration
    init(config: AppleConfiguration) { self.config = config }
    func refresh() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: config.extensionBundleID) { [weak self] state, error in
            Task { @MainActor in self?.enabled = error == nil ? state?.isEnabled : nil }
        }
    }
    func openSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: config.extensionBundleID) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor [weak self] in self?.message = NSLocalizedString("Open Safari > Settings > Extensions and select Paramount Quality+.", comment: "") }
        }
    }
    func rate() {
        guard let url = config.reviewURL else {
            message = NSLocalizedString("Rating is unavailable until this app is published on the App Store.", comment: "")
            return
        }
        if !config.appStorePublished {
            message = NSLocalizedString("Rating is unavailable until this app is published on the App Store.", comment: "")
        }
        NSWorkspace.shared.open(url)
    }
}

struct SetupView: View {
    @ObservedObject var model: SetupModel
    let support: () -> Void
    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(nsImage: NSApplication.shared.applicationIconImage).resizable().scaledToFit().frame(width: 100, height: 100).accessibilityHidden(true)
                Text(model.config.name).font(.largeTitle.bold())
                Group {
                    if let enabled = model.enabled {
                        Label(enabled ? LocalizedStringKey("The Safari extension is enabled.") : LocalizedStringKey("The Safari extension is disabled."), systemImage: enabled ? "checkmark.circle.fill" : "circle")
                    } else { Text("Extension status is unavailable. Check Safari Settings.") }
                }.foregroundStyle(.secondary)
                Button("Open Safari Extension Settings", action: model.openSettings).buttonStyle(.borderedProminent).controlSize(.large)
                VStack(alignment: .leading, spacing: 12) {
                    Text("1. Enable Paramount Quality+ in Safari Settings > Extensions.")
                    Text("2. Allow the extension on paramountplus.com. This app cannot inspect your website permission settings.")
                    Text("3. Reload the Paramount+ page, start playback, then open the toolbar popup.")
                    Text("Quality availability depends on Paramount+, your subscription, region, and Safari playback support.").foregroundStyle(.secondary)
                }.fixedSize(horizontal: false, vertical: true)
                if let message = model.message { Text(message).font(.callout).foregroundStyle(.secondary) }
                SupportActionStrip(rate: model.rate, support: support)
                HStack(spacing: 20) {
                    if let url = URL(string: model.config.supportURL) { Link("Help", destination: url) }
                    if let url = URL(string: model.config.privacyURL) { Link("Privacy", destination: url) }
                }.font(.callout)
                Text("Independent tool. Not affiliated with or endorsed by Paramount.").font(.caption).foregroundStyle(.secondary)
            }.padding(30).frame(maxWidth: .infinity)
        }.frame(minWidth: 480, idealWidth: 560, minHeight: 550, idealHeight: 620)
    }
}
