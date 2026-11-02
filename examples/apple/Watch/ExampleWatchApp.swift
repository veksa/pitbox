// The watch flavour of the example: the same ids on a screen small enough for a watch — no text field, a
// shorter list.

import SwiftUI

@main
struct ExampleWatchApp: App {
  var body: some Scene {
    WindowGroup { WatchView() }
  }
}

struct WatchView: View {
  @State private var greeting = ""
  @State private var response = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text("pitbox example").font(.headline).accessibilityIdentifier("title")
        Button("Greet") { greeting = "Hello, stranger" }.accessibilityIdentifier("greet")
        Text(greeting).accessibilityIdentifier("greeting")
        Button("Ask the stand") { Task { await ask() } }.accessibilityIdentifier("fetch")
        Text(response).accessibilityIdentifier("response")
        Button("Crash") {
          let rows: [Int] = []
          _ = rows[1]
        }.accessibilityIdentifier("crash")
        ForEach(1...20, id: \.self) { i in
          Text("Row \(i)").accessibilityIdentifier("row_\(i)")
        }
      }
    }
    .accessibilityIdentifier("content_list")
  }

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
