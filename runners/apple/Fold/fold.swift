// Folds, unfolds and turns a foldable iPhone simulator the way Xcode's device window does. Runs inside the
// simulator (`simctl spawn`) with the entitlements in fold.entitlements, which a simulator binary carries in its
// __TEXT,__entitlements section.
//
//   fold hinge <degrees> [from] [seconds]   the hinge swings to `degrees` (0 shut, 180 flat) from where it was
//                                           (`from` when this simulator has not been folded by pitbox yet)
//   fold orient portrait|landscape-left|landscape-right|pud
//   fold swap [seconds]                     the lit screen changes over at once; the hinge is not touched, and
//                                           SpringBoard ignores motion inputs for ten seconds: the next hinge
//                                           or orient waits that out
//
// The hinge and the orientation are the simulator's motion inputs: the system's motion service reads them from a
// vendor-defined HID service (usage page 0xFF61, usage 91) as IOKit-serialized dictionaries, the same ones Xcode
// sends. The system then moves the app between the screens and Xcode's device window draws the new pose. Neither
// path reports a refusal, so the host checks the lit screen.

import Darwin
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(2)
}

func load(_ framework: String, _ name: String) -> NSObject {
  guard dlopen("/System/Library/PrivateFrameworks/\(framework).framework/\(framework)", RTLD_NOW) != nil,
        let type = NSClassFromString(name) as? NSObject.Type
  else { fail("this system has no \(name)") }
  return type.init()
}

func method(_ object: NSObject, _ name: String) -> (Selector, IMP) {
  let select = NSSelectorFromString(name)
  guard object.responds(to: select), let imp = object.method(for: select) else { fail("\(type(of: object)) has no \(name) on this system") }
  return (select, imp)
}

// MARK: motion inputs

