// The runner's commands, the same protocol as the Android runner: a flat node list with parent indexes and
// short flags, input at screen points, idleness, focus, and images that are reduced on the device.

import XCTest

/// Must match RUNNER_VERSION in src/drivers/apple/runner.ts.
let runnerVersion = 1

final class Commands {
  private var apps: [String: XCUIApplication] = [:]
  private var lastTree: (at: Date, app: String, value: [String: Any], signature: Int)?

  #if os(tvOS)
  static let shellId = "com.apple.HeadBoard"
  #elseif os(watchOS)
  static let shellId = "com.apple.Carousel"
  #elseif os(visionOS)
  static let shellId = "com.apple.SurfBoard"
  /// System alerts (permissions, "Open in …?") come from their own process on visionOS.
  static let alertsId = "com.apple.RealityNotifications"
  #else
  static let shellId = "com.apple.springboard"
  #endif
  #if !os(visionOS)
  static let alertsId = shellId
  #endif

  /// A fresh handle for an app: one kept across a crash and relaunch points at the dead process and hangs
  /// queries. The system shell never restarts, so its handle is kept.
  private func app(_ id: String) -> XCUIApplication {
    if id != Self.shellId { return XCUIApplication(bundleIdentifier: id) }
    if let a = apps[id] { return a }
    let a = XCUIApplication(bundleIdentifier: id)
    apps[id] = a
    return a
  }

  /// The app on screen: the one the host names when it is in front, otherwise the system shell.
  private func front(_ req: [String: Any]) -> (XCUIApplication, String) {
    if let id = req["app"] as? String, !id.isEmpty {
      let a = app(id)
      if a.state == .runningForeground { return (a, id) }
    }
    return (app(Self.shellId), Self.shellId)
  }

  /// XCUITest failures recorded during the current command.
  static var issues: [String] = []

  func handle(_ req: [String: Any]) -> (reply: [String: Any], stop: Bool) {
    let id = req["id"] ?? 0
    let cmd = req["cmd"] as? String ?? ""
    Self.issues.removeAll()
    do {
      var out = try run(cmd, req)
      if let issue = Self.issues.first { return (["id": id, "ok": false, "error": issue], false) }
      out["id"] = id
      out["ok"] = true
      return (out, cmd == "shutdown")
    } catch let e as RunnerError {
      return (["id": id, "ok": false, "error": e.message], false)
    } catch {
      return (["id": id, "ok": false, "error": "\(error)"], false)
    }
  }

