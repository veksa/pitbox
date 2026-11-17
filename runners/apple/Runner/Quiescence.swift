// XCUITest waits for the app to go quiet before and after every event and query it makes: its event loop idle and,
// unless told otherwise, its animations done. On iOS that wait is most of a tap's time and all of the time a keyboard
// takes to slide in, and the host settles on its own by comparing trees (`idle`), so the runner's own wait is the
// same work done twice. It is turned off by replacing XCUITest's wait (not public API) with one that returns at once,
// as WebDriverAgent does; a runner whose XCUITest lacks the method keeps waiting.

import ObjectiveC
import XCTest

enum Quiescence {
  private static let short = NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:")
  private static let long = NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:")
  private typealias Short = @convention(c) (AnyObject, Selector, Bool, Bool) -> Void
  private typealias Long = @convention(c) (AnyObject, Selector, Bool, Bool, Bool) -> Void
  /// XCUITest's own waits, kept for the places that still need them.
  private static var originalShort: IMP?
  private static var originalLong: IMP?
  /// Inside `waiting`: XCUITest waits as it always did.
  private static var restored = false

  static func skip() {
    #if os(iOS)
    guard originalLong == nil, let process = NSClassFromString("XCUIApplicationProcess") else { return }
    guard let a = class_getInstanceMethod(process, short), let b = class_getInstanceMethod(process, long) else { return }
    let shortWait: @convention(block) (AnyObject, Bool, Bool) -> Void = { process, animations, pre in
      if restored, let wait = originalShort { unsafeBitCast(wait, to: Short.self)(process, short, animations, pre) }
    }
    let longWait: @convention(block) (AnyObject, Bool, Bool, Bool) -> Void = { process, animations, activity, pre in
      if restored, let wait = originalLong { unsafeBitCast(wait, to: Long.self)(process, long, animations, activity, pre) }
    }
    originalShort = method_setImplementation(a, imp_implementationWithBlock(shortWait))
    originalLong = method_setImplementation(b, imp_implementationWithBlock(longWait))
    #endif
  }

  /// Waits, as XCUITest would before an event, until the app's event loop has idled and its animations are done. A
  /// control that is still animating in can drop a touch (an item of a context menu that is opening), and a screen
  /// still being built (a JS reload) takes the focus from a field typed into meanwhile: the tree is already still.
  static func beforeEvent(_ app: XCUIApplication) {
    guard let wait = originalLong, let process = app.perform(NSSelectorFromString("currentProcess"))?.takeUnretainedValue() else { return }
    unsafeBitCast(wait, to: Long.self)(process, long, true, false, true)
  }

  /// Runs `body` with XCUITest's waits as they were. Typing needs them: XCUITest waits for the app between the keys
  /// it types, and a controlled React Native input that re-renders on every key drops the keys that come faster.
  static func waiting<T>(_ body: () throws -> T) rethrows -> T {
    let was = restored
    restored = true
    defer { restored = was }
    return try body()
  }
}
