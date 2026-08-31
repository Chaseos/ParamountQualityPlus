import Foundation
import Combine

struct TipProduct: Identifiable, Equatable {
    let id: String
    let name: String
    let description: String
    let price: String
}

struct TipTransaction {
    let id: UInt64
    let productID: String
    let verified: Bool
    let finish: () async -> Void
}

enum TipPurchaseResult {
    case success(TipTransaction), pending, cancelled
}

@MainActor
protocol TipCommerce: AnyObject {
    var canMakePayments: Bool { get }
    func products(for ids: [String]) async throws -> [TipProduct]
    func purchase(_ id: String) async throws -> TipPurchaseResult
    func updates() -> AsyncStream<TipTransaction>
    func unfinished() -> AsyncStream<TipTransaction>
}

@MainActor
final class TipStore: ObservableObject {
    @Published private(set) var products: [TipProduct] = []
    @Published private(set) var isLoading = false
    @Published private(set) var purchasingID: String?
    @Published private(set) var loadMessage: String?
    @Published private(set) var purchaseMessage: String?
    @Published private(set) var deliveryMessage: String?
    @Published private(set) var hasPendingPurchase = false
    private let ids: [String]
    private let commerce: TipCommerce
    private var updatesTask: Task<Void, Never>?
    private var recoveryTask: Task<Void, Never>?
    private var completing = Set<UInt64>()
    private var completed = Set<UInt64>()
    var missingProducts: Bool { products.count != ids.count }

    init(ids: [String], commerce: TipCommerce) { self.ids = ids; self.commerce = commerce }
    deinit { updatesTask?.cancel(); recoveryTask?.cancel() }

    func start() {
        guard updatesTask == nil else { return }
        let stream = commerce.updates()
        updatesTask = Task { [weak self] in
            for await transaction in stream {
                guard !Task.isCancelled else { break }
                await self?.accept(transaction)
            }
        }
        reconcile()
    }

    func reconcile() {
        guard recoveryTask == nil else { return }
        let stream = commerce.unfinished()
        recoveryTask = Task { [weak self] in
            for await transaction in stream {
                guard !Task.isCancelled else { break }
                await self?.accept(transaction)
            }
            self?.recoveryTask = nil
        }
    }

    func loadProducts() async {
        guard !isLoading else { return }
        isLoading = true
        loadMessage = nil
        defer { isLoading = false }
        do {
            let result = try await commerce.products(for: ids)
            products = ids.compactMap { id in result.first { $0.id == id } }
            if missingProducts { loadMessage = NSLocalizedString("Some tip options are unavailable. You can retry.", comment: "") }
        } catch {
            products = []
            loadMessage = NSLocalizedString("Tips could not be loaded. Check your connection and try again.", comment: "")
        }
    }

    func purchase(_ id: String) async {
        guard purchasingID == nil, ids.contains(id), products.contains(where: { $0.id == id }) else { return }
        guard commerce.canMakePayments else {
            purchaseMessage = NSLocalizedString("Purchases are unavailable on this Mac. Check App Store restrictions.", comment: "")
            return
        }
        purchasingID = id
        purchaseMessage = nil
        defer { purchasingID = nil }
        do {
            switch try await commerce.purchase(id) {
            case .success(let transaction):
                guard transaction.productID == id, transaction.verified else {
                    purchaseMessage = NSLocalizedString("This purchase could not be verified. No tip was accepted.", comment: "")
                    return
                }
                await accept(transaction)
                purchaseMessage = NSLocalizedString("This tip completed. Thank you!", comment: "")
            case .pending:
                hasPendingPurchase = true
                purchaseMessage = NSLocalizedString("This tip is pending approval. You can continue using the app.", comment: "")
            case .cancelled:
                purchaseMessage = NSLocalizedString("Purchase cancelled.", comment: "")
            }
        } catch {
            purchaseMessage = (error as? LocalizedError)?.errorDescription
                ?? NSLocalizedString("The purchase could not be completed. Please try again.", comment: "")
        }
    }

    func accept(_ transaction: TipTransaction) async {
        guard ids.contains(transaction.productID) else { return }
        guard transaction.verified else {
            deliveryMessage = NSLocalizedString("An incoming tip could not be verified. No tip was accepted.", comment: "")
            return
        }
        guard !completed.contains(transaction.id), completing.insert(transaction.id).inserted else { return }
        await transaction.finish()
        completing.remove(transaction.id)
        completed.insert(transaction.id)
        // Delivery is independent of any purchase currently pending or in progress.
        deliveryMessage = NSLocalizedString("A verified tip transaction finished. Thank you for your support.", comment: "")
    }
}