  private func run(_ cmd: String, _ req: [String: Any]) throws -> [String: Any] {
    switch cmd {
    case "ping": return ["version": runnerVersion]
    case "shutdown": return [:]
    case "info": return info(req)
    case "tree": return try tree(req, maxAge: 0.05).value
    case "idle": return ["idle": try idle(req, quiet: double(req, "quiet", 300) / 1000, timeout: double(req, "timeout", 3000) / 1000)]
    case "focus": return try focus(req)
    case "tap", "doubletap", "longpress":
      #if os(tvOS)
      throw RunnerError("tvOS has no touch — use key up/down/left/right/select")
      #else
      #if os(visionOS)
      // A synthesized touch at a point does not press a control on visionOS; the element is pressed. The host's
      // node first: every window has its own coordinates, so a point can be inside views of several windows.
      let point = CGPoint(x: double(req, "x", 0), y: double(req, "y", 0))
      if let e = node(req) ?? control(at: point, req) ?? element(at: point, req, where: { $0 != .application && $0 != .window && $0 != .other }) {
        if cmd == "tap" { e.tap() } else if cmd == "doubletap" { e.doubleTap() } else { e.press(forDuration: double(req, "hold", 800) / 1000) }
        return [:]
      }
      #endif
      // A button of the shell's alert (a permission request, "Open in …?") is pressed as the shell's element. A
      // point is tapped through the app, and XCTest first clears an alert that blocks the app on its own (UI
      // interruption handling) and then puts the tap on the app underneath.
      if (req["window"] as? String) == Self.alertsId, let label = req["label"] as? String, !label.isEmpty {
        // iOS draws an alert's button as a button inside a button of the same name: the query matches both, and
        // an element that is not the only match cannot be tapped.
        let button = systemAlert().buttons[label].firstMatch
        if button.exists {
          if cmd == "tap" { button.tap() } else if cmd == "doubletap" { button.doubleTap() } else { button.press(forDuration: double(req, "hold", 800) / 1000) }
          return [:]
        }
      }
      let c = coordinate(req)
      if cmd == "tap" { c.tap() } else if cmd == "doubletap" { c.doubleTap() } else { c.press(forDuration: double(req, "hold", 800) / 1000) }
      return [:]
      #endif
    case "swipe": return try swipe(req)
    case "touch": throw RunnerError("XCUITest cannot hold a finger between calls — use swipe or longpress")
    case "text": return try text(req)
    case "key": return try key(req)
    case "rotate": return try rotate(req)
    case "rotary": return try rotary(req)
    case "mouse": return try mouse(req)
    case "screenshot", "fingerprint", "frames":
      #if os(visionOS)
      Images.window = front(req).0.windows.firstMatch
      #endif
      return try image(cmd, req)
    case "relays": return ["relayed": [Int]()]
    case "banners", "tapBanner":
      // Notification banners: the shell draws them over whatever app is in front, so the tree of that app does
      // not hold them. `tapBanner` taps the newest one whose text holds `text`.
      #if os(iOS)
      let banners = notificationBanners()
      if cmd == "banners" { return ["banners": banners.map { $0.label }, "front": front(req).1] }
      let text = req["text"] as? String ?? ""
      guard let hit = banners.first(where: { text.isEmpty || $0.label.contains(text) }) else { return ["tapped": false] }
      app(Self.shellId).coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: hit.frame.midX, dy: hit.frame.midY)).tap()
      return ["tapped": true, "label": hit.label]
      #else
      return cmd == "banners" ? ["banners": [String](), "front": front(req).1] : ["tapped": false]
      #endif
    case "foreground":
      // After a launch: wait until the app is in front, so the next tree is the app and not the shell.
      guard let id = req["app"] as? String, !id.isEmpty else { return ["foreground": false] }
      return ["foreground": app(id).wait(for: .runningForeground, timeout: double(req, "timeout", 5000) / 1000)]
    case "confirmOpen":
      // `simctl openurl` asks "Open in <app>?" in the shell before a link reaches the app. The question has two
      // buttons, the confirming one last; its words depend on the system language. tvOS opens links directly;
      // visionOS asks too.
      #if os(tvOS) || os(watchOS)
      return ["confirmed": false]
      #else
      // The question is asked only for an app that is not in front: a link into the app already open goes
      // straight in. So the wait ends once the app is in front with no question up (after a moment for the shell
      // to put one up), instead of the whole timeout on every link into a running app.
      // Every `exists` is a query of the whole shell, so it is asked once after the moment, not in a loop.
      let alert = systemAlert()
      if let id = req["app"] as? String, !id.isEmpty {
        Thread.sleep(forTimeInterval: 0.25)
        if app(id).state == .runningForeground && !alert.exists { return ["confirmed": false] }
      }
      guard alert.waitForExistence(timeout: double(req, "timeout", 3000) / 1000) else { return ["confirmed": false] }
      let buttons = alert.buttons.allElementsBoundByIndex
      guard buttons.count == 2 else { return ["confirmed": false] }
      buttons[1].tap()
      return ["confirmed": true]
      #endif
    case "activate":
      // Starting the runner puts its own process in front; bring the app back when it was running.
      if let id = req["app"] as? String, !id.isEmpty {
        let a = app(id)
        if a.state != .notRunning && a.state != .unknown { a.activate() }
      }
      return [:]
    default: throw RunnerError("unknown command: \(cmd)")
    }
  }

  private func double(_ req: [String: Any], _ key: String, _ fallback: Double) -> Double {
    (req[key] as? NSNumber)?.doubleValue ?? fallback
  }

  private func rects(_ v: Any?) -> [CGRect] {
    guard let list = v as? [[NSNumber]] else { return [] }
    return list.filter { $0.count == 4 }.map { b in
      CGRect(x: b[0].doubleValue, y: b[1].doubleValue, width: b[2].doubleValue - b[0].doubleValue, height: b[3].doubleValue - b[1].doubleValue)
    }
  }

  private func info(_ req: [String: Any]) -> [String: Any] {
    var size = XCUIScreen.main.screenshot().image.size
    // visionOS has no screen to capture (a 1x1 image): the app's frame is the space its windows live in.
    if size.width < 10 { size = front(req).0.frame.size }
    #if os(tvOS)
    let platform = "tvos"
    #elseif os(visionOS)
    let platform = "visionos"
    #elseif os(watchOS)
    let platform = "watchos"
    #else
    let platform = "ios"
    #endif
    return ["width": Int(size.width), "height": Int(size.height), "platform": platform, "version": runnerVersion]
  }

  // MARK: tree

  private static let typeNames: [XCUIElement.ElementType: String] = [
    .button: "Button", .staticText: "Text", .textField: "TextField", .secureTextField: "SecureTextField",
    .searchField: "SearchField", .textView: "TextView", .image: "Image", .icon: "Icon", .switch: "Switch",
    .toggle: "Toggle", .checkBox: "CheckBox", .radioButton: "RadioButton", .cell: "Cell", .link: "Link",
    .scrollView: "ScrollView", .table: "Table", .collectionView: "CollectionView", .webView: "WebView",
    .navigationBar: "NavigationBar", .tabBar: "TabBar", .tab: "Tab", .toolbar: "Toolbar", .alert: "Alert",
    .sheet: "Sheet", .slider: "Slider", .picker: "Picker", .pickerWheel: "PickerWheel",
    .segmentedControl: "SegmentedControl", .menuItem: "MenuItem", .menu: "Menu", .key: "Key", .keyboard: "Keyboard",
    .window: "Window", .application: "Application", .progressIndicator: "ProgressIndicator",
    .activityIndicator: "ActivityIndicator", .pageIndicator: "PageIndicator", .stepper: "Stepper",
    .popUpButton: "PopUpButton", .menuButton: "MenuButton", .statusBar: "StatusBar", .group: "Group", .other: "Other",
  ]

  private static let tappable: Set<XCUIElement.ElementType> = [.button, .cell, .link, .switch, .toggle, .checkBox, .radioButton, .tab, .icon, .menuItem, .key, .popUpButton, .menuButton, .stepper, .pickerWheel, .slider]
  private static let editable: Set<XCUIElement.ElementType> = [.textField, .secureTextField, .searchField, .textView]
  private static let checkable: Set<XCUIElement.ElementType> = [.switch, .toggle, .checkBox, .radioButton]
  private static let scrollable: Set<XCUIElement.ElementType> = [.scrollView, .table, .collectionView]

  /// The shell's notification banners with their frames, newest first. Read from a snapshot of the shell: an
  /// element query for them comes back empty while another app is in front.
  private func notificationBanners() -> [(label: String, frame: CGRect)] {
    guard let root = try? app(Self.shellId).snapshot() else { return [] }
    var out: [(label: String, frame: CGRect)] = []
    func visit(_ n: XCUIElementSnapshot, _ depth: Int) {
      if depth > 80 { return }
      if n.identifier == "NotificationShortLookView" {
        out.append((n.label, n.frame))
        return
      }
      for c in n.children { visit(c, depth + 1) }
    }
    visit(root, 0)
    return out
  }

  /// A system alert over the app; visionOS draws it as a plain element of its notifications process.
  private func systemAlert() -> XCUIElement {
    #if os(visionOS)
    return app(Self.alertsId).otherElements["com.apple.RealityNotifications.CriticalSystemAlert"]
    #else
    return app(Self.alertsId).alerts.firstMatch
    #endif
  }

  private static func holds(_ n: XCUIElementSnapshot, depth: Int, _ match: (XCUIElementSnapshot) -> Bool) -> Bool {
    if match(n) { return true }
    return depth < 12 && n.children.contains { holds($0, depth: depth + 1, match) }
  }

  /// The frames on screen inside a window that are smaller than the screen: what the window shows.
  private static func parts(of n: XCUIElementSnapshot, screen: CGRect, depth: Int) -> [CGRect] {
    let f = n.frame
    if depth > 0 && !f.isEmpty && f.height < screen.height * 0.9 && screen.contains(f) { return [f] }
    return depth < 12 ? n.children.flatMap { parts(of: $0, screen: screen, depth: depth + 1) } : []
  }

  /// Whether a view shows anything: text or a control somewhere inside it.
  private static func shows(_ n: XCUIElementSnapshot, depth: Int = 0) -> Bool {
    if !n.label.isEmpty || n.elementType == .button || n.elementType == .staticText { return true }
    return depth < 12 && n.children.contains { shows($0, depth: depth + 1) }
  }

  /// The keyboard's frame in the tree being built.
  private var keyboard: CGRect?

  private func tree(_ req: [String: Any], maxAge: TimeInterval) throws -> (value: [String: Any], signature: Int) {
    let (a, id) = front(req)
    if let last = lastTree, last.app == id, Date().timeIntervalSince(last.at) <= maxAge { return (last.value, last.signature) }
    let all = req["all"] as? Bool ?? false
    var nodes: [[String: Any]] = []
    var windows: [[String: Any]] = []
    var hasher = Hasher()
    let root = try a.snapshot()
    var screen = root.frame.isEmpty ? CGRect(origin: .zero, size: XCUIScreen.main.screenshot().image.size) : root.frame
    // visionOS's shell has no frame and its screenshot is 1x1: nothing would be on screen. Its windows float apart,
    // each in its own space, and the root's frame is whichever window was used last (an ornament after a tap
    // on it): no frame there tells what is on screen.
    #if os(visionOS)
    screen = CGRect(x: -100_000, y: -100_000, width: 200_000, height: 200_000)
    #else
    if screen.width < 10 { screen = CGRect(x: -100_000, y: -100_000, width: 200_000, height: 200_000) }
    #endif
    windows.append(["type": "app", "title": root.label, "pkg": id])
    keyboard = nil
    walk(root, parent: -1, window: 0, screen: screen, all: all, out: &nodes, hasher: &hasher, depth: 0)
    // The keyboard as its own window, like Android's input method: the host keeps gestures above it. Its keys
    // stay out — text goes in with `text`.
    if let k = keyboard {
      let b = [Int(k.minX.rounded()), Int(k.minY.rounded()), Int(k.maxX.rounded()), Int(k.maxY.rounded())]
      nodes.append(["p": -1, "w": windows.count, "c": "Keyboard", "b": b])
      windows.append(["type": "ime", "title": "keyboard", "pkg": "com.apple.keyboard"])
      hasher.combine(b)
    }
    // System alerts (permissions, notifications) live in the shell, not in the app.
    if id != Self.shellId {
      let alert = systemAlert()
      // visionOS keeps its alert container whether or not an alert shows: an empty one is not listed.
      if alert.exists, let snap = try? alert.snapshot(), Self.shows(snap) {
        windows.append(["type": "app", "title": snap.label, "pkg": Self.alertsId])
        walk(snap, parent: -1, window: windows.count - 1, screen: screen, all: all, out: &nodes, hasher: &hasher, depth: 0)
      }
    }
    let value: [String: Any] = ["windows": windows, "nodes": nodes]
    let signature = hasher.finalize()
    lastTree = (Date(), id, value, signature)
    return (value, signature)
  }

  private func walk(_ n: XCUIElementSnapshot, parent: Int, window: Int, screen: CGRect, all: Bool, out: inout [[String: Any]], hasher: inout Hasher, depth: Int, focused: Bool = false, echo: (String, CGRect)? = nil) {
    if depth > 80 { return }
    var index = parent
    let f = n.frame
    if n.elementType == .keyboard {
      if !f.isEmpty && f.intersects(screen) { keyboard = keyboard.map { $0.union(f) } ?? f }
      return
    }
    // From iOS 26 the keyboard draws out of process, in a window of its own that also holds the prediction bar
    // and the globe and dictation buttons beside the keys, with an empty host view (`inputView`) in another
    // window: both windows are the keyboard.
    if depth == 1 && n.elementType == .window && Self.holds(n, depth: 0, { $0.identifier == "inputView" || $0.elementType == .keyboard }) {
      // The keyboard's frame comes from the window with the keys; the host view's window adds nothing to it.
      if Self.holds(n, depth: 0, { $0.elementType == .keyboard }) {
        for part in Self.parts(of: n, screen: screen, depth: 0) { keyboard = keyboard.map { $0.union(part) } ?? part }
      }
      return
    }
    // A skipped wrapper hands its focus down to the control that stands for it.
    var passFocus = false
    let visible = !f.isEmpty && f.intersects(screen) && n.elementType != .application
    if visible {
      let type = n.elementType
      let label = n.label
      let value = (n.value as? String) ?? ""
      let ident = n.identifier
      let isEditable = Self.editable.contains(type)
      let interactive = Self.tappable.contains(type) || isEditable || Self.scrollable.contains(type)
      // A wrapper without its own text around a control of the same size (a cell around its button) adds a
      // line that says nothing; the control stands for both.
      let wrapper = label.isEmpty && value.isEmpty && ident.isEmpty && Self.wraps(n, frame: f, depth: 6)
      if wrapper && (n.hasFocus || focused) { passFocus = true }
      // React Native's Text is a view carrying the text with the static text inside it: one line, not two.
      let repeats = ident.isEmpty && !interactive && echo.map { $0.0 == label && Self.same($0.1, f) } == true
      if !wrapper && !repeats && (all || interactive || !label.isEmpty || !value.isEmpty || !ident.isEmpty) {
        let b = [Int(f.minX.rounded()), Int(f.minY.rounded()), Int(f.maxX.rounded()), Int(f.maxY.rounded())]
        var o: [String: Any] = ["p": parent, "w": window, "c": Self.typeNames[type] ?? "Other", "b": b]
        if !ident.isEmpty { o["id"] = ident }
        let placeholder = n.placeholderValue ?? ""
        if isEditable {
          if !value.isEmpty && value != placeholder { o["t"] = value }
          if !placeholder.isEmpty { o["h"] = placeholder }
          if !label.isEmpty { o["d"] = label }
        } else if Self.checkable.contains(type) {
          if !label.isEmpty { o["t"] = label }
        } else {
          if !label.isEmpty { o["t"] = label } else if !value.isEmpty { o["t"] = value }
          if !label.isEmpty && !value.isEmpty && value != label { o["d"] = value }
        }
        var flags = ""
        if Self.tappable.contains(type) { flags += "c" }
        #if os(tvOS)
        // Focus lands on a list's items, never on the list.
        if Self.tappable.contains(type) || isEditable { flags += "f" }
        #endif
        if n.hasFocus || (focused && (Self.tappable.contains(type) || isEditable)) { flags += "F" }
        if isEditable { flags += "e" }
        if Self.scrollable.contains(type) { flags += "s" }
        if Self.checkable.contains(type) {
          let on = (n.value as? NSNumber)?.boolValue ?? (value == "1")
          flags += on ? "X" : "x"
        }
        if n.isSelected { flags += "S" }
        if !n.isEnabled { flags += "d" }
        if type == .secureTextField { flags += "p" }
        if !flags.isEmpty { o["f"] = flags }
        // The same element twice (a system alert's button inside a button of the same name and frame, or twin
        // siblings) is one line: its children hang under the line already there.
        if let twin = Self.twin(o, in: out) {
          index = twin
          for child in n.children {
            walk(child, parent: index, window: window, screen: screen, all: all, out: &out, hasher: &hasher, depth: depth + 1, focused: passFocus || (focused && index == parent), echo: n.label.isEmpty ? nil : (n.label, f))
          }
          return
        }
        hasher.combine(b)
        hasher.combine(label)
        hasher.combine(value)
        hasher.combine(flags)
        index = out.count
        out.append(o)
      }
    }
    for child in n.children {
      walk(child, parent: index, window: window, screen: screen, all: all, out: &out, hasher: &hasher, depth: depth + 1, focused: passFocus || (focused && index == parent), echo: n.label.isEmpty ? nil : (n.label, f))
    }
  }

  /// A line already listed that `o` repeats: its parent, or one of the last siblings before it.
  private static func twin(_ o: [String: Any], in out: [[String: Any]]) -> Int? {
    func equal(_ a: [String: Any], _ b: [String: Any]) -> Bool {
      ["c", "id", "t", "d", "f"].allSatisfy { (a[$0] as? String) == (b[$0] as? String) } && (a["b"] as? [Int]) == (b["b"] as? [Int]) && (a["w"] as? Int) == (b["w"] as? Int)
    }
    guard let parent = o["p"] as? Int else { return nil }
    if parent >= 0, equal(out[parent], o) { return parent }
    var k = out.count - 1
    while k > parent && k >= out.count - 8 {
      if (out[k]["p"] as? Int) == parent, equal(out[k], o) { return k }
      k -= 1
    }
    return nil
  }

  private static func same(_ g: CGRect, _ f: CGRect) -> Bool {
    abs(g.minX - f.minX) < 2 && abs(g.minY - f.minY) < 2 && abs(g.maxX - f.maxX) < 2 && abs(g.maxY - f.maxY) < 2
  }

  /// Whether a control with (nearly) the same frame sits within `depth` levels below (UIKit nests a cell's
  /// button four plain views deep).
  private static func wraps(_ n: XCUIElementSnapshot, frame f: CGRect, depth: Int) -> Bool {
    if depth == 0 { return false }
    for c in n.children {
      let g = c.frame
      let same = Self.same(g, f)
      if same && (tappable.contains(c.elementType) || editable.contains(c.elementType)) { return true }
      if wraps(c, frame: f, depth: depth - 1) { return true }
    }
    return false
  }

  /// Quiet once two trees `quiet` apart are the same; XCUITest already waits for the app to idle before each.
  private func idle(_ req: [String: Any], quiet: TimeInterval, timeout: TimeInterval) throws -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    var prev = try tree(req, maxAge: 0).signature
    while Date() < deadline {
      Thread.sleep(forTimeInterval: min(quiet, max(0, deadline.timeIntervalSinceNow)))
      let next = try tree(req, maxAge: 0).signature
      if next == prev { return true }
      prev = next
    }
    return false
  }

  private func describe(_ e: XCUIElement) -> [String: Any] {
    let f = e.frame
    var o: [String: Any] = ["c": Self.typeNames[e.elementType] ?? "Other", "b": [Int(f.minX.rounded()), Int(f.minY.rounded()), Int(f.maxX.rounded()), Int(f.maxY.rounded())]]
    if !e.identifier.isEmpty { o["id"] = e.identifier }
    if !e.label.isEmpty { o["t"] = e.label }
    return o
  }

  /// The focused node as the tree reports it, so the host can match it against snapshot nodes exactly.
  private func focus(_ req: [String: Any]) throws -> [String: Any] {
    #if os(tvOS)
    let nodes = (try tree(req, maxAge: 0).value["nodes"] as? [[String: Any]]) ?? []
    if let hit = nodes.last(where: { ($0["f"] as? String ?? "").contains("F") }) { return ["input": hit] }
    return [:]
    #else
    let (a, _) = front(req)
    let field = a.descendants(matching: .any).element(matching: NSPredicate(format: "hasKeyboardFocus == true"))
    return field.exists ? ["input": describe(field)] : [:]
    #endif
  }

  // MARK: input

  #if !os(tvOS)
  /// The smallest control whose frame holds the point, as an element to act on.
  private func control(at point: CGPoint, _ req: [String: Any]) -> XCUIElement? {
    element(at: point, req) { Self.tappable.contains($0) || Self.editable.contains($0) }
  }

  /// The element the host aimed at, by its id or label and its frame: found in one snapshot, then fetched by its
  /// type (a query over every type is slow enough on visionOS to time a tap out).
  private func node(_ req: [String: Any]) -> XCUIElement? {
    guard let b = req["bounds"] as? [Double], b.count == 4 else { return nil }
    let frame = CGRect(x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1])
    let id = req["ident"] as? String ?? "", label = req["label"] as? String ?? ""
    if id.isEmpty && label.isEmpty { return nil }
    let (a, _) = front(req)
    guard let root = try? a.snapshot() else { return nil }
    var hit: XCUIElementSnapshot?
    func visit(_ n: XCUIElementSnapshot) {
      if hit != nil { return }
      if (id.isEmpty ? n.label == label : n.identifier == id) && Self.same(n.frame, frame) { hit = n; return }
      n.children.forEach(visit)
    }
    visit(root)
    guard let n = hit else { return nil }
    return resolve(n, in: a)
  }

  /// A live element for a snapshot node: by its type and id or label, at the same frame.
  private func resolve(_ n: XCUIElementSnapshot, in a: XCUIApplication) -> XCUIElement? {
    let all = a.descendants(matching: n.elementType)
    let query = n.identifier.isEmpty ? all.matching(NSPredicate(format: "label == %@", n.label)) : all.matching(identifier: n.identifier)
    return query.allElementsBoundByIndex.first { Self.same($0.frame, n.frame) }
  }

  private func scroller(at point: CGPoint, _ req: [String: Any]) -> XCUIElement? {
    element(at: point, req) { Self.scrollable.contains($0) }
  }

  private func element(at point: CGPoint, _ req: [String: Any], where wanted: (XCUIElement.ElementType) -> Bool) -> XCUIElement? {
    let (a, _) = front(req)
    guard let root = try? a.snapshot() else { return nil }
    var best: XCUIElementSnapshot?
    func visit(_ n: XCUIElementSnapshot) {
      if wanted(n.elementType) && n.frame.contains(point) {
        if best.map({ n.frame.width * n.frame.height < $0.frame.width * $0.frame.height }) ?? true { best = n }
      }
      n.children.forEach(visit)
    }
    visit(root)
    guard let n = best else { return nil }
    return resolve(n, in: a)
  }

  private func coordinate(_ req: [String: Any], x xKey: String = "x", y yKey: String = "y") -> XCUICoordinate {
    let (a, _) = front(req)
    let x = double(req, xKey, 0), y = double(req, yKey, 0)
    #if os(visionOS)
    // An event from the application has no scene on visionOS; it goes through the window under the point.
    let point = CGPoint(x: x, y: y)
    // The smallest window under the point: the scene's own, not the full-space ones around it.
    let under = a.windows.allElementsBoundByIndex.filter { $0.frame.contains(point) }
    if let w = under.min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) {
      return w.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: x - w.frame.minX, dy: y - w.frame.minY))
    }
    #endif
    return a.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: x, dy: y))
  }
  #endif

  private func swipe(_ req: [String: Any]) throws -> [String: Any] {
    #if os(tvOS)
    throw RunnerError("tvOS has no touch — use key up/down/left/right")
    #else
    let dx = double(req, "x2", 0) - double(req, "x1", 0)
    let dy = double(req, "y2", 0) - double(req, "y1", 0)
    #if os(visionOS)
    // A drag between points does not scroll on visionOS; the scroller under the start swipes itself.
    if let e = scroller(at: CGPoint(x: double(req, "x1", 0), y: double(req, "y1", 0)), req) {
      if abs(dy) >= abs(dx) { dy < 0 ? e.swipeUp(velocity: .slow) : e.swipeDown(velocity: .slow) } else { dx < 0 ? e.swipeLeft(velocity: .slow) : e.swipeRight(velocity: .slow) }
      return [:]
    }
    #endif
    let from = coordinate(req, x: "x1", y: "y1")
    let to = coordinate(req, x: "x2", y: "y2")
    let seconds = max(0.05, double(req, "duration", 300) / 1000)
    let velocity = max(100, (dx * dx + dy * dy).squareRoot() / seconds)
    from.press(forDuration: 0.03, thenDragTo: to, withVelocity: XCUIGestureVelocity(CGFloat(velocity)), thenHoldForDuration: 0)
    return [:]
    #endif
  }

  private func text(_ req: [String: Any]) throws -> [String: Any] {
    let (a, _) = front(req)
    let text = req["text"] as? String ?? ""
    var field = a.descendants(matching: .any).element(matching: NSPredicate(format: "hasKeyboardFocus == true"))
    // visionOS does not report keyboard focus: the field the host aimed at, by its bounds. Typing into the
    // element focuses it.
    if !field.exists, let b = rects(req["bounds"].map { [$0] }).first {
      let fields = a.descendants(matching: .any).matching(NSPredicate(format: "elementType IN %@", Self.editable.map { $0.rawValue })).allElementsBoundByIndex
      if let hit = fields.first(where: { Self.same($0.frame, b) }) {
        field = hit
        #if !os(tvOS)
        hit.tap()
        #endif
      }
    }
    guard field.exists else { return ["set": false] }
    if !(req["append"] as? Bool ?? false) { try clear(field) }
    let before = req["append"] as? Bool ?? false ? ((field.value as? String) ?? "") : ""
    if field.elementType == .secureTextField {
      return try secureText(field, text, held: before == (field.placeholderValue ?? "") ? 0 : before.count)
    }
    if !text.isEmpty { field.typeText(text) }
    // A controlled React Native input re-renders between keystrokes and can drop one that XCUITest typed
    // meanwhile. Checked, and typed again key by key when the field does not hold what was typed.
    if let got = field.value as? String, got != before + text {
      try clear(field)
      for ch in before + text {
        field.typeText(String(ch))
        Thread.sleep(forTimeInterval: 0.05)
      }
      return ["set": true, "retyped": true]
    }
    return ["set": true]
  }

  /// What a field holds: an empty one reports its placeholder as its value.
  private func shown(_ field: XCUIElement) -> String {
    let value = (field.value as? String) ?? ""
    return value == (field.placeholderValue ?? "") ? "" : value
  }

  /// Empties a field and checks that it is empty. The tap that focused the field leaves the cursor where it landed —
  /// inside a longer text — and delete keys remove only what is before the cursor, so the cursor goes to the end
  /// first. A controlled React Native input can drop keys typed in one burst: what is left goes key by key, and
  /// select-all takes whatever remains after that.
  private func clear(_ field: XCUIElement) throws {
    for attempt in 0..<3 {
      let left = shown(field)
      if left.isEmpty { return }
      #if os(iOS) || os(visionOS)
      field.typeKey(.downArrow, modifierFlags: .command)
      field.typeKey(.rightArrow, modifierFlags: .command)
      if attempt == 2 { field.typeKey(XCUIKeyboardKey(rawValue: "a"), modifierFlags: .command) }
      #endif
      if attempt == 0 {
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: left.count))
      } else {
        for _ in 0..<(attempt == 2 ? 1 : left.count) {
          field.typeText(XCUIKeyboardKey.delete.rawValue)
          Thread.sleep(forTimeInterval: 0.03)
        }
      }
    }
    let left = shown(field)
    if !left.isEmpty { throw RunnerError("the field still holds \"\(left)\" after it was cleared") }
  }

  /// A secure field reports only bullets, one per character, so what it holds is checked by their count.
  /// XCUITest types into it by pressing the software keyboard's keys, and a character the current layout has no
  /// key for is dropped without an error: on a Cyrillic keyboard only the digits and punctuation of a Latin
  /// password arrive. The text then goes in through the pasteboard and ⌘V — a paste the person started from the
  /// keyboard, which iOS does not ask about — and the pasteboard gets back what it held.
  private func secureText(_ field: XCUIElement, _ text: String, held: Int) throws -> [String: Any] {
    // An empty field reports its placeholder as its value.
    let count = { () -> Int in
      let value = (field.value as? String) ?? ""
      return value == (field.placeholderValue ?? "") ? 0 : value.count
    }
    if !text.isEmpty { field.typeText(text) }
    let typed = count()
    if typed == held + text.count { return ["set": true] }
    #if os(iOS) || os(visionOS)
    if typed > held { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed - held)) }
    let board = UIPasteboard.general
    let saved = board.items
    board.string = text
    field.typeKey("v", modifierFlags: .command)
    board.items = saved
    let pasted = count()
    if pasted == held + text.count { return ["set": true, "pasted": true] }
    throw RunnerError("the secure field holds \(pasted) characters, not \(held + text.count): neither the keyboard nor a paste put the text in")
    #else
    throw RunnerError("the secure field holds \(typed) characters, not \(held + text.count): the keyboard has no keys for some of them")
    #endif
  }

  /// Android key codes, so flows stay the same across platforms.
  private func key(_ req: [String: Any]) throws -> [String: Any] {
    let code = Int(double(req, "code", -1))
    let (a, _) = front(req)
    #if os(tvOS)
    let remote: [Int: XCUIRemote.Button] = [19: .up, 20: .down, 21: .left, 22: .right, 23: .select, 66: .select, 4: .menu, 82: .menu, 3: .home, 85: .playPause]
    guard let button = remote[code] else { throw RunnerError("no Siri Remote button for key code \(code)") }
    XCUIRemote.shared.press(button)
    #else
    #if os(iOS)
    // A combination from a hardware keyboard (an iPad's): Android's key code and meta flags as a key and modifiers.
    let meta = Int(double(req, "meta", 0))
    if meta != 0 {
      guard let k = Self.keyName(code) else { throw RunnerError("key code \(code) has no key on an Apple keyboard") }
      var flags: XCUIElement.KeyModifierFlags = []
      if meta & 0x1000 != 0 { flags.insert(.control) }
      if meta & 0x1 != 0 { flags.insert(.shift) }
      if meta & 0x2 != 0 { flags.insert(.option) }
      if meta & 0x10000 != 0 { flags.insert(.command) }
      a.typeKey(k, modifierFlags: flags)
      return [:]
    }
    #endif
    switch code {
    #if os(iOS) || os(visionOS)
    // visionOS: a press of the Digital Crown, which brings up Home.
    case 3: XCUIDevice.shared.press(.home)
    #endif
    case 66: a.typeText("\n")
    case 67: a.typeText(XCUIKeyboardKey.delete.rawValue)
    default: throw RunnerError("key code \(code) has no equivalent on this device (home, enter and del do)")
    }
    #endif
    _ = a
    return [:]
  }

  #if os(iOS)
  /// Android key codes as the keys `typeKey` takes: letters, digits and the named keys a shortcut uses.
  private static func keyName(_ code: Int) -> String? {
    if (29...54).contains(code) { return String(UnicodeScalar(UInt8(97 + code - 29))) }
    if (7...16).contains(code) { return String(code - 7) }
    let named: [Int: XCUIKeyboardKey] = [61: .tab, 66: .return, 67: .delete, 111: .escape, 62: .space, 19: .upArrow, 20: .downArrow, 21: .leftArrow, 22: .rightArrow, 112: .forwardDelete, 122: .home, 123: .end, 92: .pageUp, 93: .pageDown]
    return named[code]?.rawValue
  }
  #endif

  /// Turns the device: Android's rotation in degrees as an orientation. Simulators have no sensor, so `auto`
  /// A screen image: a downscaled JPEG, a brightness grid, or frames of a region.
  private func image(_ cmd: String, _ req: [String: Any]) throws -> [String: Any] {
    switch cmd {
    case "screenshot": return try Images.jpeg(scale: double(req, "scale", 0.5), quality: double(req, "quality", 70) / 100)
    case "fingerprint": return try Images.fingerprint(cols: Int(double(req, "cols", 54)), masks: rects(req["masks"]))
    default: return try Images.frames(bounds: rects(req["bounds"].map { [$0] }).first, count: Int(double(req, "count", 4)), interval: double(req, "interval", 400) / 1000, size: Int(double(req, "size", 32)))
    }
  }

  /// is portrait again.
  private func rotate(_ req: [String: Any]) throws -> [String: Any] {
    #if os(iOS)
    let value = req["value"] as? String ?? ""
    let map: [String: UIDeviceOrientation] = ["0": .portrait, "90": .landscapeLeft, "180": .portraitUpsideDown, "270": .landscapeRight, "auto": .portrait]
    guard let o = map[value] else { throw RunnerError("rotate 0, 90, 180, 270 or auto") }
    XCUIDevice.shared.orientation = o
    Thread.sleep(forTimeInterval: 0.8)
    // Some screens stay portrait whatever the device does (the cover screen of a folded phone, an app that
    // supports portrait only): a turn that did not reach the app is an error, not a silent success.
    let frame = front(req).0.windows.firstMatch.frame
    if !frame.isEmpty, (frame.width > frame.height) != o.isLandscape {
      throw RunnerError("the screen stayed \(frame.width > frame.height ? "landscape" : "portrait") (\(Int(frame.width))x\(Int(frame.height))): this screen or the app does not turn to \(value)")
    }
    return ["rotation": value]
    #else
    throw RunnerError("this device does not rotate")
    #endif
  }

  /// The Digital Crown turned `steps` detents; a negative amount moves the content as a swipe up would.
  private func rotary(_ req: [String: Any]) throws -> [String: Any] {
    #if os(watchOS)
    let amount = double(req, "amount", -1), steps = double(req, "steps", 3)
    XCUIDevice.shared.rotateDigitalCrown(delta: -amount * steps * 0.05, velocity: .default)
    return [:]
    #else
    throw RunnerError("this device has no crown")
    #endif
  }

  /// A pointer on an iPad: hover, a secondary click, the wheel over the control or scroller under the point.
  private func mouse(_ req: [String: Any]) throws -> [String: Any] {
    #if os(iOS)
    let point = CGPoint(x: double(req, "x", 0), y: double(req, "y", 0))
    let action = req["action"] as? String ?? ""
    if action == "wheel" {
      let e = element(at: point, req) { Self.scrollable.contains($0) } ?? front(req).0
      // A notch is about three lines, as a wheel's; a positive amount scrolls towards the top, which iOS takes
      // as a negative delta.
      e.scroll(byDeltaX: 0, deltaY: CGFloat(-double(req, "amount", -1) * 120))
      return [:]
    }
    let target = element(at: point, req) { _ in true }
    guard let e = target else { throw RunnerError("nothing under \(Int(point.x)),\(Int(point.y))") }
    switch action {
    case "hover": e.hover()
    case "right": e.rightClick()
    default: throw RunnerError("mouse right|hover|wheel")
    }
    return [:]
    #else
    throw RunnerError("this device has no pointer")
    #endif
  }
}
