// The app the UI test bundle is attached to. It does nothing: the runner drives other apps by bundle id.

import SwiftUI

@main
struct HostApp: App {
  var body: some Scene {
    WindowGroup {
      Text("pitbox runner host")
    }
  }
}
