// Notification actions on the iOS simulator, for pitbox's `push respond`. The simulator shows a delivered
// notification's custom actions (its UNNotificationCategory) only in the expanded notification, which a synthesized
// long press does not reliably open, and the system gives no command to answer one. This hook answers in the app
// instead: it takes the delivered notification from UNUserNotificationCenter and calls the app's delegate with the
// response the system would build — `userNotificationCenter(_:didReceive:withCompletionHandler:)` with the action's
// identifier, and the typed text for a text input action — so the app's handler (React Native's, expo-notifications',
// Firebase's or its own) runs as it would after a person chose the action.
//
//   PitboxNotifications.start()   // once, at launch (debug builds)
//
// pitbox → app   in/<id>.json in Library/Caches/pitbox/notification, then the Darwin notification
//                `dev.pitbox.notification.<bundle id>`; the hook also drains the folder whenever the app becomes active
// app → pitbox   out/<id>.json: which notification and action, whether the delegate completed, or what went wrong
//
// The response object has no public initializer; the hook makes it with UserNotifications' own class method. That
// is private API, which is why the hook exists only in debug builds of iOS apps: everywhere else every call is a
// no-op and nothing of it is compiled in.

import Foundation

#if DEBUG && os(iOS)
import UIKit
@preconcurrency import UserNotifications

public enum PitboxNotifications {
  typealias Core = PitboxNotificationCore

