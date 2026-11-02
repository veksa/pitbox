// A blocking JSON-lines server on 127.0.0.1. A simulator shares the Mac's network, so the host connects
// straight to this port. Everything runs on the test's main thread: XCUITest calls must be made there.

import Darwin
import Foundation

struct RunnerError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

final class Server {
  private let listener: Int32

  init(port: UInt16) throws {
    listener = socket(AF_INET, SOCK_STREAM, 0)
    if listener < 0 { throw RunnerError("socket failed") }
    var yes: Int32 = 1
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if bound != 0 { throw RunnerError("bind on port \(port) failed: \(String(cString: strerror(errno)))") }
    if listen(listener, 4) != 0 { throw RunnerError("listen failed") }
  }

  /// Serves one client at a time until `handle` asks to stop.
  func serve(_ handle: ([String: Any]) -> (reply: [String: Any], stop: Bool)) {
    while true {
      let client = accept(listener, nil, nil)
      if client < 0 { continue }
      var noDelay: Int32 = 1
      setsockopt(client, IPPROTO_TCP, TCP_NODELAY, &noDelay, socklen_t(MemoryLayout<Int32>.size))
      var buffer = Data()
      var chunk = [UInt8](repeating: 0, count: 65536)
      var stop = false
      reading: while true {
        let n = recv(client, &chunk, chunk.count, 0)
        if n <= 0 { break }
        buffer.append(chunk, count: n)
        while let nl = buffer.firstIndex(of: 0x0A) {
          let line = buffer.subdata(in: buffer.startIndex..<nl)
          buffer.removeSubrange(buffer.startIndex...nl)
          guard let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
          let (reply, done) = handle(req)
          send(client, reply)
          if done {
            stop = true
            break reading
          }
        }
      }
      close(client)
      if stop { break }
    }
    close(listener)
  }

  private func send(_ client: Int32, _ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(0x0A)
    data.withUnsafeBytes { raw in
      var off = 0
      while off < raw.count {
        let n = Darwin.send(client, raw.baseAddress!.advanced(by: off), raw.count - off, 0)
        if n <= 0 { return }
        off += n
      }
    }
  }
}
