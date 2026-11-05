// The Accessibility API as the runner reads it: the app under test, its windows, and one window's tree as the flat
// node list every pitbox runner answers with (parent indexes, short flags), in points from the window's top left.

import AppKit
import ApplicationServices

/// The window server's id of an AX window: the private call every window tool uses; there is no public one.
@_silgen_name("_AXUIElementGetWindow")
func axWindowID(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

enum Host {
  /// The app macOS asks about this process's permissions: the one that started pitbox (a terminal, an editor).
  /// A child inherits it, so this runner needs no grant of its own.
  static let name: String = {
    typealias Responsible = @convention(c) (pid_t) -> pid_t
    var pid = getpid()
    if let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") {
      pid = unsafeBitCast(sym, to: Responsible.self)(getpid())
    }
    var buf = [CChar](repeating: 0, count: 4096)
    if proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 {
      let path = String(cString: buf)
      if let app = path.components(separatedBy: "/").first(where: { $0.hasSuffix(".app") }) { return String(app.dropLast(4)) }
      return (path as NSString).lastPathComponent
    }
    return "the app that started pitbox"
  }()

  static func accessibilityHint() -> String {
    "System Settings › Privacy & Security › Accessibility → turn on \(name) (add it with + if it is not listed), then run again"
  }

  static func screenHint() -> String {
    "System Settings › Privacy & Security › Screen & System Audio Recording → turn on \(name), then quit and reopen \(name)"
  }

  static func needAccessibility() throws {
    if !AXIsProcessTrusted() { throw RunnerError("Accessibility is off for \(name), so pitbox cannot read or drive Mac apps\nhint: \(accessibilityHint())") }
  }

  static func needScreen() throws {
    if !CGPreflightScreenCaptureAccess() { throw RunnerError("Screen Recording is off for \(name), so pitbox cannot take images of windows\nhint: \(screenHint())") }
  }
}

/// The app the host names, running.
struct Target {
  let app: NSRunningApplication
  let ax: AXUIElement
  let id: String
  var pid: pid_t { app.processIdentifier }
  var name: String { app.localizedName ?? id }
}

enum Ax {
  static let keys: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    kAXIdentifierAttribute, "AXDOMIdentifier", kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute,
    kAXFocusedAttribute, kAXPlaceholderValueAttribute, kAXSelectedAttribute, kAXChildrenAttribute,
  ]

  /// Attributes of one element in one round trip; a missing one is nil.
  static func fetch(_ e: AXUIElement) -> [String: Any] {
    var out: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(e, keys as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success, let values = out as? [AnyObject] else { return [:] }
    var map: [String: Any] = [:]
    for (k, v) in zip(keys, values) {
      if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
      map[k] = v
    }
    return map
  }

  static func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
  }

  static func string(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let a = v as? NSAttributedString { return a.string }
    return ""
  }

  static func frame(_ map: [String: Any]) -> CGRect {
    var p = CGPoint.zero, s = CGSize.zero
    guard let pv = map[kAXPositionAttribute], let sv = map[kAXSizeAttribute] else { return .null }
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
  }

  static func frame(_ e: AXUIElement) -> CGRect {
    var map: [String: Any] = [:]
    map[kAXPositionAttribute] = attr(e, kAXPositionAttribute)
    map[kAXSizeAttribute] = attr(e, kAXSizeAttribute)
    return frame(map)
  }

  static func children(_ e: AXUIElement, _ name: String = kAXChildrenAttribute) -> [AXUIElement] {
    (attr(e, name) as? [AXUIElement]) ?? []
  }

  static func windowID(_ w: AXUIElement) -> CGWindowID? {
    var id: CGWindowID = 0
    return axWindowID(w, &id) == .success && id != 0 ? id : nil
  }

  static func set(_ e: AXUIElement, _ name: String, _ value: AnyObject) -> Bool {
    AXUIElementSetAttributeValue(e, name as CFString, value) == .success
  }

  /// The app in front, as the window server sees it now (AppKit's own view lags behind its run loop).
  static func frontPid() -> pid_t? {
    if let app = attr(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute) {
      var pid: pid_t = 0
      if AXUIElementGetPid(app as! AXUIElement, &pid) == .success { return pid }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
  }

  static func appName(_ pid: pid_t?) -> String {
    guard let pid else { return "nothing" }
    return NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)"
  }

  // MARK: the tree

  static let typeNames: [String: String] = [
    "AXButton": "Button", "AXStaticText": "Text", "AXTextField": "TextField", "AXTextArea": "TextView",
    "AXComboBox": "TextField", "AXImage": "Image", "AXCheckBox": "CheckBox", "AXRadioButton": "RadioButton",
    "AXLink": "Link", "AXScrollArea": "ScrollView", "AXTable": "Table", "AXOutline": "Table", "AXList": "List",
    "AXRow": "Cell", "AXCell": "Cell", "AXGroup": "Group", "AXWebArea": "WebView", "AXHeading": "Text",
    "AXSlider": "Slider", "AXTabGroup": "TabBar", "AXToolbar": "Toolbar", "AXSheet": "Sheet", "AXWindow": "Window",
    "AXMenu": "Menu", "AXMenuItem": "MenuItem", "AXMenuBarItem": "MenuItem", "AXPopUpButton": "PopUpButton",
    "AXMenuButton": "MenuButton", "AXProgressIndicator": "ProgressIndicator", "AXBusyIndicator": "ActivityIndicator",
    "AXIncrementor": "Stepper", "AXDisclosureTriangle": "Button", "AXDateField": "TextField", "AXSplitGroup": "Group",
  ]
  static let tappable: Set<String> = ["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXDisclosureTriangle", "AXIncrementor", "AXRow", "AXSlider"]
  static let editable: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXDateField"]
  static let checkable: Set<String> = ["AXCheckBox", "AXRadioButton"]
  /// The traffic lights: four lines on every snapshot that say nothing about the app (⌘W closes a window).
  static let chrome: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]
  /// Parts of a table that repeat its rows or draw it.
  static let skipped: Set<String> = ["AXColumn", "AXScrollBar", "AXValueIndicator", "AXSplitter", "AXGrowArea", "AXMenuBar"]
}

