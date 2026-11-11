import UIKit
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  private let launchedAt = Date()

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Pushes for `pitbox push` (simctl push): shown over the app too, and a tapped one opens its `link`.
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
    return true
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    guard let link = response.notification.request.content.userInfo["link"] as? String, let url = URL(string: link) else { return }
    // A tap that started the app: the JS side listens for links only once its bundle runs.
    let wait = Date().timeIntervalSince(launchedAt) < 5 ? 2.5 : 0
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { UIApplication.shared.open(url) }
  }
}
