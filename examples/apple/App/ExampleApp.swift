// The example app for pitbox's Apple side: one screen with what a UI test needs — a field, buttons, a long
// list, a request to the stand, a crash — and a deep link target. Ids match the Android example's.

import SwiftUI

@main
struct ExampleApp: App {
  @State private var detail: String?

  var body: some Scene {
    WindowGroup {
      Group {
        if let detail {
          DetailView(id: detail) { self.detail = nil }
        } else {
          MainView()
        }
      }
      // pitboxexample://detail/<id> — the deep link target for `goto`.
      .onOpenURL { url in
        if url.host == "detail" { detail = url.lastPathComponent }
      }
    }
  }
}

struct MainView: View {
  @State private var name = ""
  @State private var greeting = ""
  @State private var response = ""
  @State private var hovered = false
  @State private var copied = false
  @State private var shortcut = ""

  var body: some View {
    GeometryReader { g in
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("pitbox example").font(.title).accessibilityIdentifier("title")
        // What only some devices do: turning (phones, tablets), a pointer and a keyboard (tablets).
        Text(g.size.width > g.size.height ? "landscape" : "portrait").accessibilityIdentifier("orientation")
        #if os(iOS)
        Text(hovered ? "hovered" : "hover here").accessibilityIdentifier("hover_target").onHover { hovered = $0 }
        Button("Shortcut ⌘K") { shortcut = "shortcut pressed" }.keyboardShortcut("k", modifiers: .command).accessibilityIdentifier("shortcut")
        Text(shortcut).accessibilityIdentifier("shortcut_result")
        #endif
        #if !os(tvOS)
        Text(copied ? "copied" : "menu here").accessibilityIdentifier("menu_target").contextMenu { Button("Copy") { copied = true } }
        #endif
        TextField("Your name", text: $name).accessibilityIdentifier("name")
        Button("Greet") { greeting = "Hello, \(name.isEmpty ? "stranger" : name)" }.accessibilityIdentifier("greet")
        Text(greeting).accessibilityIdentifier("greeting")
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

  /// The stand runs on the Mac, and a simulator shares the Mac's network: localhost is the stand.
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
