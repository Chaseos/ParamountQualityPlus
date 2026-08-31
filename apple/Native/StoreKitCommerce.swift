import AppKit
import StoreKit

@MainActor
final class StoreKitCommerce: TipCommerce {
    var purchaseWindow: (() -> NSWindow?)?
    private var loaded: [String: Product] = [:]
    var canMakePayments: Bool { AppStore.canMakePayments }

    func products(for ids: [String]) async throws -> [TipProduct] {
        let products = try await Product.products(for: ids).filter { $0.type == .consumable }
        loaded = Dictionary(uniqueKeysWithValues: products.map { ($0.id, $0) })
        return products.map { TipProduct(id: $0.id, name: $0.displayName, description: $0.description, price: $0.displayPrice) }
    }

    func purchase(_ id: String) async throws -> TipPurchaseResult {
        guard let window = purchaseWindow?(), window.isVisible else { throw PurchaseError.noWindow }
        guard let product = loaded[id] else { throw PurchaseError.noProduct }
        let result: Product.PurchaseResult
        if #available(macOS 15.2, *) { result = try await product.purchase(confirmIn: window, options: []) }
        else { result = try await product.purchase(options: []) }
        switch result {
        case .success(let verification): return .success(Self.transaction(verification))
        case .pending: return .pending
        case .userCancelled: return .cancelled
        @unknown default: throw PurchaseError.unknown
        }
    }

    func updates() -> AsyncStream<TipTransaction> {
        AsyncStream { continuation in
            let task = Task {
                for await result in StoreKit.Transaction.updates {
                    guard !Task.isCancelled else { break }
                    continuation.yield(Self.transaction(result))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
    func unfinished() -> AsyncStream<TipTransaction> {
        AsyncStream { continuation in
            let task = Task {
                for await result in StoreKit.Transaction.unfinished {
                    guard !Task.isCancelled else { break }
                    continuation.yield(Self.transaction(result))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
    private static func transaction(_ result: VerificationResult<StoreKit.Transaction>) -> TipTransaction {
        switch result {
        case .verified(let transaction):
            return TipTransaction(id: transaction.id, productID: transaction.productID, verified: transaction.productType == .consumable,
                                  finish: { await transaction.finish() })
        case .unverified(let transaction, _):
            return TipTransaction(id: transaction.id, productID: transaction.productID, verified: false, finish: {})
        }
    }
    private enum PurchaseError: LocalizedError {
        case noWindow, noProduct, unknown
        var errorDescription: String? {
            switch self {
            case .noWindow: return NSLocalizedString("Reopen Support options, then try again.", comment: "")
            case .noProduct: return NSLocalizedString("Reload the tip options, then try again.", comment: "")
            case .unknown: return NSLocalizedString("The App Store returned an unknown result. Please try again.", comment: "")
            }
        }
    }
}
