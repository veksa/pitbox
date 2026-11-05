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

/// Waits with the run loop going: AppKit learns of apps that start, quit and come to the front only through it.
func pause(_ seconds: TimeInterval) {
  RunLoop.current.run(until: Date().addingTimeInterval(max(0, seconds)))
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
    // Run as a block of the main run loop, not of the main dispatch queue: AppKit tells of apps that start and quit
    // through that queue, and a command that waits must let it run.
    let done = DispatchSemaphore(value: 0)
    CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) {
      let (out, finished) = commands.handle(req)
      reply(out)
      stop = finished
      done.signal()
    }
    CFRunLoopWakeUp(CFRunLoopGetMain())
    done.wait()
    if stop { break }
  }
  // stdin closed (the daemon went away) or `shutdown`.
  exit(0)
}

RunLoop.main.run()
