// Live Activities on the iOS simulator, for pitbox's `push activity` and its push gateway. The simulator takes no
// Live Activity push from outside (`simctl push` has no such push type), so pitbox hands the push to this hook,
// which calls the ActivityKit API the system would act on: `Activity.request`, `update`, `end`.
//
//   if #available(iOS 16.2, *) {
//     PitboxLiveActivity.register(DeliveryAttributes.self)   // by the name pushes give in `attributes-type`
//     PitboxLiveActivity.start()
//   }
//
// It also writes the push tokens the system gives — push-to-start per type (iOS 17.2+), one per activity — where
// pitbox reads them to route a push to the simulator that has the activity. An app without the aps-environment
// entitlement gets no tokens from the system: the hook then makes up stable ones and passes them to
// `onSyntheticToken`, for the app to send to its server as it would a real one.
//
// Debug builds of iOS apps only: everywhere else every call is a no-op.

import Foundation

#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// A Live Activity push token the hook made up (the system gives none to an app without aps-environment).
public struct PitboxLiveActivityToken: Sendable {
  /// `start` (a push-to-start token of `type`) or `activity` (the token of the activity `activityId`).
  public let kind: String
  public let type: String
  public let activityId: String?
  /// 64 hex digits.
  public let token: String
}

/// True for the first `claim()` only, from any thread: `start()` is idempotent without a mutable static.
final class OnceFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false
  func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}

/// Holds `onSyntheticToken` behind a lock: a mutable static is refused by Swift 6's strict concurrency in the
/// targets that import this module, and a stored `let` of a Sendable type is not.
final class SyntheticTokenHandler: @unchecked Sendable {
  static let shared = SyntheticTokenHandler()
  private let lock = NSLock()
  private var handler: ((PitboxLiveActivityToken) -> Void)?
  func get() -> ((PitboxLiveActivityToken) -> Void)? { lock.lock(); defer { lock.unlock() }; return handler }
  func set(_ h: ((PitboxLiveActivityToken) -> Void)?) { lock.lock(); handler = h; lock.unlock() }
}

#if DEBUG && canImport(ActivityKit) && os(iOS)
import UIKit

public enum PitboxLiveActivity {
  /// Called on the main queue with each token the hook makes up.
  public static var onSyntheticToken: ((PitboxLiveActivityToken) -> Void)? {
    get { SyntheticTokenHandler.shared.get() }
    set { SyntheticTokenHandler.shared.set(newValue) }
  }

  /// Registers a type pitbox may start, update and end, by `name` (default: the type's own name, which is what a
  /// push's `attributes-type` gives).
  @available(iOS 16.2, *)
  public static func register<A: ActivityAttributes>(_ type: A.Type, name: String? = nil) {
    let n = name ?? String(describing: type)
    Task { await Worker.shared.register(TypeHandler<A>(name: n)) }
  }

  /// Starts taking pitbox's pushes: on its Darwin notification and whenever the app becomes active. Idempotent.
  public static func start() {
    guard #available(iOS 16.2, *) else { return }
    guard startOnce.claim() else { return }
    let bundle = Bundle.main.bundleIdentifier ?? "app"
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(), nil,
      { _, _, _, _, _ in Task { await Worker.shared.drain() } },
      "dev.pitbox.liveactivity.\(bundle)" as CFString, nil, .deliverImmediately
    )
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { _ in
      Task { await Worker.shared.drain() }
    }
    // Commands that waited while the app was not running; a moment later, so the types registered before are in.
    Task {
      try? await Task.sleep(nanoseconds: 300_000_000)
      await Worker.shared.drain()
    }
  }

  private static let startOnce = OnceFlag()

  static func announce(_ t: PitboxLiveActivityToken) {
    DispatchQueue.main.async { onSyntheticToken?(t) }
  }
}

/// One registered ActivityAttributes type, erased.
@available(iOS 16.2, *)
protocol AnyTypeHandler {
  var name: String { get }
  func observe(_ worker: Worker)
  func start(_ c: PitboxLiveActivityCore.Command) async throws -> PitboxLiveActivityCore.Outcome
  func update(_ c: PitboxLiveActivityCore.Command) async throws -> PitboxLiveActivityCore.Outcome
  func end(_ c: PitboxLiveActivityCore.Command) async throws -> PitboxLiveActivityCore.Outcome
  func owns(_ activityId: String) -> Bool
  /// The activities of the type ActivityKit reports now, with their state.
  func live() -> [(id: String, state: String)]
}

