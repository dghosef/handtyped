// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "Handtyped",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Handtyped",
            path: "Sources/Typewriter",
            linkerSettings: [.linkedFramework("IOKit")]
        )
    ]
)
