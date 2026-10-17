// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "ModelHitch",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "ModelHitch", targets: ["ModelHitch"]),
    ],
    targets: [
        .target(name: "ModelHitch"),
        // Uses the Testing module bundled with Xcode 16+ toolchains; no
        // external swift-testing checkout needed.
        .testTarget(
            name: "ModelHitchTests",
            dependencies: ["ModelHitch"]
        ),
    ]
)