@available(iOS 16.2, *)
struct TypeHandler<A: ActivityAttributes>: AnyTypeHandler {
  typealias Core = PitboxLiveActivityCore
  let name: String

  func owns(_ activityId: String) -> Bool { Activity<A>.activities.contains { $0.id == activityId } }

  func live() -> [(id: String, state: String)] { Activity<A>.activities.map { (id: $0.id, state: Self.describe($0.activityState)) } }

  private func content(_ c: Core.Command) throws -> ActivityContent<A.ContentState>? {
    guard let data = c.state else { return nil }
    // The default decoder, as the system decodes `content-state`.
    let state = try JSONDecoder().decode(A.ContentState.self, from: data)
    return ActivityContent(state: state, staleDate: c.staleDate, relevanceScore: c.relevanceScore ?? 0)
  }

  private func activity(_ c: Core.Command) throws -> Activity<A> {
    guard let id = c.activityId, let a = Activity<A>.activities.first(where: { $0.id == id }) else {
      throw Core.CoreError("no running \(name) activity \(c.activityId ?? "(no id)")")
    }
    return a
  }

  func observe(_ worker: Worker) {
    let name = name
    for a in Activity<A>.activities { track(a, worker) }
    Task { for await a in Activity<A>.activityUpdates { track(a, worker) } }
    if #available(iOS 17.2, *) {
      Task {
        for await data in Activity<A>.pushToStartTokenUpdates {
          await worker.record(.init(token: Core.hex(data), kind: "start", type: name, activityId: nil, synthetic: nil))
        }
      }
      // No push-to-start token from the system in a few seconds (no aps-environment): one made up.
      Task {
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        await worker.synthesizeStartToken(type: name)
      }
    }
  }

  private func track(_ a: Activity<A>, _ worker: Worker) {
    let name = name
    Task { await worker.set(activity: a.id, type: name, state: Self.describe(a.activityState)) }
    Task { for await data in a.pushTokenUpdates { await worker.record(.init(token: Core.hex(data), kind: "activity", type: name, activityId: a.id, synthetic: nil)) } }
    Task { for await s in a.activityStateUpdates { await worker.set(activity: a.id, type: name, state: Self.describe(s)) } }
  }

  /// `active`, `ended`, `dismissed`, `stale`, `pending`: the case's own name.
  static func describe(_ s: ActivityState) -> String { String(describing: s) }

  func start(_ c: Core.Command) async throws -> Core.Outcome {
    let attributes = try JSONDecoder().decode(A.self, from: c.attributes ?? Data("{}".utf8))
    guard let content = try content(c) else { throw Core.CoreError("a start needs content-state") }
    var note: String?
    let a: Activity<A>
    do {
      a = try Activity.request(attributes: attributes, content: content, pushType: .token)
    } catch {
      // No aps-environment: the system refuses a push type. Started without one, with a made-up token.
      a = try Activity.request(attributes: attributes, content: content, pushType: nil)
      note = "the app has no aps-environment entitlement: started without a push type, the token is synthetic"
    }
    if note == nil {
      for _ in 0..<30 where a.pushToken == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
      if let t = a.pushToken { return Core.Outcome(ok: true, activityId: a.id, token: Core.hex(t)) }
    }
    let token = await Worker.shared.synthesize(kind: "activity", type: name, activityId: a.id)
    return Core.Outcome(ok: true, activityId: a.id, token: token, synthetic: true, note: note)
  }

  func update(_ c: Core.Command) async throws -> Core.Outcome {
    let a = try activity(c)
    guard let content = try content(c) else { throw Core.CoreError("an update needs content-state") }
    var alert: AlertConfiguration?
    if c.alertTitle != nil || c.alertBody != nil {
      alert = AlertConfiguration(title: LocalizedStringResource(stringLiteral: c.alertTitle ?? ""), body: LocalizedStringResource(stringLiteral: c.alertBody ?? ""), sound: .default)
    }
    await a.update(content, alertConfiguration: alert)
    return Core.Outcome(ok: true, activityId: a.id)
  }

  func end(_ c: Core.Command) async throws -> Core.Outcome {
    let a = try activity(c)
    let policy: ActivityUIDismissalPolicy
    switch Core.dismissal(c.dismissalDate) {
    case .default: policy = .default
    case .immediate: policy = .immediate
    case .after(let d): policy = .after(d)
    }
    await a.end(try content(c), dismissalPolicy: policy)
    return Core.Outcome(ok: true, activityId: a.id)
  }
}

