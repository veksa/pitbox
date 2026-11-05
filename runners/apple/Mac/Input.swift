// Input for a Mac app, and the rule it never breaks: nothing is sent unless the app is in front. Keys and text are
// posted to the app's process, so even a window that comes up meanwhile does not get them; a pointer event goes to
// a point only when the window there is the app's.

import AppKit
import ApplicationServices

enum Input {
  /// A private event source: the keys a person holds on the real keyboard do not mix into these events.
  static let source = CGEventSource(stateID: .privateState)

  /// Brings the app to the front, or fails without sending anything.
  static func front(_ t: Target) throws {
    if Ax.frontPid() == t.pid { return }
    let was = Ax.frontPid()
    _ = Ax.set(t.ax, kAXFrontmostAttribute, kCFBooleanTrue)
    if waitFront(t, 1.0) { return }
    t.app.activate(options: [.activateAllWindows])
    if waitFront(t, 1.5) { return }
    throw RunnerError("\(t.name) is not in front (\(Ax.appName(Ax.frontPid() ?? was)) is) and did not come forward: nothing was sent\nhint: close what keeps it from the front (a modal panel, a full-screen app on this display) and run again")
  }

  private static func waitFront(_ t: Target, _ seconds: TimeInterval) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    repeat {
      if Ax.frontPid() == t.pid {
        // The window server needs a moment to order the app's windows in front.
        pause(0.1)
        return true
      }
      pause(0.05)
    } while Date() < end
    return false
  }

  /// What is at a point (global, top-left origin) must be the app's. Asked of the Accessibility API, which hit-tests
  /// as a click would: a window that lets clicks through (the Dock keeps one over the whole screen) is not in the way.
  static func owns(_ t: Target, _ p: CGPoint) throws {
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let hit {
      var pid: pid_t = 0
      if AXUIElementGetPid(hit, &pid) == .success {
        if pid == t.pid { return }
        throw RunnerError("a window of \(Ax.appName(pid)) is over \(t.name) at that point: nothing was sent\nhint: move it away or close it")
      }
    }
    throw RunnerError("no window of \(t.name) at that point (\(Int(p.x)),\(Int(p.y)) on the screen): nothing was sent")
  }

  private static func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, clicks: Int = 1) {
    guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    e.post(tap: .cghidEventTap)
  }

  static func move(_ p: CGPoint) {
    mouse(.mouseMoved, p)
    pause(0.03)
  }

  static func click(_ p: CGPoint, button: CGMouseButton = .left, count: Int = 1, hold: TimeInterval = 0.04) {
    let (down, up): (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
    move(p)
    for n in 1...max(1, count) {
      mouse(down, p, button, clicks: n)
      pause(hold)
      mouse(up, p, button, clicks: n)
      if n < count { pause(0.06) }
    }
  }

  /// Scrolls the view under `p` by a swipe's distance, in a few steps over `seconds`, as a trackpad does.
  static func scroll(at p: CGPoint, dx: Double, dy: Double, seconds: Double) {
    move(p)
    let steps = 8
    for _ in 0..<steps {
      guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy / Double(steps)), wheel2: Int32(dx / Double(steps)), wheel3: 0) else { return }
      e.location = p
      e.post(tap: .cghidEventTap)
      pause(max(0.01, seconds / Double(steps)))
    }
  }

  /// Wheel notches over `p`; positive lines scroll toward the top.
  static func wheel(at p: CGPoint, lines: Int32) {
    move(p)
    guard let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0) else { return }
    e.location = p
    e.post(tap: .cghidEventTap)
  }

  /// A key by its key code (the place on the keyboard, whatever the layout), posted to the app's process only.
  static func key(_ t: Target, _ vk: CGKeyCode, flags: CGEventFlags = []) {
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: down) else { continue }
      e.flags = flags
      e.postToPid(t.pid)
    }
    pause(0.02)
  }

  /// Characters as key events that carry their own text. Return and tab go as their keys.
  static func type(_ t: Target, _ text: String) {
    for ch in text {
      if ch == "\n" || ch == "\r" { key(t, 36); continue }
      if ch == "\t" { key(t, 48); continue }
      let units = Array(String(ch).utf16)
      for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
        e.flags = []
        e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        e.postToPid(t.pid)
      }
      pause(0.008)
    }
  }

  /// Puts the text in through the pasteboard and ⌘V; the pasteboard gets back what it held.
  static func paste(_ t: Target, _ text: String) throws {
    let board = NSPasteboard.general
    let saved: [NSPasteboardItem] = (board.pasteboardItems ?? []).map { item in
      let copy = NSPasteboardItem()
      for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
      return copy
    }
    board.clearContents()
    board.setString(text, forType: .string)
    // V's key code, which is ⌘V on every layout: shortcuts are read from a Latin layout.
    key(t, 9, flags: .maskCommand)
    // The app reads the pasteboard when it handles the event, a moment later.
    pause(0.3)
    board.clearContents()
    if !saved.isEmpty { board.writeObjects(saved) }
  }

  /// Waits a moment for a check to hold: an app handles posted events on its own run loop.
  static func settle(_ check: () -> Bool, _ seconds: TimeInterval = 1.2) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    repeat {
      if check() { return true }
      pause(0.05)
    } while Date() < end
    return check()
  }
}
