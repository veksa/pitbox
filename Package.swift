// swift-tools-version:5.9
// The Swift connect library (connect/apple), at the root so the repository can be added as a package.
import PackageDescription

let package = Package(
  name: "PitboxConnect",
  platforms: [.iOS(.v15), .tvOS(.v15), .visionOS(.v1), .macOS(.v12)],
  products: [.library(name: "PitboxConnect", targets: ["PitboxConnect"])],
  targets: [
    .target(name: "PitboxConnect", path: "connect/apple/Sources/PitboxConnect"),
    .testTarget(name: "PitboxConnectTests", dependencies: ["PitboxConnect"], path: "connect/apple/Tests/PitboxConnectTests"),
  ]
)