/// Takes pitbox's commands one at a time and keeps state.json.
@available(iOS 16.2, *)
actor Worker {
  static let shared = Worker()
  typealias Core = PitboxLiveActivityCore

  private let folder = Core.Folder.standard()
  private var handlers: [String: AnyTypeHandler] = [:]
  private var state = Core.State()
  private var ordering = Core.Ordering()
  private var draining = false

  init() {
    // Tokens and activities of earlier launches stay valid: kept, then corrected by what ActivityKit reports.
    if let saved = Core.Folder.standard().load() { state = saved }
    state.types = []
  }

  func register(_ h: AnyTypeHandler) {
    guard handlers[h.name] == nil else { return }
    handlers[h.name] = h
    state.types = handlers.keys.sorted()
    state.reconcile(type: h.name, live: h.live())
    save()
    h.observe(self)
  }

  /// Drops what ActivityKit no longer reports (ghosts of earlier launches), on each drain: at launch and activation.
  private func reconcile() {
    let before = state
    for h in handlers.values { state.reconcile(type: h.name, live: h.live()) }
    if state != before { save() }
  }

  func record(_ t: Core.State.Token) {
    state.record(t)
    save()
  }

  func set(activity id: String, type: String, state s: String) {
    state.set(activity: id, type: type, state: s)
    save()
  }

  /// A made-up token, recorded and announced; the same one again for the same activity or type. A token kept from an
  /// earlier launch is announced again, as the system hands its tokens out again on every launch: an app that keeps
  /// them in memory only (and reports them on sign-in) would otherwise never see it after the first launch.
  func synthesize(kind: String, type: String, activityId: String?) -> String {
    if let t = state.tokens.first(where: { $0.kind == kind && $0.type == type && $0.activityId == activityId }) {
      if t.synthetic == true { PitboxLiveActivity.announce(PitboxLiveActivityToken(kind: kind, type: type, activityId: activityId, token: t.token)) }
      return t.token
    }
    let udid = ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "device"
    let token = Core.syntheticToken(udid, Bundle.main.bundleIdentifier ?? "", type, kind, activityId ?? "")
    state.record(.init(token: token, kind: kind, type: type, activityId: activityId, synthetic: true))
    save()
    PitboxLiveActivity.announce(PitboxLiveActivityToken(kind: kind, type: type, activityId: activityId, token: token))
    return token
  }

  func synthesizeStartToken(type: String) {
    if state.tokens.contains(where: { $0.kind == "start" && $0.type == type && $0.synthetic != true }) { return }
    _ = synthesize(kind: "start", type: type, activityId: nil)
  }

  private func save() {
    try? folder.save(state)
  }

  func drain() async {
    guard !draining else { return }
    draining = true
    defer { draining = false }
    reconcile()
    while let file = folder.pending().first {
      guard let data = folder.claim(file) else {
        // pitbox took it back, or it cannot be read: either way it is not ours to run.
        try? FileManager.default.removeItem(at: file)
        continue
      }
      guard let c = try? Core.Command.parse(data) else { continue }
      let outcome = c.expired() ? Core.Outcome(ok: false, error: "expired: pitbox no longer waited for it, so it was not applied") : await run(c)
      try? folder.answer(c.id, outcome)
    }
  }

  private func run(_ c: Core.Command) async -> Core.Outcome {
    let h = c.type.flatMap { handlers[$0] } ?? c.activityId.flatMap { id in handlers.values.first { $0.owns(id) } }
    guard let h else { return Core.Outcome(ok: false, error: "\(c.type ?? "the activity's type") is not registered with PitboxLiveActivity") }
    if c.event != "start", let id = c.activityId, !ordering.accept(activity: id, timestamp: c.timestamp) {
      return Core.Outcome(ok: false, activityId: id, error: "dropped: its timestamp is older than the last push applied to the activity, as the system drops it")
    }
    do {
      switch c.event {
      case "start": return try await h.start(c)
      case "update": return try await h.update(c)
      case "end": return try await h.end(c)
      default: return Core.Outcome(ok: false, error: "unknown event \(c.event)")
      }
    } catch {
      return Core.Outcome(ok: false, error: "\(error)")
    }
  }
}

#else

public enum PitboxLiveActivity {
  public static var onSyntheticToken: ((PitboxLiveActivityToken) -> Void)? {
    get { SyntheticTokenHandler.shared.get() }
    set { SyntheticTokenHandler.shared.set(newValue) }
  }

  #if canImport(ActivityKit) && os(iOS)
  @available(iOS 16.2, *)
  public static func register<A: ActivityAttributes>(_ type: A.Type, name: String? = nil) {}
  #endif

  public static func start() {}
}

#endif
