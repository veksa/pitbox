import XCTest
@testable import PitboxConnect

final class PitboxLiveActivityTests: XCTestCase {
  typealias Core = PitboxLiveActivityCore

  func testReadsACommandWithItsObjectsAsJSON() throws {
    let json = #"{"id":"m1","event":"start","timestamp":1700000000,"type":"DeliveryAttributes","attributes":{"order":"42"},"state":{"status":"Packed","progress":0.2},"staleDate":1700003600,"dismissalDate":1700000100,"relevanceScore":50,"alert":{"title":"T","body":"B"}}"#
    let c = try Core.Command.parse(Data(json.utf8))
    XCTAssertEqual(c.id, "m1")
    XCTAssertEqual(c.event, "start")
    XCTAssertEqual(c.type, "DeliveryAttributes")
    XCTAssertEqual(c.timestamp, 1_700_000_000)
    XCTAssertEqual(c.staleDate, Date(timeIntervalSince1970: 1_700_003_600))
    XCTAssertEqual(c.relevanceScore, 50)
    XCTAssertEqual(c.alertTitle, "T")
    struct State: Decodable, Equatable { let status: String; let progress: Double }
    XCTAssertEqual(try JSONDecoder().decode(State.self, from: c.state!), State(status: "Packed", progress: 0.2))
    XCTAssertThrowsError(try Core.Command.parse(Data(#"{"event":"start"}"#.utf8)))
  }

  func testMapsTheDismissalDateToAPolicy() {
    let now = Date(timeIntervalSince1970: 1000)
    XCTAssertEqual(Core.dismissal(nil, now: now), .default)
    XCTAssertEqual(Core.dismissal(Date(timeIntervalSince1970: 900), now: now), .immediate)
    XCTAssertEqual(Core.dismissal(Date(timeIntervalSince1970: 1100), now: now), .after(Date(timeIntervalSince1970: 1100)))
  }

  func testDropsAPushOlderThanTheLastOneApplied() {
    var o = Core.Ordering()
    XCTAssertTrue(o.accept(activity: "a", timestamp: 10))
    XCTAssertTrue(o.accept(activity: "a", timestamp: 12))
    XCTAssertFalse(o.accept(activity: "a", timestamp: 11))
    XCTAssertTrue(o.accept(activity: "b", timestamp: 1))
    XCTAssertTrue(o.accept(activity: "a", timestamp: nil))
  }

  func testTakesCommandsInOrderAndWritesAnswersAndState() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("pitbox-la-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let f = Core.Folder(root: root)
    try FileManager.default.createDirectory(at: f.inbox, withIntermediateDirectories: true)
    for name in ["mi2b-2", "mi2a-1", "mi2c-3"] { try Data("{}".utf8).write(to: f.inbox.appendingPathComponent("\(name).json")) }
    XCTAssertEqual(f.pending().map(\.lastPathComponent), ["mi2a-1.json", "mi2b-2.json", "mi2c-3.json"])
    try f.answer("mi2a-1", Core.Outcome(ok: true, activityId: "A1", token: "ab"))
    let answer = try JSONDecoder().decode(Core.Outcome.self, from: Data(contentsOf: f.outbox.appendingPathComponent("mi2a-1.json")))
    XCTAssertEqual(answer, Core.Outcome(ok: true, activityId: "A1", token: "ab"))
    var s = Core.State(types: ["DeliveryAttributes"])
    s.record(.init(token: "s1", kind: "start", type: "DeliveryAttributes"))
    s.record(.init(token: "s2", kind: "start", type: "DeliveryAttributes"))
    s.record(.init(token: "t1", kind: "activity", type: "DeliveryAttributes", activityId: "A1"))
    s.set(activity: "A1", type: "DeliveryAttributes", state: "active")
    XCTAssertEqual(s.tokens.map(\.token), ["s2", "t1"])
    try f.save(s)
    XCTAssertEqual(f.load(), s)
    // An ended activity takes no more pushes: its token goes.
    s.set(activity: "A1", type: "DeliveryAttributes", state: "ended")
    XCTAssertEqual(s.tokens.map(\.token), ["s2"])
    XCTAssertEqual(s.activities, [.init(id: "A1", type: "DeliveryAttributes", state: "ended")])
  }

  func testDropsActivitiesActivityKitNoLongerReports() {
    var s = Core.State(types: ["DeliveryAttributes", "Other"])
    s.record(.init(token: "s1", kind: "start", type: "DeliveryAttributes"))
    s.record(.init(token: "t1", kind: "activity", type: "DeliveryAttributes", activityId: "GHOST"))
    s.record(.init(token: "t2", kind: "activity", type: "DeliveryAttributes", activityId: "A2"))
    s.record(.init(token: "t3", kind: "activity", type: "Other", activityId: "O1"))
    s.set(activity: "GHOST", type: "DeliveryAttributes", state: "active")
    s.set(activity: "A2", type: "DeliveryAttributes", state: "active")
    s.set(activity: "O1", type: "Other", state: "active")
    s.reconcile(type: "DeliveryAttributes", live: [(id: "A2", state: "stale"), (id: "A3", state: "active")])
    XCTAssertEqual(s.tokens.map(\.token), ["s1", "t2", "t3"])
    XCTAssertEqual(s.activities, [.init(id: "A2", type: "DeliveryAttributes", state: "stale"), .init(id: "O1", type: "Other", state: "active"), .init(id: "A3", type: "DeliveryAttributes", state: "active")])
  }

  func testMakesTheSameSyntheticTokenForTheSameActivity() {
    let a = Core.syntheticToken("udid", "com.example.app", "DeliveryAttributes", "activity", "A1")
    XCTAssertEqual(a.count, 64)
    XCTAssertEqual(a, Core.syntheticToken("udid", "com.example.app", "DeliveryAttributes", "activity", "A1"))
    XCTAssertNotEqual(a, Core.syntheticToken("udid", "com.example.app", "DeliveryAttributes", "activity", "A2"))
  }
}
