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
    dependencies: [
        // swift-testing is not bundled with bare toolchains (CommandLineTools),
        // so it is referenced explicitly, pinned to the release matching the
        // minimum toolchain in CI.
        .package(
            url: "https://github.com/swiftlang/swift-testing.git",
            revision: "937120cbc281cf29727fdfb8734482158508b4fc" // swift-6.3.1-RELEASE
        ),
    ],
    targets: [
        .target(name: "ModelHitch"),
        .testTarget(
            name: "ModelHitchTests",
            dependencies: [
                "ModelHitch",
                .product(name: "Testing", package: "swift-testing"),
            ]
        ),
    ]
)
