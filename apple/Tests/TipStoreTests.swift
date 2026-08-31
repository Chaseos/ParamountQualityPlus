import XCTest
@testable import ParamountAppleCore

@MainActor
private final class FakeCommerce: TipCommerce {
    var canMakePayments = true
    var returned: [TipProduct] = []
    var loadError = false
    var purchaseError = false
    var result: TipPurchaseResult = .cancelled
    var purchaseCount = 0
    var purchaseGate: CheckedContinuation<Void, Never>?
    var holdPurchase = false
    var updateContinuation: AsyncStream<TipTransaction>.Continuation?
    var recoveryContinuation: AsyncStream<TipTransaction>.Continuation?
    var recoveryCount = 0
    var updateCount = 0
    func products(for ids: [String]) async throws -> [TipProduct] {
        if loadError { throw CocoaError(.fileReadUnknown) }
        return returned
    }
    func purchase(_ id: String) async throws -> TipPurchaseResult {
        purchaseCount += 1
        if purchaseError { throw CocoaError(.fileReadUnknown) }
        if holdPurchase { await withCheckedContinuation { purchaseGate = $0 } }
        return result
    }
    func updates() -> AsyncStream<TipTransaction> { updateCount += 1; return AsyncStream { updateContinuation = $0 } }
    func unfinished() -> AsyncStream<TipTransaction> { recoveryCount += 1; return AsyncStream { recoveryContinuation = $0 } }
}

