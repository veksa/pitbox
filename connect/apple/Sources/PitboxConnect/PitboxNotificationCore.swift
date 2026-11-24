// What PitboxNotifications does that needs no UserNotifications, kept apart so it is tested on any platform: the
// command pitbox writes, the answer, the folder they live in, which delivered notification a command means and which
// of its category's actions.

#if DEBUG
import Foundation

enum PitboxNotificationCore {
  /// The identifiers the system gives the two responses that are no action of the app's.
  static let defaultAction = "com.apple.UNNotificationDefaultActionIdentifier"
  static let dismissAction = "com.apple.UNNotificationDismissActionIdentifier"

  /// One response from pitbox (in/<id>.json).
  struct Command {
    let id: String
    /// The action's identifier or title; nil, `open` or `default`: the notification's own tap; `dismiss`: a swipe away.
    let action: String?
    /// The request identifier of the notification; nil: by `title`, else the newest.
    let notification: String?
    /// Text the title or body holds.
    let title: String?
    /// What a text input action sends.
    let text: String?
    /// Past it, pitbox no longer waits: the command is answered and not applied.
    let deadline: Date?
    /// An APNs payload to show as a notification (a physical device, which takes no push from the Mac), as JSON;
    /// nil: a response to a delivered notification.
    var deliver: Data? = nil
    /// Removes every delivered notification of the app (`push clear`): the system gives no command for it.
    var clear = false

    static func parse(_ data: Data) throws -> Command {
      guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CoreError("the command is not a JSON object") }
      guard let id = o["id"] as? String else { throw CoreError("the command has no id") }
      return Command(
        id: id,
        action: o["action"] as? String,
        notification: o["notification"] as? String,
        title: o["title"] as? String,
        text: o["text"] as? String,
        deadline: (o["deadline"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) },
        deliver: try (o["deliver"] as? [String: Any]).map { try JSONSerialization.data(withJSONObject: $0) },
        clear: o["clear"] as? Bool ?? false
      )
    }

    func expired(now: Date = Date()) -> Bool { deadline.map { $0 < now } ?? false }
  }

  struct CoreError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
  }

  /// The answer (out/<id>.json).
  struct Outcome: Codable, Equatable {
    var ok: Bool
    var notification: String?
    var title: String?
    var category: String?
    var action: String?
    /// The action asks the system to bring the app to the front (`UNNotificationActionOptions.foreground`).
    var foreground: Bool?
    /// The delegate called its completion handler.
    var completed: Bool?
    /// The actions the notification's category offers, `identifier "title"` each.
    var actions: [String]?
    var error: String?
    /// How many delivered notifications a `clear` removed.
    var cleared: Int?
  }

  /// A delivered notification as far as picking one goes.
  struct Delivered: Equatable {
    let id: String
    let title: String
    let body: String
    let date: Date
  }

  /// The notification a command means: by identifier, else the newest whose title or body holds `title`, else the newest.
  static func pick(_ delivered: [Delivered], id: String?, title: String?) -> Delivered? {
    let newest = delivered.sorted { $0.date > $1.date }
    if let id, !id.isEmpty { return newest.first { $0.id == id } }
    if let title, !title.isEmpty {
      let t = title.lowercased()
      return newest.first { $0.title.lowercased() == t } ?? newest.first { $0.title.lowercased().contains(t) || $0.body.lowercased().contains(t) }
    }
    return newest.first
  }

  /// An action of a category as far as resolving one goes.
  struct Action: Equatable {
    let id: String
    let title: String
    let textInput: Bool
    let foreground: Bool
  }

  enum Resolution: Equatable {
    case open
    case dismiss
    case action(Action)
    /// No such action; the category's actions, for the error.
    case unknown([Action])
  }

  /// Which response `want` names: the tap, a dismissal, or an action by identifier, else by title (case aside).
  static func resolve(_ want: String?, actions: [Action]) -> Resolution {
    guard let want, !want.isEmpty else { return .open }
    switch want.lowercased() {
    case "open", "default", defaultAction.lowercased(): return .open
    case "dismiss", dismissAction.lowercased(): return .dismiss
    default: break
    }
    if let a = actions.first(where: { $0.id == want }) ?? actions.first(where: { $0.title.lowercased() == want.lowercased() }) { return .action(a) }
    return .unknown(actions)
  }

  static func describe(_ actions: [Action]) -> [String] { actions.map { "\($0.id) \"\($0.title)\"" } }

  /// What a notification shows of an APNs payload's `aps`, as the system reads it.
  struct Shown: Equatable {
    var title = ""
    var subtitle = ""
    var body = ""
    var category = ""
    var thread = ""
    var badge: Int?
    var sound: String?
    /// `content-available` and nothing to show: the app is woken, no banner.
    var silent = false
  }

  static func shown(_ payload: [String: Any]) -> Shown {
    let aps = payload["aps"] as? [String: Any] ?? [:]
    var s = Shown()
    if let alert = aps["alert"] as? String {
      s.body = alert
    } else if let alert = aps["alert"] as? [String: Any] {
      s.title = alert["title"] as? String ?? ""
      s.subtitle = alert["subtitle"] as? String ?? ""
      s.body = alert["body"] as? String ?? ""
    }
    s.category = aps["category"] as? String ?? ""
    s.thread = aps["thread-id"] as? String ?? ""
    s.badge = (aps["badge"] as? NSNumber)?.intValue
    s.sound = aps["sound"] as? String ?? ((aps["sound"] as? [String: Any])?["name"] as? String)
    let available = (aps["content-available"] as? NSNumber)?.intValue == 1
    s.silent = available && s.title.isEmpty && s.subtitle.isEmpty && s.body.isEmpty
    return s
  }

  /// The folder in the app's caches: in/ (commands), out/ (answers).
  struct Folder {
    let root: URL

    static func standard() -> Folder {
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      return Folder(root: caches.appendingPathComponent("pitbox/notification", isDirectory: true))
    }

    var inbox: URL { root.appendingPathComponent("in", isDirectory: true) }
    var outbox: URL { root.appendingPathComponent("out", isDirectory: true) }

    /// The commands waiting, oldest first: pitbox names them by the time it wrote them.
    func pending() -> [URL] {
      let files = (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? []
      return files.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Takes a command file by deleting it, as pitbox takes it back when it gives up: only one of the deletes succeeds.
    func claim(_ file: URL) -> Data? {
      guard let data = try? Data(contentsOf: file), (try? FileManager.default.removeItem(at: file)) != nil else { return nil }
      return data
    }

    func answer(_ id: String, _ outcome: Outcome) throws {
      try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
      try JSONEncoder().encode(outcome).write(to: outbox.appendingPathComponent("\(id).json"), options: .atomic)
    }
  }
}
#endif
