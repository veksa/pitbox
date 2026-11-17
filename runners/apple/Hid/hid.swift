// Sends a Mac keyboard's keys to a booted simulator the way Xcode's device window does. Runs on the Mac (not inside
// the simulator) and talks to the simulator's HID service through SimulatorKit's legacy HID client.
//
//   hid <udid> key <usage>[+<usage>…] …   each argument a chord of USB HID keyboard usages (page 7, hex): the
//                                         usages go down in order and come up in reverse, like a person's fingers
//
// Why not XCUITest: on visionOS `typeKey` reaches UIKit's key commands but not the GameController framework, where
// a headset app reads the keyboard for its 3D content (an immersive space has no focused view). These events come
// from the simulator's own keyboard, as a person's would.
//
// The same client takes no game controller in Xcode 27: SimulatorKit builds the message
// (IndigoHIDMessageForGameControllerEvent) and the simulator accepts it, and nothing reaches the app's controller.

import Foundation
import ObjectiveC

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(2)
}

let args = CommandLine.arguments
guard args.count >= 4 else { fail("usage: hid <udid> key <usage>[+<usage>…] …") }
let developer = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] ?? "/Applications/Xcode.app/Contents/Developer"

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil else { fail("CoreSimulator is not installed") }
let kitPath = URL(fileURLWithPath: developer).deletingLastPathComponent().appendingPathComponent("SharedFrameworks/SimulatorKit.framework/SimulatorKit").path
guard let kit = dlopen(kitPath, RTLD_NOW) else { fail("this Xcode has no SimulatorKit at \(kitPath)") }

func symbol<T>(_ name: String, _ type: T.Type) -> T {
  guard let s = dlsym(kit, name) else { fail("this Xcode's SimulatorKit has no \(name)") }
  return unsafeBitCast(s, to: type)
}

typealias KeyMessage = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
let keyMessage = symbol("IndigoHIDMessageForKeyboardArbitrary", KeyMessage.self)

/// The simulator by its UDID, from the device set CoreSimulator keeps for this Xcode.
func device(_ udid: String) -> NSObject {
  guard let contextType = NSClassFromString("SimServiceContext") as? NSObject.Type else { fail("CoreSimulator has no SimServiceContext") }
  let shared = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
  typealias Shared = @convention(c) (AnyClass, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> NSObject?
  var error: NSError?
  guard let context = unsafeBitCast(method_getImplementation(class_getClassMethod(contextType, shared)!), to: Shared.self)(contextType, shared, developer as NSString, &error) else { fail("no simulator service: \(error?.localizedDescription ?? "?")") }
  let setSelector = NSSelectorFromString("defaultDeviceSetWithError:")
  typealias DeviceSet = @convention(c) (NSObject, Selector, UnsafeMutablePointer<NSError?>?) -> NSObject?
  guard let set = unsafeBitCast(context.method(for: setSelector), to: DeviceSet.self)(context, setSelector, &error) else { fail("no device set: \(error?.localizedDescription ?? "?")") }
  guard let id = UUID(uuidString: udid), let devices = set.value(forKey: "devicesByUDID") as? [UUID: NSObject], let d = devices[id] else { fail("no simulator \(udid)") }
  return d
}

/// The client that carries HID messages into the simulator; each `send` waits until the message is delivered.
final class Client {
  private let client: NSObject
  private let sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
  private let queue = DispatchQueue(label: "hid")

  init(_ device: NSObject) {
    guard let type = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") as? NSObject.Type else { fail("this Xcode's SimulatorKit has no HID client") }
    let initSelector = NSSelectorFromString("initWithDevice:error:")
    typealias Init = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>?) -> NSObject?
    var error: NSError?
    let allocated = type.perform(NSSelectorFromString("alloc"))!.takeUnretainedValue()
    guard let c = unsafeBitCast(class_getMethodImplementation(type, initSelector)!, to: Init.self)(allocated, initSelector, device, &error) else { fail("the simulator's HID service refused: \(error?.localizedDescription ?? "?")") }
    client = c
  }

  func send(_ message: UnsafeMutableRawPointer?) {
    guard let message else { fail("SimulatorKit made no message") }
    typealias Send = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, DispatchQueue?, (@convention(block) (NSError?) -> Void)?) -> Void
    let done = DispatchSemaphore(value: 0)
    var failure: NSError?
    unsafeBitCast(client.method(for: sendSelector), to: Send.self)(client, sendSelector, message, true, queue) { e in
      failure = e
      done.signal()
    }
    if done.wait(timeout: .now() + 5) == .timedOut { fail("the simulator did not take the HID message in 5 s") }
    if let failure { fail("the simulator refused the HID message: \(failure.localizedDescription)") }
  }
}

let client = Client(device(args[1]))
let pause = { (ms: Double) in _ = usleep(UInt32(ms * 1000)) }

switch args[2] {
case "key":
  for chord in args[3...] {
    let usages = chord.split(separator: "+").map { part -> UInt32 in
      guard let u = UInt32(part, radix: 16) else { fail("not a hex usage: \(part)") }
      return u
    }
    for u in usages { client.send(keyMessage(u, 1)) }
    pause(40)
    for u in usages.reversed() { client.send(keyMessage(u, 2)) }
    pause(60)
  }
default:
  fail("hid <udid> key <usage>[+<usage>…] …")
}
print("ok")
