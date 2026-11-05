// The example Mac app for pitbox: a native window with what a UI test needs (a field, a secure field, buttons, a
// check box, a shortcut, a crash), a second window with a web page in a WKWebView (a field, a button, a long list),
// and an item in the menu bar with a menu. Ids match the other examples' where they mean the same.

import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
  var window: NSWindow!
  var web: NSWindow?
  var status: NSStatusItem!
  let name = NSTextField()
  let password = NSSecureTextField()
  let echo = NSTextField(labelWithString: "")
  let greeting = NSTextField(labelWithString: "")
  let count = NSTextField(labelWithString: "Count: 0")
  var counted = 0

  func applicationDidFinishLaunching(_ note: Notification) {
    let title = NSTextField(labelWithString: "pitbox example")
    title.font = .boldSystemFont(ofSize: 20)
    name.placeholderString = "Name"
    password.placeholderString = "Password"
    password.delegate = self
    let greet = NSButton(title: "Greet", target: self, action: #selector(greetTapped))
    let notify = NSButton(checkboxWithTitle: "Notify me", target: nil, action: nil)
    let openWeb = NSButton(title: "Open web page", target: self, action: #selector(openWebPage))
    let crash = NSButton(title: "Crash", target: self, action: #selector(crashTapped))
    for (view, id) in [(title, "title"), (name, "name"), (password, "password"), (echo, "password_echo"), (greet, "greet"), (greeting, "greeting"), (notify, "notify"), (count, "count"), (openWeb, "open_web"), (crash, "crash")] as [(NSView, String)] {
      view.setAccessibilityIdentifier(id)
    }
    let stack = NSStackView(views: [title, name, greet, greeting, password, echo, notify, count, openWeb, crash])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    name.widthAnchor.constraint(equalToConstant: 260).isActive = true
    password.widthAnchor.constraint(equalToConstant: 260).isActive = true
    window = NSWindow(contentRect: NSRect(x: 200, y: 300, width: 420, height: 440), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "PitboxExample"
    window.contentView = stack
    window.isReleasedWhenClosed = false
    window.makeKeyAndOrderFront(nil)

    // ⌘K counts: a shortcut that reaches the app through its menu, whatever the keyboard layout.
    let menu = NSMenu()
    let appItem = NSMenuItem()
    appItem.submenu = NSMenu()
    appItem.submenu!.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(appItem)
    let editItem = NSMenuItem()
    editItem.submenu = NSMenu(title: "Edit")
    for (t, a, k) in [("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] {
      editItem.submenu!.addItem(withTitle: t, action: a, keyEquivalent: k)
    }
    menu.addItem(editItem)
    let actions = NSMenuItem()
    actions.submenu = NSMenu(title: "Actions")
    actions.submenu!.addItem(withTitle: "Count", action: #selector(countUp), keyEquivalent: "k")
    menu.addItem(actions)
    // ⌘W closes the window in front, as in any Mac app.
    let windowItem = NSMenuItem()
    windowItem.submenu = NSMenu(title: "Window")
    windowItem.submenu!.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    menu.addItem(windowItem)
    NSApp.mainMenu = menu

    // An item in the menu bar, as a tray app has.
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    status.button?.title = "PX"
    status.button?.setAccessibilityIdentifier("status_item")
    let statusMenu = NSMenu()
    statusMenu.addItem(withTitle: "Say hi", action: #selector(sayHi), keyEquivalent: "")
    status.menu = statusMenu
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  func controlTextDidChange(_ note: Notification) {
    echo.stringValue = password.stringValue
  }

  @objc func greetTapped() { greeting.stringValue = "Hello, \(name.stringValue)" }

  @objc func sayHi() { greeting.stringValue = "Hi from the menu bar" }

  @objc func countUp() {
    counted += 1
    count.stringValue = "Count: \(counted)"
  }

  @objc func crashTapped() {
    let rows: [Int] = []
    print(rows[1])
  }

  @objc func openWebPage() {
    if let web {
      web.makeKeyAndOrderFront(nil)
      return
    }
    let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 460, height: 420))
    view.loadHTMLString(Self.page, baseURL: nil)
    let w = NSWindow(contentRect: NSRect(x: 660, y: 300, width: 460, height: 420), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    w.title = "Web page"
    w.contentView = view
    w.isReleasedWhenClosed = false
    w.makeKeyAndOrderFront(nil)
    web = w
  }

  static let page = """
  <!doctype html>
  <html><head><meta charset="utf-8"><style>
  body { font: 15px -apple-system; margin: 16px; }
  li { padding: 6px 0; }
  </style></head><body>
  <h2 id="web_title">Web page</h2>
  <input id="web_name" placeholder="Your name" aria-label="Your name">
  <button id="web_greet">Greet</button>
  <p id="web_greeting"></p>
  <p id="web_echo"></p>
  <ul id="web_list"></ul>
  <script>
  const list = document.getElementById('web_list');
  for (let i = 1; i <= 60; i++) {
    const li = document.createElement('li');
    li.id = 'web_row_' + i;
    li.textContent = 'Row ' + i;
    list.appendChild(li);
  }
  const field = document.getElementById('web_name');
  // What a framework's controlled field sees: input events, one per change.
  field.addEventListener('input', () => { document.getElementById('web_echo').textContent = 'Typed: ' + field.value; });
  document.getElementById('web_greet').addEventListener('click', () => {
    document.getElementById('web_greeting').textContent = 'Hello from the web, ' + field.value;
  });
  </script>
  </body></html>
  """
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
