// swift-tools-version:5.7
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
        // Test target is owned by the test pass (Wave 2); it is added once
        // Tests/ModelHitchTests exists so `swift build` stays green today.
    ]
)
