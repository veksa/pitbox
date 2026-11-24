// The example app for pitbox's Apple side: one screen with what a UI test needs — a field, buttons, a long
// list, a request to the stand, a crash — and a deep link target. Ids match the Android example's.

import SwiftUI
#if os(iOS)
import AVFoundation
#endif
#if os(visionOS)
import GameController
import RealityKit
#endif

#if os(iOS)
import PitboxConnect
import UserNotifications
#endif

@main
struct ExampleApp: App {
  @State private var detail: String?

  init() {
    // Kept in UserDefaults: `clear-app` and `state restore` are seen in it on the next launch.
    UserDefaults.standard.set(UserDefaults.standard.integer(forKey: "launches") + 1, forKey: "launches")
    #if os(iOS)
    // The delivery Live Activity, for `push activity` and the push gateway: started, updated and ended by pitbox.
    if #available(iOS 16.2, *) {
      PitboxLiveActivity.register(DeliveryAttributes.self)
      PitboxLiveActivity.start()
    }
    // A message notification with a reply and a mark-as-read action, answered by `push respond`.
    NotificationResponses.shared.install()
    PitboxNotifications.start()
    #endif
  }

  var body: some SwiftUI.Scene {
    WindowGroup {
      Group {
        if let detail {
          DetailView(id: detail) { self.detail = nil }
        } else {
          #if os(iOS)
          // A navigation stack, so `key back` has a screen to go back from.
          NavigationStack { MainView() }
          #else
          MainView()
          #endif
        }
      }
      // pitboxexample://detail/<id> — the deep link target for `goto`.
      .onOpenURL { url in
        if url.host == "detail" { detail = url.lastPathComponent }
      }
    }
    #if os(visionOS)
    // A second window and a space around the user: what a headset app has beyond its main window.
    WindowGroup(id: "second") {
      Text("Second window").font(.largeTitle).accessibilityIdentifier("second_window").padding(40)
    }
    .defaultSize(width: 500, height: 300)
    ImmersiveSpace(id: "space") {
      RealityView { content in
        // A box in front of the user, named for accessibility as any 3D content should be.
        let box = ModelEntity(mesh: .generateBox(size: 0.3), materials: [SimpleMaterial(color: .orange, isMetallic: false)])
        box.position = [0, 1.4, -1.5]
        var ax = AccessibilityComponent()
        ax.isAccessibilityElement = true
        ax.label = "space box"
        box.components.set(ax)
        content.add(box)
      }
    }
    #endif
  }
}

#if os(iOS)
/// The app's notification delegate: shows banners in front and keeps the last response it got.
final class NotificationResponses: NSObject, UNUserNotificationCenterDelegate, ObservableObject {
  static let shared = NotificationResponses()
  @Published var last = ""

  func install() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let reply = UNTextInputNotificationAction(identifier: "REPLY", title: "Reply", options: [], textInputButtonTitle: "Send", textInputPlaceholder: "Message")
    let read = UNNotificationAction(identifier: "READ", title: "Mark as read", options: [])
    center.setNotificationCategories([UNNotificationCategory(identifier: "MESSAGE", actions: [reply, read], intentIdentifiers: [], options: [])])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .list])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let text = (response as? UNTextInputNotificationResponse)?.userText
    let line = response.actionIdentifier + (text.map { " \($0)" } ?? "")
    DispatchQueue.main.async {
      self.last = line
      done()
    }
  }
}
#endif

struct MainView: View {
  #if os(iOS)
  @ObservedObject private var responses = NotificationResponses.shared
  @State private var notifications = ""
  #endif
  @State private var name = ""
  @State private var password = ""
  @State private var greeting = ""
  @State private var response = ""
  @State private var hovered = false
  @State private var copied = false
  @State private var shortcut = ""
  @State private var confirming = false
  @State private var removed = ""
  @State private var camera = ""
  @AppStorage("launches") private var launches = 0

