// The runner is one long test: it serves commands until the host sends `shutdown` or kills xcodebuild.

import XCTest

final class RunnerTests: XCTestCase {
  func testServe() throws {
    continueAfterFailure = true
    let env = ProcessInfo.processInfo.environment
    let port = UInt16(env["PITBOX_PORT"] ?? "") ?? 7913
    NSLog("pitbox: starting on port %d", Int(port))
    let server = try Server(port: port)
    NSLog("pitbox=ready port=%d", Int(port))
    let commands = Commands()
    server.serve { commands.handle($0) }
    NSLog("pitbox: stopped")
  }
}
