import SwiftUI

struct SupportActionStrip: View {
    @Environment(\.colorScheme) private var colorScheme
    let rate: () -> Void
    let support: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            SupportActionButton(title: "Rate this app", symbol: "star.fill", color: colorScheme == .dark ? Color(red: 1, green: 0.784, blue: 0.341) : Color(red: 0.48, green: 0.30, blue: 0.02), action: rate)
            SupportActionButton(title: "Support options", symbol: "heart.fill", color: colorScheme == .dark ? Color(red: 1, green: 0.353, blue: 0.373) : Color(red: 0.72, green: 0.12, blue: 0.18), action: support)
        }.padding(6).background(.ultraThinMaterial, in: Capsule())
    }
}

private struct SupportActionButton: View {
    let title: LocalizedStringKey
    let symbol: String
    let color: Color
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false
    @FocusState private var focused: Bool
    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: symbol).font(.system(size: 22)).frame(width: 24, height: 24)
                if hovered || focused { Text(title).font(.callout).fixedSize(horizontal: false, vertical: true) }
            }.padding(.horizontal, 10).frame(minHeight: 40).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(color).opacity(hovered || focused ? 1 : 0.8)
        .background(color.opacity(hovered || focused ? 0.12 : 0), in: Capsule())
        .overlay(Capsule().stroke(focused ? Color.accentColor : .clear, lineWidth: 2))
        .focused($focused).onHover { hovered = $0 }.accessibilityLabel(title).help(title)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: hovered || focused)
    }
}
