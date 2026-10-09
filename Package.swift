// swift-tools-version:5.9
// The Swift SDK (swift/) is published from this repository's root so SwiftPM can depend on it by URL.
import PackageDescription

let package = Package(
    name: "ByoTalk",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "ByoTalk", targets: ["ByoTalk"])],
    targets: [
        .target(name: "ByoTalk", path: "swift/Sources/ByoTalk", swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]),
        .testTarget(name: "ByoTalkTests", dependencies: ["ByoTalk"], path: "swift/Tests/ByoTalkTests"),
    ]
)