  var body: some View {
    GeometryReader { g in
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("pitbox example").font(.title).accessibilityIdentifier("title")
        // What only some devices do: turning (phones, tablets), a pointer and a keyboard (tablets).
        // One row, so the buttons below stay on the first screen: the orientation, how many times the app started
        // (`clear-app`, `state`) and the language it runs in (`settings locale`; on a device, pitbox's launch arguments).
        HStack {
          Text(g.size.width > g.size.height ? "landscape" : "portrait").accessibilityIdentifier("orientation")
          Text("launches \(launches)").accessibilityIdentifier("launches")
          Text(Locale.preferredLanguages.first ?? "").accessibilityIdentifier("language")
        }
        #if os(iOS)
        Text(hovered ? "hovered" : "hover here").accessibilityIdentifier("hover_target").onHover { hovered = $0 }
        Button("Shortcut ⌘K") { shortcut = "shortcut pressed" }.keyboardShortcut("k", modifiers: .command).accessibilityIdentifier("shortcut")
        Text(shortcut).accessibilityIdentifier("shortcut_result")
        // An alert whose button repeats the button behind it: a press must reach the alert's own.
        Button("Remove") { confirming = true }.accessibilityIdentifier("remove")
          .alert("Remove the row?", isPresented: $confirming) {
            Button("Remove", role: .destructive) { removed = "removed" }
            Button("Cancel", role: .cancel) { removed = "kept" }
          }
        Text(removed).accessibilityIdentifier("removed")
        // A system permission request: its alert is the shell's, over the app.
        Button("Camera") {
          AVCaptureDevice.requestAccess(for: .video) { ok in DispatchQueue.main.async { camera = ok ? "camera allowed" : "camera denied" } }
        }.accessibilityIdentifier("camera")
        Text(camera).accessibilityIdentifier("camera_result")
        Button("Notifications") {
          UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in DispatchQueue.main.async { notifications = ok ? "notifications allowed" : "notifications denied" } }
        }.accessibilityIdentifier("notifications")
        Text(notifications).accessibilityIdentifier("notifications_result")
        Text(responses.last).accessibilityIdentifier("notification_response")
        NavigationLink("Settings") { Text("Settings").font(.largeTitle).accessibilityIdentifier("settings_screen").navigationTitle("Settings") }
          .accessibilityIdentifier("settings")
        #endif
        #if !os(tvOS)
        Text(copied ? "copied" : "menu here").accessibilityIdentifier("menu_target").contextMenu { Button("Copy") { copied = true } }
        #endif
        #if os(visionOS)
        VisionControls()
        #endif
        TextField("Your name", text: $name).accessibilityIdentifier("name")
        Button("Greet") { greeting = "Hello, \(name.isEmpty ? "stranger" : name)" }.accessibilityIdentifier("greet")
        Text(greeting).accessibilityIdentifier("greeting")
        // A secure field and what it holds, so a flow checks typing into it: the field itself reports bullets.
        SecureField("Password", text: $password).accessibilityIdentifier("password")
        Text(password).accessibilityIdentifier("password_echo")
        Button("Ask the stand") { Task { await ask() } }.accessibilityIdentifier("fetch")
        Text(response).accessibilityIdentifier("response")
        Button("Crash") { crash() }.accessibilityIdentifier("crash")
        // Rows below the fold, for scrolling to a target.
        ForEach(1...40, id: \.self) { i in
          Text("Row \(i)").accessibilityIdentifier("row_\(i)")
        }
      }
      .padding()
    }
    .accessibilityIdentifier("content_list")
    }
  }

  /// The stand runs on the Mac. A simulator shares the Mac's network, and a physical iPhone has it on its own
  /// localhost through the runner's relay: localhost is the stand either way.
  private func ask() async {
    response = "asking…"
    do {
      var req = URLRequest(url: URL(string: "http://localhost:4100/hello")!)
      req.timeoutInterval = 3
      let (data, _) = try await URLSession.shared.data(for: req)
      response = String(decoding: data, as: UTF8.self)
    } catch {
      response = "failed: \(type(of: error))"
    }
  }
}

