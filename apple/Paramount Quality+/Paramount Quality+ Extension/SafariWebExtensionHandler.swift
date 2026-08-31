import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        // No native messaging API is exposed. Support uses the validated app URL route.
        context.completeRequest(returningItems: [], completionHandler: nil)
    }
}