final class TipStoreTests: XCTestCase {
    @MainActor func testMissingAndFailedLoadsCanRetry() async {
        let commerce = FakeCommerce()
        let subject = TipStore(ids: ["small", "large"], commerce: commerce)
        await subject.loadProducts()
        XCTAssertTrue(subject.missingProducts)
        commerce.loadError = true
        await subject.loadProducts()
        XCTAssertFalse(subject.isLoading)
        commerce.loadError = false
        commerce.returned = [product("small")]
        await subject.loadProducts()
        XCTAssertEqual(subject.products.count, 1)
        XCTAssertTrue(subject.missingProducts)
        commerce.returned.append(product("large"))
        await subject.loadProducts()
        XCTAssertFalse(subject.missingProducts)
        XCTAssertNil(subject.loadMessage)
    }
    @MainActor func testVerifiedTipsFinishOnceAndOtherResultsDoNotFinish() async {
        let s = TipStore(ids: ["small"], commerce: FakeCommerce())
        var finished = 0
        let t = TipTransaction(id: 1, productID: "small", verified: true, finish: { finished += 1; await Task.yield() })
        async let one: Void = s.accept(t)
        async let two: Void = s.accept(t)
        _ = await (one, two)
        await s.accept(TipTransaction(id: 2, productID: "other", verified: true, finish: { finished += 1 }))
        await s.accept(TipTransaction(id: 3, productID: "small", verified: false, finish: { finished += 1 }))
        XCTAssertEqual(finished, 1)
        await s.accept(TipTransaction(id: 4, productID: "small", verified: true, finish: { finished += 1 }))
        XCTAssertEqual(finished, 2)
    }
    @MainActor func testStoreGuardsConcurrentPurchasesAndRecoversAfterCancel() async {
        let c = FakeCommerce(); c.returned = [product("small")]; c.holdPurchase = true
        let s = TipStore(ids: ["small"], commerce: c)
        await s.loadProducts()
        let task = Task { await s.purchase("small") }
        while c.purchaseGate == nil { await Task.yield() }
        await s.purchase("small")
        XCTAssertEqual(c.purchaseCount, 1)
        c.purchaseGate?.resume(); await task.value
        XCTAssertNil(s.purchasingID)
        c.holdPurchase = false
        await s.purchase("small")
        XCTAssertEqual(c.purchaseCount, 2)
    }
    @MainActor func testPendingAndIncomingDeliveryRemainSeparate() async {
        let c = FakeCommerce(); c.returned = [product("small")]; c.result = .pending
        let s = TipStore(ids: ["small"], commerce: c)
        await s.loadProducts(); await s.purchase("small")
        let pendingMessage = s.purchaseMessage
        await s.accept(TipTransaction(id: 8, productID: "small", verified: true, finish: {}))
        XCTAssertEqual(s.purchaseMessage, pendingMessage)
        XCTAssertTrue(s.hasPendingPurchase)
        XCTAssertNotNil(s.deliveryMessage)
        XCTAssertNil(s.purchasingID)
    }
    @MainActor func testListenerStartsOnceAndRecoveryDoesNotOverlap() async {
        let c = FakeCommerce()
        let store = TipStore(ids: ["small"], commerce: c)
        store.start(); store.start(); store.reconcile()
        XCTAssertEqual(c.updateCount, 1); XCTAssertEqual(c.recoveryCount, 1)
        var finished = false
        c.updateContinuation?.yield(TipTransaction(id: 10, productID: "small", verified: true, finish: { finished = true }))
        for _ in 0..<100 where !finished { await Task.yield() }
        XCTAssertTrue(finished)
        c.recoveryContinuation?.finish()
        for _ in 0..<20 { await Task.yield() }
        store.reconcile()
        XCTAssertEqual(c.recoveryCount, 2)
    }
    @MainActor func testUnavailableAndUnverifiedPurchasesRestoreControls() async {
        let c = FakeCommerce(); c.returned = [product("small")]; c.canMakePayments = false
        let s = TipStore(ids: ["small"], commerce: c)
        await s.loadProducts(); await s.purchase("small")
        XCTAssertEqual(c.purchaseCount, 0)
        c.canMakePayments = true
        c.result = .success(TipTransaction(id: 1, productID: "small", verified: false, finish: { XCTFail("Must not finish") }))
        await s.purchase("small")
        XCTAssertNil(s.purchasingID); XCTAssertNotNil(s.purchaseMessage)
    }
    @MainActor func testPurchaseErrorRestoresControlsAndRepeatedTipsFinish() async {
        let c = FakeCommerce(); c.returned = [product("small")]; c.purchaseError = true
        let s = TipStore(ids: ["small"], commerce: c)
        await s.loadProducts(); await s.purchase("small")
        XCTAssertNil(s.purchasingID); XCTAssertNotNil(s.purchaseMessage)
        c.purchaseError = false
        var finished = 0
        for id in 1...2 {
            c.result = .success(TipTransaction(id: UInt64(id), productID: "small", verified: true, finish: { finished += 1 }))
            await s.purchase("small")
            XCTAssertNil(s.purchasingID)
        }
        XCTAssertEqual(finished, 2)
        XCTAssertEqual(c.purchaseCount, 3)
    }
    @MainActor private func product(_ id: String) -> TipProduct { TipProduct(id: id, name: id, description: "Optional tip", price: "$0.99") }
}

final class RoutingTests: XCTestCase {
    func testStrictRoute() {
        XCTAssertTrue(SupportRoute.accepts(URL(string: "paramountqualityplus://support")!, scheme: "paramountqualityplus"))
        for url in ["other://support", "paramountqualityplus://support/", "paramountqualityplus://support/buy", "paramountqualityplus://support?buy=small", "paramountqualityplus://support#buy", "paramountqualityplus://user@support", "paramountqualityplus://support:80"] {
            XCTAssertFalse(SupportRoute.accepts(URL(string: url)!, scheme: "paramountqualityplus"), url)
        }
    }
    @MainActor func testColdRequestsCoalesceUntilReady() {
        let r = SupportRouter(scheme: "paramountqualityplus")
        var ready = false, presentations = 0
        r.presentIfReady = { if ready { presentations += 1 }; return ready }
        let url = URL(string: "paramountqualityplus://support")!
        r.handle(url); r.handle(url)
        XCTAssertTrue(r.pending); XCTAssertEqual(presentations, 0)
        ready = true; r.flush(); r.flush()
        XCTAssertFalse(r.pending); XCTAssertEqual(presentations, 1)
    }
}