/// IOKit's binary serialization (OSSerialize, 0xd3) of a dictionary of strings and doubles, in the shape the
/// motion service parses: keys as symbols, string values without their terminator, numbers as 64-bit words.
func serialize(_ entries: [(String, Any)]) -> Data {
  var d = Data()
  func word(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
  func text(_ s: String, type: UInt32, symbol: Bool, last: Bool) {
    let bytes = Array(s.utf8) + (symbol ? [0] : [])
    word(type << 24 | UInt32(bytes.count) | (last ? 0x8000_0000 : 0))
    d.append(contentsOf: bytes)
    while d.count % 4 != 0 { d.append(0) }
  }
  word(0xd3)
  word(0x0100_0000 | UInt32(entries.count) | 0x8000_0000)
  for (i, (key, value)) in entries.enumerated() {
    let last = i == entries.count - 1
    text(key, type: 0x08, symbol: true, last: false)
    if let n = value as? Double {
      word(0x0400_003f | (last ? 0x8000_0000 : 0))
      withUnsafeBytes(of: n.bitPattern.littleEndian) { d.append(contentsOf: $0) }
    } else {
      text("\(value)", type: 0x09, symbol: false, last: last)
    }
  }
  return d
}

func input(_ source: String, _ type: String, _ value: Any) -> Data {
  serialize([("source", source), ("type", type), ("provider", "com.apple.Virtualization.VirtualMachines"), ("value", value)])
}

/// Answers the event system's questions about the service: it matches the one the motion service listens to.
final class Motion: NSObject {
  let properties: [String: Any] = [
    "PrimaryUsagePage": 0xFF61, "PrimaryUsage": 91, "Transport": "CoreDevice", "Product": "pitbox motion",
    "DeviceUsagePairs": [["DeviceUsagePage": 0xFF61, "DeviceUsage": 91]], "UniversalControlVirtualService": true,
  ]
  @objc(propertyForKey:forService:) func property(forKey key: String, forService _: Any?) -> Any? { properties[key] }
  @objc(setProperty:forKey:forService:) func setProperty(_: Any?, forKey _: String, forService _: Any?) -> Bool { false }
  @objc(copyEventMatching:forService:) func copyEvent(matching _: Any?, forService _: Any?) -> Any? { nil }
  @objc(setOutputEvent:forService:) func setOutputEvent(_: Any?, forService _: Any?) -> Bool { false }
  @objc(notification:withProperty:forService:) func notification(_: Int, withProperty _: Any?, forService _: Any?) {}
}

typealias Dispatch = @convention(c) (AnyObject, Selector, AnyObject) -> Bool

/// Sends motion inputs 20 ms apart through a short-lived virtual HID service.
func send(_ inputs: [Data]) {
  let motion = Motion()
  let service = load("HID", "HIDVirtualEventService")
  service.setValue(motion, forKey: "delegate")
  service.perform(NSSelectorFromString("setDispatchQueue:"), with: DispatchQueue(label: "pitbox.motion"))
  service.perform(NSSelectorFromString("activate"))
  // The motion service picks a new HID service up asynchronously; events before that are lost.
  Thread.sleep(forTimeInterval: 1.0)
  let (select, imp) = method(service, "dispatchEvent:")
  for data in inputs {
    let event = data.withUnsafeBytes { IOHIDEventCreateVendorDefinedEvent(nil, mach_absolute_time(), 0xFF61, 91, 0, $0.bindMemory(to: UInt8.self).baseAddress!, data.count, 0) }
    guard let event, unsafeBitCast(imp, to: Dispatch.self)(service, select, event) else { fail("the HID event system refused the motion event") }
    Thread.sleep(forTimeInterval: 0.02)
  }
  Thread.sleep(forTimeInterval: 0.3)
  service.perform(NSSelectorFromString("cancel"))
  withExtendedLifetime(motion) {}
}

// MARK: state

/// What the next call has to know and the system will not say: the hinge angle cannot be read back, and the test
/// lock a swap takes (SpringBoard ignores motion inputs until it expires, without a word) cannot be released.
/// Kept in the simulator's temporary directory, so it ends with the simulator.
struct State: Codable {
  var angle: Double?
  var lockedUntil: Double?
}

let stateFile = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pitbox-fold.json")
var state = (try? JSONDecoder().decode(State.self, from: Data(contentsOf: stateFile))) ?? State()
func save() { try? JSONEncoder().encode(state).write(to: stateFile) }

func waitOutSwapLock() {
  let wait = (state.lockedUntil ?? 0) - Date().timeIntervalSince1970
  if wait > 0 { Thread.sleep(forTimeInterval: wait) }
}

// MARK: commands

typealias Reply = @convention(block) () -> Void
typealias Swap = @convention(c) (AnyObject, Selector, PitboxSwapSettings, @escaping Reply) -> Void

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "hinge":
  guard args.count > 1, let to = Double(args[1]), (0...180).contains(to) else { fail("hinge: degrees 0-180") }
  // The swing starts where the last one ended; the caller's guess serves when there was none.
  let from = state.angle ?? (args.count > 2 ? Double(args[2]) ?? to : to)
  let seconds = args.count > 3 ? Double(args[3]) ?? 0.8 : 0.8
  // Eased like Xcode's pose buttons, so the system sees a hinge in motion rather than a jump.
  let steps = from == to ? 0 : max(1, Int(seconds / 0.02))
  let angles = (0...steps).map { i in steps == 0 ? to : from + (to - from) * (0.5 - 0.5 * cos(Double.pi * Double(i) / Double(steps))) }
  waitOutSwapLock()
  send(angles.map { input("hinge-slider-control", "range", $0) })
  state.angle = to
  state.lockedUntil = nil
  save()
case "orient":
  let names = ["portrait", "landscape-left", "landscape-right", "pud"]
  guard args.count > 1, names.contains(args[1]) else { fail("orient: \(names.joined(separator: ", "))") }
  waitOutSwapLock()
  send([input("orientation-picker-control", "enum", args[1])])
case "swap":
  let service = load("SpringBoardServices", "SBSDisplayToolService")
  var settings = PitboxSwapSettings()
  settings.duration = args.count > 1 ? Double(args[1]) ?? 0.5 : 0.5
  settings.waitForCompletion = true
  let (select, imp) = method(service, "swapDisplayWithSettings:completion:")
  let started = Date().timeIntervalSince1970
  let done = DispatchSemaphore(value: 0)
  unsafeBitCast(imp, to: Swap.self)(service, select, settings) { done.signal() }
  let answered = done.wait(timeout: .now() + 30) == .success
  // The service object throws when it goes away still connected.
  service.perform(NSSelectorFromString("invalidate"))
  if !answered { fail("no answer from SpringBoard") }
  state.lockedUntil = started + 10.5
  save()
default:
  fail("usage: fold hinge <degrees> [from] [seconds] · fold orient <orientation> · fold swap [seconds]")
}
print("done")
