// The runner's commands for a Mac app. Every request names the app (`app`, a bundle id) and may name a window
// (`win`: a title, part of one, `#2` for the second in the app's list, or `front`). Points are relative to that
// window's top left, so its image, its tree and its input agree as a phone's screen does.

import AppKit
import ApplicationServices

final class Commands {
  private var last: Tree?
  /// Apps asked to build their tree for an assistive client (WebKit and Chromium build it on request).
  private var asked = Set<pid_t>()

  init() {
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 3)
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
    case "permissions": return ["accessibility": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess(), "host": Host.name]
    case "pid":
      let app = try? running(req)
      return app.map { ["pid": Int($0.processIdentifier)] } ?? [:]
    case "terminate": return try terminate(req)
    case "relays": return ["relayed": [Int]()]
    default: break
    }
    try Host.needAccessibility()
    // An app that is gone (it crashed, it was quit) shows nothing rather than failing the read: the action that
    // ended it settles, and its crash comes back with it.
    if (cmd == "tree" || cmd == "idle" || cmd == "info") && windowless(req) {
      let screen = NSScreen.main?.frame.size ?? .zero
      switch cmd {
      case "tree": return ["windows": [["type": "app", "title": "not running", "pkg": req["app"] as? String ?? ""]], "nodes": [[String: Any]]()]
      case "idle": return ["idle": true]
      default: return ["width": Int(screen.width), "height": Int(screen.height), "platform": "macos", "version": runnerVersion, "window": "", "running": false]
      }
    }
    let t = try target(req)
    switch cmd {
    case "info":
      let (w, f) = try selected(t, req)
      return ["width": Int(f.width.rounded()), "height": Int(f.height.rounded()), "platform": "macos", "version": runnerVersion, "window": Ax.string(Ax.attr(w, kAXTitleAttribute))]
    case "windows": return ["windows": Ax.children(t.ax, kAXWindowsAttribute).map { describeWindow($0) }]
    case "tree": return try tree(t, req, maxAge: 0.05).value
    case "idle":
      do {
        return ["idle": try idle(t, req, quiet: double(req, "quiet", 300) / 1000, timeout: double(req, "timeout", 3000) / 1000)]
      } catch where windowless(req) {
        // The app lost its last window while it was watched (it crashed, it quit): nothing more will change.
        return ["idle": true]
      }
    case "focus": return try focus(t, req)
    case "foreground": return ["foreground": foreground(req, timeout: double(req, "timeout", 5000) / 1000)]
    case "activate":
      try Input.front(t)
      return [:]
    case "tap", "doubletap", "longpress": return try tap(cmd, t, req)
    case "swipe": return try swipe(t, req)
    case "mouse": return try mouse(t, req)
    case "text": return try text(t, req)
    case "key":
      let vk = CGKeyCode(double(req, "vk", -1))
      guard double(req, "vk", -1) >= 0 else { throw RunnerError("no Mac key for this key code") }
      try Input.front(t)
      Input.key(t, vk, flags: CGEventFlags(rawValue: UInt64(double(req, "flags", 0))))
      return [:]
    case "screenshot", "fingerprint", "frames", "png":
      try Host.needScreen()
      let (w, f) = try selected(t, req)
      guard let wid = Ax.windowID(w) else { throw RunnerError("the window has no window server id") }
      return try Shots.run(cmd, req, window: wid, points: f.size)
    case "touch", "touchnav", "rotary", "rotate": throw RunnerError("a Mac app has no \(cmd == "rotary" ? "crown" : cmd == "rotate" ? "rotation" : "touch screen") — use press, swipe (it scrolls) or mouse")
    default: throw RunnerError("unknown command: \(cmd)")
    }
  }

  private func double(_ req: [String: Any], _ key: String, _ fallback: Double) -> Double {
    (req[key] as? NSNumber)?.doubleValue ?? fallback
  }

  // MARK: the app and its windows

  /// Not running, or running with no window (a crash on its way, a quit in progress).
  private func windowless(_ req: [String: Any]) -> Bool {
    guard let app = try? running(req) else { return true }
    return Ax.children(AXUIElementCreateApplication(app.processIdentifier), kAXWindowsAttribute).isEmpty
  }

  private func running(_ req: [String: Any]) throws -> NSRunningApplication {
    guard let id = req["app"] as? String, !id.isEmpty else { throw RunnerError("no app: set the bundle id in mac.<name>.app") }
    // AppKit's view of a process that quit lags behind: the newest one that is still alive.
    let alive = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter { !$0.isTerminated && kill($0.processIdentifier, 0) == 0 }
    guard let app = alive.max(by: { ($0.launchDate ?? .distantPast) < ($1.launchDate ?? .distantPast) }) else {

      throw RunnerError("\(id) is not running\nhint: app action=open starts it")
    }
    return app
  }

  private func target(_ req: [String: Any]) throws -> Target {
    let app = try running(req)
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    if !asked.contains(app.processIdentifier) {
      asked.insert(app.processIdentifier)
      _ = Ax.set(ax, "AXManualAccessibility", kCFBooleanTrue)
    }
    return Target(app: app, ax: ax, id: req["app"] as? String ?? "")
  }

  private func describeWindow(_ w: AXUIElement) -> [String: Any] {
    let f = Ax.frame(w)
    var o: [String: Any] = ["title": Ax.string(Ax.attr(w, kAXTitleAttribute))]
    if !f.isNull { o["size"] = [Int(f.width), Int(f.height)] }
    if (Ax.attr(w, kAXMainAttribute) as? Bool) == true { o["main"] = true }
    if (Ax.attr(w, kAXMinimizedAttribute) as? Bool) == true { o["minimized"] = true }
    return o
  }

  /// The window a request is about: the named one, else the app's focused window, else its main one.
  private func selected(_ t: Target, _ req: [String: Any]) throws -> (AXUIElement, CGRect) {
    let all = Ax.children(t.ax, kAXWindowsAttribute)
    let want = (req["win"] as? String ?? "").trimmingCharacters(in: .whitespaces)
    let title = { (w: AXUIElement) in Ax.string(Ax.attr(w, kAXTitleAttribute)) }
    var hit: AXUIElement?
    if want.isEmpty || want == "front" {
      hit = (Ax.attr(t.ax, kAXFocusedWindowAttribute) as! AXUIElement?) ?? (Ax.attr(t.ax, kAXMainWindowAttribute) as! AXUIElement?)
      hit = hit ?? all.first { (Ax.attr($0, kAXMinimizedAttribute) as? Bool) != true }
      guard let w = hit else { throw RunnerError("\(t.name) has no window open") }
      return (w, Ax.frame(w))
    }
    if want.hasPrefix("#"), let n = Int(want.dropFirst()), n >= 1, n <= all.count {
      hit = all[n - 1]
    } else {
      hit = all.first { title($0).caseInsensitiveCompare(want) == .orderedSame } ?? all.first { title($0).localizedCaseInsensitiveContains(want) }
    }
    guard let w = hit else {
      let names = all.map { "\"\(title($0))\"" }.joined(separator: ", ")
      throw RunnerError("no window \"\(want)\" in \(t.name)\nhint: its windows: \(names.isEmpty ? "none" : names); window=front follows the one in front")
    }
    return (w, Ax.frame(w))
  }

  // MARK: tree

  private func tree(_ t: Target, _ req: [String: Any], maxAge: TimeInterval) throws -> Tree {
    let (w, f) = try selected(t, req)
    if let l = last, CFEqual(l.window, w), Date().timeIntervalSince(l.at) <= maxAge { return l }
    let tree = Tree(window: w, frame: f)
    // Open menus are above everything: listed first, as windows on top are.
    for menu in Ax.children(t.ax) where Ax.string(Ax.attr(menu, kAXRoleAttribute)) == "AXMenu" {
      tree.windows.append(["type": "menu", "title": "", "pkg": t.id])
      tree.walk(menu, parent: -1, window: tree.windows.count - 1, clip: .infinite, depth: 0, root: true)
    }
    tree.windows.append(["type": "app", "title": Ax.string(Ax.attr(w, kAXTitleAttribute)), "pkg": t.id])
    tree.walk(w, parent: -1, window: tree.windows.count - 1, clip: f, depth: 0, root: true)
    // The app's items in the menu bar (a status item) and the menus they have open.
    if let extras = Ax.attr(t.ax, "AXExtrasMenuBar") {
      let items = Ax.children(extras as! AXUIElement)
      if !items.isEmpty {
        tree.windows.append(["type": "menu bar", "title": "", "pkg": t.id])
        for item in items { tree.walk(item, parent: -1, window: tree.windows.count - 1, clip: .infinite, depth: 0) }
      }
    }
    // The app's other windows, one line each: pressing one brings it to the front.
    let others = Ax.children(t.ax, kAXWindowsAttribute).filter { !CFEqual($0, w) }
    if !others.isEmpty {
      tree.windows.append(["type": "other windows", "title": "", "pkg": "windows"])
      for o in others {
        let of = Ax.frame(o)
        guard !of.isNull else { continue }
        let title = Ax.string(Ax.attr(o, kAXTitleAttribute))
        var node: [String: Any] = ["p": -1, "w": tree.windows.count - 1, "c": "Window", "b": tree.rel(of), "f": "c", "t": title.isEmpty ? "untitled" : title]
        if (Ax.attr(o, kAXMinimizedAttribute) as? Bool) == true { node["d"] = "minimized" }
        tree.otherWindows[tree.nodes.count] = o
        tree.nodes.append(node)
        tree.elements.append(o)
        tree.hasher.combine(title)
      }
    }
    last = tree
    return tree
  }

  private func idle(_ t: Target, _ req: [String: Any], quiet: TimeInterval, timeout: TimeInterval) throws -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    var prev = try tree(t, req, maxAge: 0).hasher.finalize()
    while Date() < deadline {
      pause(min(quiet, max(0, deadline.timeIntervalSinceNow)))
      let next = try tree(t, req, maxAge: 0).hasher.finalize()
      if next == prev { return true }
      prev = next
    }
    return false
  }

  private func focus(_ t: Target, _ req: [String: Any]) throws -> [String: Any] {
    guard let e = Ax.attr(t.ax, kAXFocusedUIElementAttribute) else { return [:] }
    let (_, f) = try selected(t, req)
    let map = Ax.fetch(e as! AXUIElement)
    let ef = Ax.frame(map)
    guard !ef.isNull else { return [:] }
    let tree = Tree(window: e as! AXUIElement, frame: f)
    var o: [String: Any] = ["c": Ax.typeNames[Ax.string(map[kAXRoleAttribute])] ?? "Other", "b": tree.rel(ef)]
    let ident = [Ax.string(map[kAXIdentifierAttribute]), Ax.string(map["AXDOMIdentifier"])].first { !$0.isEmpty } ?? ""
    if !ident.isEmpty { o["id"] = ident }
    let label = Ax.string(map[kAXTitleAttribute])
    if !label.isEmpty { o["t"] = label }
    return ["input": o]
  }

  /// Waits for the app just launched to be in front with a window; the process is looked up again each time, as
  /// the one of a relaunch replaces the one that quit.
  private func foreground(_ req: [String: Any], timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if let t = try? target(req), Ax.frontPid() == t.pid && !Ax.children(t.ax, kAXWindowsAttribute).isEmpty { return true }
      pause(0.1)
    } while Date() < deadline
    return false
  }

  /// Quits the app as a person would, then for good when it does not go.
  private func terminate(_ req: [String: Any]) throws -> [String: Any] {
    guard let id = req["app"] as? String, !id.isEmpty else { throw RunnerError("no app") }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter { !$0.isTerminated }
    if apps.isEmpty { return ["running": false] }
    // Gone for the system too: launch services that still lists the app would hand an `open` to it as it dies.
    let gone = { apps.allSatisfy { kill($0.processIdentifier, 0) != 0 && $0.isTerminated } }

    let wait = { (s: TimeInterval) -> Bool in
      let end = Date().addingTimeInterval(s)
      while Date() < end { if gone() { return true }; pause(0.1) }
      return gone()
    }
    apps.forEach { $0.terminate() }
    if wait(double(req, "timeout", 5000) / 1000) { return ["running": false] }
    apps.forEach { $0.forceTerminate() }
    return ["running": !wait(3), "forced": true]
  }

  // MARK: input

  /// The live element the host aimed at: a node of the last tree with the same frame and id or label.
  private func aimed(_ t: Target, _ req: [String: Any]) throws -> (element: AXUIElement, node: [String: Any], window: String)? {
    guard let b = req["bounds"] as? [Double], b.count == 4 else { return nil }
    let ident = req["ident"] as? String ?? "", label = req["label"] as? String ?? ""
    let tree = try tree(t, req, maxAge: 2)
    for (i, n) in tree.nodes.enumerated() {
      guard let nb = n["b"] as? [Int], zip(nb, b).allSatisfy({ abs(Double($0) - $1) < 2 }) else { continue }
      let same = ident.isEmpty ? (n["t"] as? String == label || n["d"] as? String == label) : n["id"] as? String == ident
      if same {
        let w = tree.windows[n["w"] as? Int ?? 0]
        return (tree.elements[i], n, w["type"] as? String ?? "app")
      }
    }
    return nil
  }

  private func point(_ t: Target, _ req: [String: Any], x: String = "x", y: String = "y") throws -> CGPoint {
    let (_, f) = try selected(t, req)
    return CGPoint(x: f.minX + double(req, x, 0), y: f.minY + double(req, y, 0))
  }

  /// Brings the window a request is about above the app's others, so a point in it is not another window's.
  private func raise(_ t: Target, _ req: [String: Any]) throws {
    let (w, _) = try selected(t, req)
    if let focused = Ax.attr(t.ax, kAXFocusedWindowAttribute), CFEqual(focused, w) { return }
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    _ = Ax.set(w, kAXMainAttribute, kCFBooleanTrue)
    pause(0.15)
  }

  private func tap(_ cmd: String, _ t: Target, _ req: [String: Any]) throws -> [String: Any] {
    if let hit = try aimed(t, req) {
      // Another window of the app: brought to the front.
      if hit.window == "other windows" {
        try Input.front(t)
        _ = Ax.set(hit.element, kAXMinimizedAttribute, kCFBooleanFalse)
        AXUIElementPerformAction(hit.element, kAXRaiseAction as CFString)
        _ = Ax.set(hit.element, kAXMainAttribute, kCFBooleanTrue)
        return ["raised": true]
      }
      // A menu and a status item are pressed through the element: they are not under any window of the app.
      let role = Ax.string(Ax.attr(hit.element, kAXRoleAttribute))
      if cmd == "tap" && (role == "AXMenuItem" || role == "AXMenuBarItem") {
        try Input.front(t)
        // A menu bar item answers once its menu closes: the press is in when the call times out with the menu open.
        let r = AXUIElementPerformAction(hit.element, kAXPressAction as CFString)
        if r != .success && r != .cannotComplete { throw RunnerError("the menu item did not take a press (\(r.rawValue))") }
        return ["pressed": true]
      }
    }
    try Input.front(t)
    try raise(t, req)
    let p = try point(t, req)
    try Input.owns(t, p)
    switch cmd {
    case "doubletap": Input.click(p, count: 2)
    case "longpress": Input.click(p, hold: double(req, "hold", 800) / 1000)
    default: Input.click(p)
    }
    return [:]
  }

  /// A swipe on a Mac scrolls what is under its start by the distance travelled, as a trackpad does.
  private func swipe(_ t: Target, _ req: [String: Any]) throws -> [String: Any] {
    try Input.front(t)
    try raise(t, req)
    let p = try point(t, req, x: "x1", y: "y1")
    try Input.owns(t, p)
    let dx = double(req, "x2", 0) - double(req, "x1", 0), dy = double(req, "y2", 0) - double(req, "y1", 0)
    Input.scroll(at: p, dx: dx, dy: dy, seconds: min(0.6, double(req, "duration", 300) / 1000))
    return [:]
  }

  private func mouse(_ t: Target, _ req: [String: Any]) throws -> [String: Any] {
    try Input.front(t)
    try raise(t, req)
    let p = try point(t, req)
    try Input.owns(t, p)
    switch req["action"] as? String ?? "" {
    case "right": Input.click(p, button: .right)
    case "hover": Input.move(p)
    case "wheel": Input.wheel(at: p, lines: Int32(double(req, "amount", -1) * 3))
    default: throw RunnerError("mouse right|hover|wheel")
    }
    return [:]
  }

  /// The field to type into: the one the host aimed at by its frame, else the one with keyboard focus.
  private func field(_ t: Target, _ req: [String: Any]) throws -> AXUIElement? {
    if let b = req["bounds"] as? [Double], b.count == 4 {
      let tree = try tree(t, req, maxAge: 0)
      for (i, n) in tree.nodes.enumerated() where (n["f"] as? String ?? "").contains("e") {
        if let nb = n["b"] as? [Int], zip(nb, b).allSatisfy({ abs(Double($0) - $1) < 2 }) {
          let e = tree.elements[i]
          if (Ax.attr(e, kAXFocusedAttribute) as? Bool) != true { _ = Ax.set(e, kAXFocusedAttribute, kCFBooleanTrue) }
          return e
        }
      }
    }
    guard let e = Ax.attr(t.ax, kAXFocusedUIElementAttribute) else { return nil }
    let el = e as! AXUIElement
    let role = Ax.string(Ax.attr(el, kAXRoleAttribute))
    return Ax.editable.contains(role) || Ax.string(Ax.attr(el, kAXSubroleAttribute)) == "AXSearchField" ? el : nil
  }

  /// Text goes in as typed characters, each carrying its own string, so the keyboard layout in use (a Cyrillic
  /// one) cannot turn it into other letters. What the field holds is checked; when it is not the text (an input
  /// method took the keys, a secure field dropped them), the text goes in again through the pasteboard and ⌘V,
  /// and the pasteboard gets back what it held.
  private func text(_ t: Target, _ req: [String: Any]) throws -> [String: Any] {
    try Input.front(t)
    guard let field = try field(t, req) else { return ["set": false] }
    let text = req["text"] as? String ?? ""
    let append = req["append"] as? Bool ?? false
    let secure = Ax.string(Ax.attr(field, kAXSubroleAttribute)) == "AXSecureTextField"
    let read = { Ax.string(Ax.attr(field, kAXValueAttribute)) }
    let before = append ? read() : ""
    let want = before + text
    let holds = { () -> Bool in
      let v = read()
      return secure ? v.count == want.count : v == want
    }
    // Everything in the field selected, then deleted: through its selected range (no Select All menu needed),
    // else ⌘A.
    let clear = {
      let n = read().utf16.count
      if n > 0 {
        var range = CFRange(location: 0, length: n)
        if let v = AXValueCreate(.cfRange, &range), Ax.set(field, kAXSelectedTextRangeAttribute, v) {} else { Input.key(t, 0, flags: .maskCommand) }
        Input.key(t, 51)
      }
    }
    if !append { clear() }
    Input.type(t, text)
    if Input.settle(holds) { return ["set": true] }
    if !append { clear() } else if read().count > before.count {
      for _ in 0..<(read().count - before.count) { Input.key(t, 51) }
    }
    try Input.paste(t, text)
    if Input.settle(holds) { return ["set": true, "pasted": true] }
    let got = read()
    throw RunnerError(secure ? "the secure field holds \(got.count) characters, not \(want.count): neither typing nor a paste put the text in" : "the field holds \"\(got)\", not \"\(want)\": neither typing nor a paste put the text in")
  }
}
