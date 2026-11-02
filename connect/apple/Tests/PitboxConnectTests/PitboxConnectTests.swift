import XCTest
@testable import PitboxConnect

final class PitboxConnectTests: XCTestCase {
  private var defaults: UserDefaults!

  override func setUp() {
    defaults = UserDefaults(suiteName: "pitbox-connect-tests-\(UUID().uuidString)")
  }

  func testSavesHostsFromAConnectLinkAndMirrorsTheDevServer() {
    let link = URL(string: "pitbox.com.example.app://connect?devserver=192.168.1.5:8082&api=api.example.test:3000")!
    XCTAssertTrue(PitboxConnect.handle(link, defaults: defaults))
    XCTAssertEqual(PitboxConnect.host("devserver", defaults: defaults), "192.168.1.5:8082")
    XCTAssertEqual(defaults.string(forKey: "RCT_jsLocation"), "192.168.1.5:8082")
    XCTAssertEqual(PitboxConnect.url("api", defaults: defaults)?.absoluteString, "http://api.example.test:3000")
    XCTAssertEqual(PitboxConnect.hosts(defaults: defaults), ["devserver": "192.168.1.5:8082", "api": "api.example.test:3000"])
  }

  func testAnEmptyValueForgetsAHost() {
    PitboxConnect.handle(URL(string: "pitbox.com.example.app://connect?devserver=localhost:8082")!, defaults: defaults)
    PitboxConnect.handle(URL(string: "pitbox.com.example.app://connect?devserver=")!, defaults: defaults)
    XCTAssertNil(PitboxConnect.host("devserver", defaults: defaults))
    XCTAssertNil(defaults.string(forKey: "RCT_jsLocation"))
  }

  func testLeavesOtherLinksToTheApp() {
    XCTAssertFalse(PitboxConnect.handle(URL(string: "myapp://item/42")!, defaults: defaults))
    XCTAssertFalse(PitboxConnect.handle(URL(string: "pitbox.com.example.app://other?devserver=x:1")!, defaults: defaults))
    XCTAssertNil(PitboxConnect.host("devserver", defaults: defaults))
  }

  func testFallsBackWhenUnset() {
    let fallback = URL(string: "https://api.example.test")!
    XCTAssertEqual(PitboxConnect.url("api", fallback: fallback, defaults: defaults), fallback)
  }
}
