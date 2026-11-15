// What PitboxLiveActivity does that needs no ActivityKit, kept apart so it is tested on any platform: the command
// pitbox writes, the answer and the state the hook writes back, the folder they live in, the dismissal policy of an
// end, the order of pushes, and the token made up for an app the system gives none.

#if DEBUG
import CryptoKit
import Foundation

enum PitboxLiveActivityCore {
  /// One push from pitbox (in/<id>.json): the Live Activity fields of an APNs payload, the activity resolved by pitbox.
  struct Command {
    let id: String
    let event: String
    let timestamp: Double?
    let type: String?
    /// The `attributes` and `content-state` objects as JSON, for the app's own Decodable types.
    let attributes: Data?
    let state: Data?
    let staleDate: Date?
    let dismissalDate: Date?
    let relevanceScore: Double?
    let alertTitle: String?
    let alertBody: String?
    let alertSound: String?
    let activityId: String?

    static func parse(_ data: Data) throws -> Command {
      guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CoreError("the command is not a JSON object") }
      guard let id = o["id"] as? String, let event = o["event"] as? String else { throw CoreError("the command has no id or event") }
      let json = { (k: String) -> Data? in (o[k] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0) } }
      let date = { (k: String) -> Date? in (o[k] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) } }
      let alert = o["alert"] as? [String: Any]
      return Command(
        id: id,
        event: event,
        timestamp: (o["timestamp"] as? NSNumber)?.doubleValue,
        type: o["type"] as? String,
        attributes: json("attributes"),
        state: json("state"),
        staleDate: date("staleDate"),
        dismissalDate: date("dismissalDate"),
        relevanceScore: (o["relevanceScore"] as? NSNumber)?.doubleValue,
        alertTitle: alert?["title"] as? String,
        alertBody: alert?["body"] as? String,
        alertSound: alert?["sound"] as? String,
        activityId: o["activityId"] as? String
      )
    }
  }

  struct CoreError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
  }

  /// The hook's answer to a command (out/<id>.json).
  struct Outcome: Codable, Equatable {
    var ok: Bool
    var activityId: String?
    var token: String?
    var synthetic: Bool?
    var error: String?
    var note: String?
  }

  /// What the hook reports (state.json): pitbox routes a push's token by it.
  struct State: Codable, Equatable {
    struct Token: Codable, Equatable {
      var token: String
      var kind: String
      var type: String
      var activityId: String?
      var synthetic: Bool?
    }

    struct Entry: Codable, Equatable {
      var id: String
      var type: String
      var state: String
    }

    var version = 1
    var types: [String] = []
    var tokens: [Token] = []
    var activities: [Entry] = []

    /// Records a token, replacing the one of the same activity (or, for push-to-start, of the same type).
    mutating func record(_ t: Token) {
      tokens.removeAll { $0.kind == t.kind && $0.type == t.type && $0.activityId == t.activityId }
      tokens.append(t)
    }

    mutating func set(activity id: String, type: String, state: String) {
      if let i = activities.firstIndex(where: { $0.id == id }) { activities[i].state = state } else { activities.append(Entry(id: id, type: type, state: state)) }
      // Ended and dismissed activities take no more pushes: their tokens go, the last few entries stay for `push activities`.
      if state == "dismissed" || state == "ended" { tokens.removeAll { $0.activityId == id } }
      let done = activities.filter { $0.state == "dismissed" }
      if done.count > 10 { activities.removeAll { a in done.prefix(done.count - 10).contains(where: { $0.id == a.id }) } }
    }

    /// Keeps of `type` only the activities ActivityKit still reports (`live`: id and state). A ghost — an activity of
    /// an earlier launch that the system dropped while the app was not running — goes with its token, which then
    /// routes nowhere (410) instead of to an activity that no longer exists.
    mutating func reconcile(type: String, live: [(id: String, state: String)]) {
      let liveIds = Set(live.map(\.id))
      let gone = Set(activities.filter { $0.type == type && !liveIds.contains($0.id) }.map(\.id))
      activities.removeAll { gone.contains($0.id) }
      tokens.removeAll { t in t.activityId.map { gone.contains($0) } ?? false }
      for l in live { set(activity: l.id, type: type, state: l.state) }
    }
  }

  /// How an end is dismissed, from its `dismissal-date` (APNs): none → the system's default, in the past → at once,
  /// in the future → at that time.
  enum Dismissal: Equatable {
    case `default`
    case immediate
    case after(Date)
  }

  static func dismissal(_ date: Date?, now: Date = Date()) -> Dismissal {
    guard let date else { return .default }
    return date <= now ? .immediate : .after(date)
  }

  /// The last timestamp applied to each activity: an older push is dropped, as the system drops it.
  struct Ordering {
    private var last: [String: Double] = [:]

    mutating func accept(activity: String, timestamp: Double?) -> Bool {
      guard let timestamp else { return true }
      if let seen = last[activity], timestamp < seen { return false }
      last[activity] = timestamp
      return true
    }
  }

  /// The hook's folder in the app's caches: in/ (commands), out/ (answers), state.json.
  struct Folder {
    let root: URL

    static func standard() -> Folder {
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      return Folder(root: caches.appendingPathComponent("pitbox/liveactivity", isDirectory: true))
    }

    var inbox: URL { root.appendingPathComponent("in", isDirectory: true) }
    var outbox: URL { root.appendingPathComponent("out", isDirectory: true) }
    var stateFile: URL { root.appendingPathComponent("state.json") }

    /// The commands waiting, oldest first: pitbox names them by the time it wrote them.
    func pending() -> [URL] {
      let files = (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? []
      return files.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func answer(_ id: String, _ outcome: Outcome) throws {
      try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
      try JSONEncoder().encode(outcome).write(to: outbox.appendingPathComponent("\(id).json"), options: .atomic)
    }

    func save(_ state: State) throws {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      try JSONEncoder().encode(state).write(to: stateFile, options: .atomic)
    }

    func load() -> State? {
      (try? Data(contentsOf: stateFile)).flatMap { try? JSONDecoder().decode(State.self, from: $0) }
    }
  }

  static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  /// A token for an app the system gives none (no aps-environment): 64 hex digits, the same for the same seed.
  static func syntheticToken(_ parts: String...) -> String {
    hex(Data(SHA256.hash(data: Data(parts.joined(separator: "|").utf8))))
  }
}
#endif
