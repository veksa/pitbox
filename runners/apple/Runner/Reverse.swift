// The Mac's ports on a physical device's loopback, as `adb reverse` gives them on Android. A simulator shares the
// Mac's network and needs none of it. An app's connection to 127.0.0.1:<port> on the device is taken here and paired
// with one of the idle connections the Mac keeps open to the `back` port (through usbmuxd, the only direction it
// carries); a line `<port>\n` tells the Mac where to connect on its side, then bytes flow both ways. Loopback, unlike
// the Mac's address on the network, needs no Local Network permission and is allowed in plain HTTP by
// NSAllowsLocalNetworking. Runs on threads of its own: the commands keep the main thread.

import Darwin
import Foundation

enum Reverse {
  private static let lock = NSCondition()
  /// Connections from the Mac waiting for an app's connection.
  private static var idle: [Int32] = []
  private static var listening: [Int: Int32] = [:]
  private static var back: UInt16 = 0
  /// How long an app's connection waits for the Mac to offer one before it is closed.
  private static let pairTimeout: TimeInterval = 10

  /// The ports relayed now, and the port the Mac's connections come to.
  static func state() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return ["ports": listening.keys.sorted(), "back": Int(back)]
  }

  /// Starts relaying `ports` (those not relayed yet); the `back` port is taken once, the first time.
  static func start(ports: [Int], back wanted: UInt16) throws -> [String: Any] {
    lock.lock()
    let needBack = back == 0
    lock.unlock()
    if needBack {
      let fd = try loopbackListener(wanted)
      lock.lock()
      back = wanted
      lock.unlock()
      Thread.detachNewThread { acceptBack(fd) }
    }
    var failed: [String] = []
    for port in ports {
      lock.lock()
      let has = listening[port] != nil
      lock.unlock()
      if has { continue }
      guard let p = UInt16(exactly: port) else { continue }
      do {
        let fd = try loopbackListener(p)
        lock.lock()
        listening[port] = fd
        lock.unlock()
        Thread.detachNewThread { acceptApps(fd, port: port) }
      } catch let e as RunnerError {
        failed.append(e.message)
      }
    }
    var out = state()
    if !failed.isEmpty { out["failed"] = failed }
    return out
  }

  static func loopbackListener(_ port: UInt16) throws -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { throw RunnerError("socket failed") }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if bound != 0 {
      let why = String(cString: strerror(errno))
      close(fd)
      throw RunnerError("bind on port \(port) failed: \(why)")
    }
    if listen(fd, 16) != 0 {
      close(fd)
      throw RunnerError("listen on port \(port) failed")
    }
    return fd
  }

  /// A write to a closed peer answers EPIPE instead of ending the runner with SIGPIPE.
  private static func prepare(_ fd: Int32) {
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, socklen_t(MemoryLayout<Int32>.size))
  }

  private static func acceptBack(_ listener: Int32) {
    while true {
      let fd = accept(listener, nil, nil)
      if fd < 0 { continue }
      prepare(fd)
      lock.lock()
      idle.append(fd)
      lock.signal()
      lock.unlock()
    }
  }

  private static func acceptApps(_ listener: Int32, port: Int) {
    while true {
      let fd = accept(listener, nil, nil)
      if fd < 0 { continue }
      prepare(fd)
      Thread.detachNewThread { pair(fd, port: port) }
    }
  }

  /// An idle connection from the Mac that is still open (one the Mac let go of reads as closed), or nil after the wait.
  private static func takeBack() -> Int32? {
    let deadline = Date().addingTimeInterval(pairTimeout)
    lock.lock()
    defer { lock.unlock() }
    while true {
      while let fd = idle.first {
        idle.removeFirst()
        var byte: UInt8 = 0
        let n = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
        if n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
          close(fd)
          continue
        }
        return fd
      }
      if !lock.wait(until: deadline) { return nil }
    }
  }

  private static func pair(_ app: Int32, port: Int) {
    guard let mac = takeBack() else {
      close(app)
      return
    }
    let head = Array("\(port)\n".utf8)
    guard writeAll(mac, head, head.count) else {
      close(app)
      close(mac)
      return
    }
    let done = DispatchGroup()
    for (from, to) in [(app, mac), (mac, app)] {
      done.enter()
      Thread.detachNewThread {
        copy(from, to)
        done.leave()
      }
    }
    done.wait()
    close(app)
    close(mac)
  }

  /// Copies until `from` ends, then ends the writing side of `to` (a half close, as HTTP may use).
  private static func copy(_ from: Int32, _ to: Int32) {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = recv(from, &buffer, buffer.count, 0)
      if n <= 0 || !writeAll(to, buffer, n) { break }
    }
    shutdown(to, SHUT_WR)
  }

  private static func writeAll(_ fd: Int32, _ bytes: [UInt8], _ count: Int) -> Bool {
    bytes.withUnsafeBytes { raw in
      var off = 0
      while off < count {
        let n = send(fd, raw.baseAddress!.advanced(by: off), count - off, 0)
        if n <= 0 { return false }
        off += n
      }
      return true
    }
  }
}
