import Foundation

struct AppleConfiguration: Decodable {
    struct Tip: Decodable { let id: String }
    let name: String
    let appBundleID: String
    let extensionBundleID: String
    let urlScheme: String
    let appStoreID: String
    let appStorePublished: Bool
    let supportURL: String
    let privacyURL: String
    let products: [Tip]

    static func load(bundle: Bundle = .main) throws -> AppleConfiguration {
        guard let url = bundle.url(forResource: "Configuration", withExtension: "json") else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }

    var reviewURL: URL? {
        guard !appStoreID.isEmpty, appStoreID.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return URL(string: "https://apps.apple.com/app/id\(appStoreID)?action=write-review")
    }
}

enum SupportRoute {
    static func accepts(_ url: URL, scheme: String) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.scheme?.lowercased() == scheme && components.host?.lowercased() == "support"
            && components.path.isEmpty && components.user == nil && components.password == nil
            && components.port == nil && components.query == nil && components.fragment == nil
    }
}

@MainActor
final class SupportRouter {
    private(set) var pending = false
    private let scheme: String
    var presentIfReady: (() -> Bool)?
    init(scheme: String) { self.scheme = scheme }
    @discardableResult func handle(_ url: URL) -> Bool {
        guard SupportRoute.accepts(url, scheme: scheme) else { return false }
        requestSupport()
        return true
    }
    func requestSupport() {
        pending = true
        flush()
    }
    func flush() {
        guard pending, presentIfReady?() == true else { return }
        pending = false
    }
}
