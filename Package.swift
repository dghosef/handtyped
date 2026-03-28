// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "HumanProof",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "HumanProof",
            path: "Sources/HumanProof",
            linkerSettings: [.linkedFramework("IOKit")]
        )
    ]
)
