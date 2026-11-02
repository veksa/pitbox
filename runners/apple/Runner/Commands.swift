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
  #else
  static let shellId = "com.apple.springboard"
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

  func handle(_ req: [String: Any]) -> (reply: [String: Any], stop: Bool) {
    let id = req["id"] ?? 0
    let cmd = req["cmd"] as? String ?? ""
    do {
      var out = try run(cmd, req)
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
    case "info": return info()
    case "tree": return try tree(req, maxAge: 0.05).value
    case "idle": return ["idle": try idle(req, quiet: double(req, "quiet", 300) / 1000, timeout: double(req, "timeout", 3000) / 1000)]
    case "focus": return try focus(req)
    case "tap", "doubletap", "longpress":
      #if os(tvOS)
      throw RunnerError("tvOS has no touch — use key up/down/left/right/select")
      #else
      let c = coordinate(req)
      if cmd == "tap" { c.tap() } else if cmd == "doubletap" { c.doubleTap() } else { c.press(forDuration: double(req, "hold", 800) / 1000) }
      return [:]
      #endif
    case "swipe": return try swipe(req)
    case "touch": throw RunnerError("XCUITest cannot hold a finger between calls — use swipe or longpress")
    case "text": return try text(req)
    case "key": return try key(req)
    case "screenshot": return try Images.jpeg(scale: double(req, "scale", 0.5), quality: double(req, "quality", 70) / 100)
    case "fingerprint": return try Images.fingerprint(cols: Int(double(req, "cols", 54)), masks: rects(req["masks"]))
    case "frames": return try Images.frames(bounds: rects(req["bounds"].map { [$0] }).first, count: Int(double(req, "count", 4)), interval: double(req, "interval", 400) / 1000, size: Int(double(req, "size", 32)))
    case "relays": return ["relayed": [Int]()]
    case "foreground":
      // After a launch: wait until the app is in front, so the next tree is the app and not the shell.
      guard let id = req["app"] as? String, !id.isEmpty else { return ["foreground": false] }
      return ["foreground": app(id).wait(for: .runningForeground, timeout: double(req, "timeout", 5000) / 1000)]
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

  private func info() -> [String: Any] {
    let size = XCUIScreen.main.screenshot().image.size
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

  private func tree(_ req: [String: Any], maxAge: TimeInterval) throws -> (value: [String: Any], signature: Int) {
    let (a, id) = front(req)
    if let last = lastTree, last.app == id, Date().timeIntervalSince(last.at) <= maxAge { return (last.value, last.signature) }
    let all = req["all"] as? Bool ?? false
    var nodes: [[String: Any]] = []
    var windows: [[String: Any]] = []
    var hasher = Hasher()
    let root = try a.snapshot()
    let screen = root.frame.isEmpty ? CGRect(origin: .zero, size: XCUIScreen.main.screenshot().image.size) : root.frame
    windows.append(["type": "app", "title": root.label, "pkg": id])
    walk(root, parent: -1, window: 0, screen: screen, all: all, out: &nodes, hasher: &hasher, depth: 0)
    // System alerts (permissions, notifications) live in the shell, not in the app.
    if id != Self.shellId {
      let alert = app(Self.shellId).alerts.firstMatch
      if alert.exists, let snap = try? alert.snapshot() {
        windows.append(["type": "app", "title": snap.label, "pkg": Self.shellId])
        walk(snap, parent: -1, window: 1, screen: screen, all: all, out: &nodes, hasher: &hasher, depth: 0)
      }
    }
    let value: [String: Any] = ["windows": windows, "nodes": nodes]
    let signature = hasher.finalize()
    lastTree = (Date(), id, value, signature)
    return (value, signature)
  }

  private func walk(_ n: XCUIElementSnapshot, parent: Int, window: Int, screen: CGRect, all: Bool, out: inout [[String: Any]], hasher: inout Hasher, depth: Int, focused: Bool = false) {
    if depth > 80 { return }
    var index = parent
    let f = n.frame
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
      if !wrapper && (all || interactive || !label.isEmpty || !value.isEmpty || !ident.isEmpty) {
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
        hasher.combine(b)
        hasher.combine(label)
        hasher.combine(value)
        hasher.combine(flags)
        index = out.count
        out.append(o)
      }
    }
    for child in n.children {
      walk(child, parent: index, window: window, screen: screen, all: all, out: &out, hasher: &hasher, depth: depth + 1, focused: passFocus || (focused && index == parent))
    }
  }

  /// Whether a control with (nearly) the same frame sits within `depth` levels below (UIKit nests a cell's
  /// button four plain views deep).
  private static func wraps(_ n: XCUIElementSnapshot, frame f: CGRect, depth: Int) -> Bool {
    if depth == 0 { return false }
    for c in n.children {
      let g = c.frame
      let same = abs(g.minX - f.minX) < 2 && abs(g.minY - f.minY) < 2 && abs(g.maxX - f.maxX) < 2 && abs(g.maxY - f.maxY) < 2
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
  private func coordinate(_ req: [String: Any], x xKey: String = "x", y yKey: String = "y") -> XCUICoordinate {
    let (a, _) = front(req)
    return a.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: double(req, xKey, 0), dy: double(req, yKey, 0)))
  }
  #endif

  private func swipe(_ req: [String: Any]) throws -> [String: Any] {
    #if os(tvOS)
    throw RunnerError("tvOS has no touch — use key up/down/left/right")
    #else
    let from = coordinate(req, x: "x1", y: "y1")
    let to = coordinate(req, x: "x2", y: "y2")
    let dx = double(req, "x2", 0) - double(req, "x1", 0)
    let dy = double(req, "y2", 0) - double(req, "y1", 0)
    let seconds = max(0.05, double(req, "duration", 300) / 1000)
    let velocity = max(100, (dx * dx + dy * dy).squareRoot() / seconds)
    from.press(forDuration: 0.03, thenDragTo: to, withVelocity: XCUIGestureVelocity(CGFloat(velocity)), thenHoldForDuration: 0)
    return [:]
    #endif
  }

  private func text(_ req: [String: Any]) throws -> [String: Any] {
    let (a, _) = front(req)
    let text = req["text"] as? String ?? ""
    let field = a.descendants(matching: .any).element(matching: NSPredicate(format: "hasKeyboardFocus == true"))
    guard field.exists else { return ["set": false] }
    if !(req["append"] as? Bool ?? false) {
      let current = (field.value as? String) ?? ""
      if !current.isEmpty && current != (field.placeholderValue ?? "") {
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
      }
    }
    if !text.isEmpty { field.typeText(text) }
    return ["set": true]
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
    switch code {
    #if os(iOS)
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
}
