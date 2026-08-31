import SwiftUI

struct TipSheet: View {
    @ObservedObject var store: TipStore
    let done: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Support options").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Done", action: done).keyboardShortcut(.cancelAction).disabled(store.purchasingID != nil)
            }.padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Tips are optional and support continued development. They unlock no features, content, status, or other benefits.")
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if store.isLoading { ProgressView("Loading tip options…").frame(maxWidth: .infinity) }
                    ForEach(store.products) { product in
                        Button { Task { await store.purchase(product.id) } } label: {
                            HStack(alignment: .center, spacing: 14) {
                                Image(systemName: "heart.fill").foregroundStyle(Color(red: 1, green: 0.353, blue: 0.373))
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(product.name).fontWeight(.semibold)
                                    Text(product.description).font(.callout).foregroundStyle(.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                                if store.purchasingID == product.id { ProgressView().controlSize(.small) }
                                else { Text(product.price).fontWeight(.semibold).fixedSize() }
                            }.padding(14).frame(maxWidth: .infinity, minHeight: 64)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 10)).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(store.purchasingID != nil || store.isLoading)
                        .accessibilityLabel(Text(verbatim: "\(product.name), \(product.price). \(product.description)"))
                    }
                    if let message = store.loadMessage { Text(message).foregroundStyle(.secondary) }
                    if store.missingProducts && !store.isLoading {
                        Button("Try Again") { Task { await store.loadProducts() } }.disabled(store.purchasingID != nil)
                    }
                    if let message = store.purchaseMessage { Text(message).accessibilityAddTraits(.updatesFrequently) }
                    if let message = store.deliveryMessage { Text(message).font(.callout).foregroundStyle(.secondary) }
                    if store.hasPendingPurchase {
                        Text("An approval was requested. Completed transactions shown above do not confirm that every pending request has resolved.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.frame(minWidth: 420, idealWidth: 480, minHeight: 340, idealHeight: 460)
        .task { await store.loadProducts() }
    }
}