#if os(visionOS)
/// The last key a hardware keyboard sent, read as a headset app reads keys for its 3D content (a space has no
/// focused view to send them to): through the GameController framework.
@MainActor final class Keys: ObservableObject {
  static let shared = Keys()
  @Published var last = "none"
  private var started = false

  func start() {
    if started { return }
    started = true
    NotificationCenter.default.addObserver(forName: .GCKeyboardDidConnect, object: nil, queue: .main) { _ in MainActor.assumeIsolated { self.attach() } }
    attach()
  }

  private func attach() {
    GCKeyboard.coalesced?.keyboardInput?.keyChangedHandler = { _, _, code, pressed in
      guard pressed else { return }
      Task { @MainActor in self.last = Self.name(code) }
    }
  }

  private static func name(_ code: GCKeyCode) -> String {
    switch code {
    case .spacebar: "space"
    case .upArrow: "up"
    case .downArrow: "down"
    case .leftArrow: "left"
    case .rightArrow: "right"
    case .escape: "escape"
    case .keyF: "f"
    case .keyC: "c"
    default: "code \(code.rawValue)"
    }
  }
}

/// A headset's own surfaces: another window, a space with 3D content, and an ornament on the main window's edge.
struct VisionControls: View {
  @Environment(\.openWindow) private var openWindow
  @Environment(\.dismissWindow) private var dismissWindow
  @Environment(\.openImmersiveSpace) private var openSpace
  @Environment(\.dismissImmersiveSpace) private var dismissSpace
  @State private var space = "no space"
  @State private var ornament = "ornament not pressed"
  @State private var quality = "Auto"
  @State private var scrub = 0.2
  @State private var scrubbing: Date?
  @State private var scrubbed = "not scrubbed"
  @ObservedObject private var keys = Keys.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      // A Mac keyboard in the Simulator window is a hardware keyboard to the app.
      Text("key \(keys.last)").accessibilityIdentifier("key_result").onAppear { keys.start() }
      // A scrubber held under the finger: how long it was held says the finger stayed down.
      Slider(value: $scrub, in: 0...1) { editing in
        if editing { scrubbing = Date() } else if let since = scrubbing { scrubbed = "held \(Int(Date().timeIntervalSince(since))) s" }
      }.accessibilityIdentifier("scrub").frame(width: 300)
      Text(scrubbed).accessibilityIdentifier("scrub_result")
      Button("Open window") { openWindow(id: "second") }.accessibilityIdentifier("open_window")
      Button("Close window") { dismissWindow(id: "second") }.accessibilityIdentifier("close_window")
      Button("Enter space") {
        Task {
          switch await openSpace(id: "space") {
          case .opened: space = "in space"
          default: space = "space refused"
          }
        }
      }.accessibilityIdentifier("enter_space")
      Button("Leave space") { Task { await dismissSpace(); space = "no space" } }.accessibilityIdentifier("leave_space")
      Text(space).accessibilityIdentifier("space_state")
      Text(ornament).accessibilityIdentifier("ornament_result")
      Text("quality \(quality)").accessibilityIdentifier("quality_result")
    }
    .ornament(attachmentAnchor: .scene(.bottom)) {
      HStack {
        Button("Ornament") { ornament = "ornament pressed" }.accessibilityIdentifier("ornament_button")
        // A system menu: its items open in a platter of their own, over the app's window.
        Menu(quality) {
          ForEach(["Low", "High", "Auto"], id: \.self) { q in Button(q) { quality = q } }
        }.accessibilityIdentifier("quality_menu")
      }.padding().glassBackgroundEffect()
    }
  }
}
#endif

/// Crashes on purpose: the crash report must come back with the step that pressed the button.
func crash() {
  let rows: [Int] = []
  _ = rows[1]
}

struct DetailView: View {
  let id: String
  let back: () -> Void

  var body: some View {
    VStack(spacing: 24) {
      Text("Detail \(id)").font(.largeTitle).accessibilityIdentifier("detail_screen")
      Button("Back", action: back).accessibilityIdentifier("back")
    }
    #if os(tvOS)
    // The remote's Menu button goes back, like Android's back key.
    .onExitCommand(perform: back)
    #endif
  }
}