/// One read of the app: its nodes, the live elements behind them, and what the host needs to place them.
final class Tree {
  var nodes: [[String: Any]] = []
  var elements: [AXUIElement] = []
  var windows: [[String: Any]] = []
  /// Elements of the windows list (other windows of the app), by node index.
  var otherWindows: [Int: AXUIElement] = [:]
  var hasher = Hasher()
  let origin: CGPoint
  let at = Date()
  let window: AXUIElement
  let size: CGSize
  static let limit = 3000

  init(window: AXUIElement, frame: CGRect) {
    self.window = window
    origin = frame.origin
    size = frame.size
  }

  func rel(_ f: CGRect) -> [Int] {
    [Int((f.minX - origin.x).rounded()), Int((f.minY - origin.y).rounded()), Int((f.maxX - origin.x).rounded()), Int((f.maxY - origin.y).rounded())]
  }

  var value: [String: Any] {
    ["windows": windows, "nodes": nodes, "size": [Int(size.width.rounded()), Int(size.height.rounded())]]
  }

  func walk(_ e: AXUIElement, parent: Int, window: Int, clip: CGRect, depth: Int, root: Bool = false) {
    if depth > 60 || nodes.count >= Tree.limit { return }
    let map = Ax.fetch(e)
    let role = Ax.string(map[kAXRoleAttribute])
    let subrole = Ax.string(map[kAXSubroleAttribute])
    if Ax.skipped.contains(role) || Ax.chrome.contains(subrole) { return }
    let f = Ax.frame(map)
    let sized = !f.isNull && f.width > 0 && f.height > 0
    // Off screen or scrolled away: the subtree is too (a zero-sized group passes its children on). A group's own
    // frame is not trusted for its children: a web view's wrapper reports one far from where its page is drawn.
    let outside = sized && !f.intersects(clip)
    if outside && role != "AXGroup" { return }
    var index = parent
    if !root && sized && !outside {
      let title = Ax.string(map[kAXTitleAttribute])
      let desc = Ax.string(map[kAXDescriptionAttribute])
      let rawValue = map[kAXValueAttribute]
      let value = Ax.string(rawValue)
      let ident = [Ax.string(map[kAXIdentifierAttribute]), Ax.string(map["AXDOMIdentifier"])].first { !$0.isEmpty } ?? ""
      let placeholder = Ax.string(map[kAXPlaceholderValueAttribute])
      let secure = subrole == "AXSecureTextField"
      let isEditable = Ax.editable.contains(role) || subrole == "AXSearchField"
      let tappable = Ax.tappable.contains(role)
      let scrollable = role == "AXScrollArea"
      var c = Ax.typeNames[role] ?? "Other"
      if role == "AXCheckBox" && subrole == "AXSwitch" { c = "Switch" }
      if role == "AXRadioButton" && subrole == "AXTabButton" { c = "Tab" }
      if secure { c = "SecureTextField" }
      if subrole == "AXSearchField" { c = "SearchField" }
      var o: [String: Any] = ["p": parent, "w": window, "c": c, "b": rel(f)]
      if !ident.isEmpty { o["id"] = ident }
      if isEditable {
        if !value.isEmpty { o["t"] = secure ? String(repeating: "•", count: min(value.count, 12)) : value }
        if !placeholder.isEmpty { o["h"] = placeholder }
        let label = title.isEmpty ? desc : title
        if !label.isEmpty { o["d"] = label }
      } else {
        // Static text carries its words as its value; a control, as its title.
        let text = !title.isEmpty ? title : Ax.checkable.contains(role) ? desc : !value.isEmpty ? value : desc
        if !text.isEmpty { o["t"] = text }
        if !desc.isEmpty && desc != text { o["d"] = desc }
      }
      var flags = ""
      if tappable { flags += "c" }
      if tappable || isEditable { flags += "f" }
      if (map[kAXFocusedAttribute] as? Bool) == true { flags += "F" }
      if isEditable { flags += "e" }
      if scrollable { flags += "s" }
      if Ax.checkable.contains(role) { flags += ((rawValue as? NSNumber)?.intValue ?? 0) != 0 ? "X" : "x" }
      if (map[kAXSelectedAttribute] as? Bool) == true { flags += "S" }
      if (map[kAXEnabledAttribute] as? Bool) == false { flags += "d" }
      if secure { flags += "p" }
      if !flags.isEmpty { o["f"] = flags }
      if tappable || isEditable || scrollable || o["t"] != nil || o["d"] != nil || o["id"] != nil {
        index = nodes.count
        nodes.append(o)
        elements.append(e)
        hasher.combine(o["b"] as? [Int] ?? [])
        hasher.combine(o["t"] as? String ?? "")
        hasher.combine(flags)
      }
      // A text field's insides (its text, a clear button's image) are the field.
      if isEditable && role != "AXComboBox" { return }
    }
    let inner = (role == "AXScrollArea" || role == "AXWebArea") && sized ? clip.intersection(f) : clip
    for child in (map[kAXChildrenAttribute] as? [AXUIElement]) ?? [] {
      walk(child, parent: index, window: window, clip: inner, depth: depth + 1)
    }
  }
}
