// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "ParamountAppleCore", platforms: [.macOS(.v13)], products: [], targets: [
    .target(name: "ParamountAppleCore", path: "Core"),
    .testTarget(name: "ParamountAppleCoreTests", dependencies: ["ParamountAppleCore"], path: "Tests")
])
