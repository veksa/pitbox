import XCTest
@testable import PitboxConnect

final class PitboxNotificationTests: XCTestCase {
  typealias Core = PitboxNotificationCore

  func testReadsAResponseCommand() throws {
    let c = try Core.Command.parse(Data(#"{"id":"r1","action":"reply","title":"New message","text":"On my way","deadline":1000}"#.utf8))
    XCTAssertEqual(c.id, "r1")
    XCTAssertEqual(c.action, "reply")
    XCTAssertEqual(c.title, "New message")
    XCTAssertEqual(c.text, "On my way")
    XCTAssertNil(c.notification)
    XCTAssertTrue(c.expired(now: Date(timeIntervalSince1970: 2000)))
    XCTAssertThrowsError(try Core.Command.parse(Data(#"{"action":"reply"}"#.utf8)))
  }

  func testReadsAClearCommand() throws {
    XCTAssertTrue(try Core.Command.parse(Data(#"{"id":"c1","clear":true}"#.utf8)).clear)
    XCTAssertFalse(try Core.Command.parse(Data(#"{"id":"r1"}"#.utf8)).clear)
    let answer = try JSONDecoder().decode(Core.Outcome.self, from: JSONEncoder().encode(Core.Outcome(ok: true, cleared: 2)))
    XCTAssertEqual(answer.cleared, 2)
  }

  func testPicksTheNotificationByIdThenTitleThenTheNewest() {
    let old = Core.Delivered(id: "a", title: "Order shipped", body: "Track it", date: Date(timeIntervalSince1970: 1))
    let new = Core.Delivered(id: "b", title: "New message", body: "From Ann", date: Date(timeIntervalSince1970: 2))
    XCTAssertEqual(Core.pick([old, new], id: nil, title: nil), new)
    XCTAssertEqual(Core.pick([old, new], id: "a", title: nil), old)
    XCTAssertNil(Core.pick([old, new], id: "zz", title: nil))
    XCTAssertEqual(Core.pick([old, new], id: nil, title: "order"), old)
    XCTAssertEqual(Core.pick([old, new], id: nil, title: "ann"), new)
    XCTAssertNil(Core.pick([old, new], id: nil, title: "nothing"))
  }

  func testResolvesTheTapADismissalAndActionsByIdentifierOrTitle() {
    let reply = Core.Action(id: "REPLY", title: "Reply", textInput: true, foreground: false)
    let read = Core.Action(id: "MARK_READ", title: "Mark as read", textInput: false, foreground: false)
    XCTAssertEqual(Core.resolve(nil, actions: [reply]), .open)
    XCTAssertEqual(Core.resolve("open", actions: [reply]), .open)
    XCTAssertEqual(Core.resolve("dismiss", actions: [reply]), .dismiss)
    XCTAssertEqual(Core.resolve("MARK_READ", actions: [reply, read]), .action(read))
    XCTAssertEqual(Core.resolve("mark as read", actions: [reply, read]), .action(read))
    XCTAssertEqual(Core.resolve("archive", actions: [reply, read]), .unknown([reply, read]))
    XCTAssertEqual(Core.describe([reply]), [#"REPLY "Reply""#])
  }

  func testReadsAPushToShowOnADevice() throws {
    let c = try Core.Command.parse(Data(#"{"id":"p1","deliver":{"aps":{"alert":{"title":"Order shipped","body":"Track it"},"category":"ORDER","badge":3,"sound":"default"},"order":42}}"#.utf8))
    let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(c.deliver)) as? [String: Any])
    XCTAssertEqual(payload["order"] as? Int, 42)
    let shown = Core.shown(payload)
    XCTAssertEqual(shown, Core.Shown(title: "Order shipped", body: "Track it", category: "ORDER", badge: 3, sound: "default"))
    XCTAssertNil(try Core.Command.parse(Data(#"{"id":"r1"}"#.utf8)).deliver)
    XCTAssertEqual(Core.shown(["aps": ["alert": "Hi"]]).body, "Hi")
    XCTAssertTrue(Core.shown(["aps": ["content-available": 1]]).silent)
    XCTAssertFalse(Core.shown(["aps": ["content-available": 1, "alert": "Hi"]]).silent)
  }
}