  /// Starts taking pitbox's responses: on its Darwin notification and whenever the app becomes active. Idempotent.
  public static func start() {
    guard startOnce.claim() else { return }
    let bundle = Bundle.main.bundleIdentifier ?? "app"
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(), nil,
      { _, _, _, _, _ in PitboxNotifications.drain() },
      "dev.pitbox.notification.\(bundle)" as CFString, nil, .deliverImmediately
    )
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in drain() }
    // Commands that waited while the app was not running; a moment later, so the app has set its delegate.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { drain() }
  }

  private static let startOnce = OnceFlag()

  static func drain() {
    DispatchQueue.main.async {
      let folder = Core.Folder.standard()
      for file in folder.pending() {
        guard let data = folder.claim(file) else { continue }
        let cmd: Core.Command
        do {
          cmd = try Core.Command.parse(data)
        } catch {
          continue
        }
        if cmd.expired() {
          try? folder.answer(cmd.id, Core.Outcome(ok: false, error: "the command came after pitbox stopped waiting"))
          continue
        }
        if let payload = cmd.deliver {
          deliver(cmd.id, payload) { outcome in try? folder.answer(cmd.id, outcome) }
        } else {
          respond(cmd) { outcome in try? folder.answer(cmd.id, outcome) }
        }
      }
    }
  }

  /// Shows a push on a physical device, where the Mac cannot send one: the payload becomes a local notification with
  /// the whole payload as its userInfo, so the app's delegate sees it as it sees a push (`willPresent` in front, then
  /// `didReceive` on a tap). A background push (`content-available` alone) goes to the app delegate's
  /// `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`.
  static func deliver(_ id: String, _ json: Data, done: @escaping @Sendable (Core.Outcome) -> Void) {
    guard let payload = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else {
      return done(Core.Outcome(ok: false, error: "the payload is not a JSON object"))
    }
    let shown = Core.shown(payload)
    if shown.silent {
      let app = UIApplication.shared
      guard let delegate = app.delegate, delegate.responds(to: #selector(UIApplicationDelegate.application(_:didReceiveRemoteNotification:fetchCompletionHandler:))) else {
        return done(Core.Outcome(ok: false, error: "the app delegate does not implement application(_:didReceiveRemoteNotification:fetchCompletionHandler:): nothing would hear a background push"))
      }
      var answered = false
      let finish = { (completed: Bool) in
        guard !answered else { return }
        answered = true
        done(Core.Outcome(ok: true, notification: id, completed: completed))
      }
      delegate.application?(app, didReceiveRemoteNotification: payload) { _ in DispatchQueue.main.async { finish(true) } }
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) { finish(false) }
      return
    }
    let content = UNMutableNotificationContent()
    content.title = shown.title
    content.subtitle = shown.subtitle
    content.body = shown.body
    content.categoryIdentifier = shown.category
    content.threadIdentifier = shown.thread
    if let badge = shown.badge { content.badge = NSNumber(value: badge) }
    if let sound = shown.sound { content.sound = sound == "default" ? .default : UNNotificationSound(named: UNNotificationSoundName(sound)) }
    content.userInfo = payload
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional || settings.authorizationStatus == .ephemeral else {
        return done(Core.Outcome(ok: false, error: "the app may not show notifications (\(settings.authorizationStatus.rawValue)): it has to ask and be allowed first, as for a real push"))
      }
      center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
        done(error.map { Core.Outcome(ok: false, error: "the notification was not added: \($0.localizedDescription)") } ?? Core.Outcome(ok: true, notification: id, title: shown.title.isEmpty ? nil : shown.title, category: shown.category.isEmpty ? nil : shown.category))
      }
    }
  }

  static func respond(_ cmd: Core.Command, done: @escaping @Sendable (Core.Outcome) -> Void) {
    UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
      UNUserNotificationCenter.current().getNotificationCategories { categories in
        DispatchQueue.main.async { respond(cmd, center: UNUserNotificationCenter.current(), delivered: delivered, categories: categories, done: done) }
      }
    }
  }

  private static func respond(_ cmd: Core.Command, center: UNUserNotificationCenter, delivered: [UNNotification], categories: Set<UNNotificationCategory>, done: @escaping @Sendable (Core.Outcome) -> Void) {
    let list = delivered.map { Core.Delivered(id: $0.request.identifier, title: $0.request.content.title, body: $0.request.content.body, date: $0.date) }
    guard let picked = Core.pick(list, id: cmd.notification, title: cmd.title), let n = delivered.first(where: { $0.request.identifier == picked.id }) else {
      let what = cmd.notification.map { "no delivered notification \($0)" } ?? cmd.title.map { "no delivered notification shows \"\($0)\"" } ?? "no delivered notification"
      return done(Core.Outcome(ok: false, error: "\(what) (\(delivered.count) delivered)"))
    }
    let categoryId = n.request.content.categoryIdentifier
    let category = categories.first { $0.identifier == categoryId }
    let actions = (category?.actions ?? []).map { Core.Action(id: $0.identifier, title: $0.title, textInput: $0 is UNTextInputNotificationAction, foreground: $0.options.contains(.foreground)) }
    var outcome = Core.Outcome(ok: false, notification: n.request.identifier, title: n.request.content.title, category: categoryId.isEmpty ? nil : categoryId, actions: Core.describe(actions))
    let actionId: String
    var text: String?
    switch Core.resolve(cmd.action, actions: actions) {
    case .open:
      actionId = Core.defaultAction
      outcome.foreground = true
    case .dismiss:
      actionId = Core.dismissAction
      // The system reports a dismissal only to a category that asks for it.
      if category?.options.contains(.customDismissAction) != true {
        outcome.error = "the category \(categoryId.isEmpty ? "(none)" : categoryId) has no customDismissAction option: the system would not tell the app about a dismissal"
        return done(outcome)
      }
    case .action(let a):
      actionId = a.id
      outcome.foreground = a.foreground
      if a.textInput { text = cmd.text ?? "" }
    case .unknown:
      outcome.error = categoryId.isEmpty
        ? "the notification has no category, so no actions (aps.category / content.categoryIdentifier)"
        : category == nil
          ? "the app has not registered the category \(categoryId) (setNotificationCategories): the notification shows no actions"
          : "the category \(categoryId) has no action \"\(cmd.action ?? "")\""
      return done(outcome)
    }
    outcome.action = actionId
    guard let response = makeResponse(n, actionId: actionId, text: text) else {
      outcome.error = "this iOS has no way known to pitbox to make a notification response"
      return done(outcome)
    }
    guard let delegate = center.delegate else {
      outcome.error = "the app has set no UNUserNotificationCenter delegate: nothing in it would hear the response"
      return done(outcome)
    }
    guard delegate.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) else {
      outcome.error = "the app's notification delegate (\(type(of: delegate))) does not implement userNotificationCenter(_:didReceive:withCompletionHandler:)"
      return done(outcome)
    }
    // The system takes an answered notification off the screen.
    if actionId != Core.dismissAction { center.removeDeliveredNotifications(withIdentifiers: [n.request.identifier]) }
    var answered = false
    let finish = { (completed: Bool) in
      guard !answered else { return }
      answered = true
      outcome.ok = true
      outcome.completed = completed
      done(outcome)
    }
    delegate.userNotificationCenter?(center, didReceive: response) { DispatchQueue.main.async { finish(true) } }
    // A handler that never completes (some forget to) still had the response: answered after a few seconds.
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { finish(false) }
  }

  /// The response the system would hand the delegate, made with UserNotifications' own class methods.
  private static func makeResponse(_ n: UNNotification, actionId: String, text: String?) -> UNNotificationResponse? {
    typealias Make2 = @convention(c) (AnyClass, Selector, UNNotification, NSString) -> Unmanaged<AnyObject>?
    typealias Make3 = @convention(c) (AnyClass, Selector, UNNotification, NSString, NSString) -> Unmanaged<AnyObject>?
    if let text {
      let sel = NSSelectorFromString("responseWithNotification:actionIdentifier:userText:")
      guard let cls = NSClassFromString("UNTextInputNotificationResponse"), let m = class_getClassMethod(cls, sel) else { return nil }
      let make = unsafeBitCast(method_getImplementation(m), to: Make3.self)
      return make(cls, sel, n, actionId as NSString, text as NSString)?.takeUnretainedValue() as? UNNotificationResponse
    }
    let sel = NSSelectorFromString("responseWithNotification:actionIdentifier:")
    guard let cls = NSClassFromString("UNNotificationResponse"), let m = class_getClassMethod(cls, sel) else { return nil }
    let make = unsafeBitCast(method_getImplementation(m), to: Make2.self)
    return make(cls, sel, n, actionId as NSString)?.takeUnretainedValue() as? UNNotificationResponse
  }
}
#else
public enum PitboxNotifications {
  /// A no-op outside debug builds of iOS apps.
  public static func start() {}
}
#endif
