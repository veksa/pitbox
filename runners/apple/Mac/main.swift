// pitbox's runner for a Mac app: the Apple runner's protocol (JSON lines in on stdin, out on stdout) over the
// Accessibility API instead of XCUITest. The daemon starts it as a child, so it runs with the permissions of the
// app that started pitbox (a terminal, an editor): Accessibility to read and drive the app, Screen Recording for
// images of its windows. Input goes to the target app only: it is brought to the front first, and when it does not
// come, the command fails instead of typing into whatever is in front.

import AppKit

/// Must match MAC_RUNNER_VERSION in src/drivers/mac/runner.ts.
let runnerVersion = 1

struct RunnerError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

setvbuf(stdout, nil, _IOLBF, 0)
let commands = Commands()

func reply(_ obj: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

// Lines are read off the main thread; commands run on it, with its run loop going, so AppKit's view of running
// apps stays current.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    var stop = false
    DispatchQueue.main.sync {
      let (out, done) = commands.handle(req)
      reply(out)
      stop = done
    }
    if stop { break }
  }
  // stdin closed (the daemon went away) or `shutdown`.
  exit(0)
}

RunLoop.main.run()
