// Touches synthesized as one event record, the way XCUITest builds them inside `tap()`, without what `tap()` does
// around it: resolving the coordinate against a fresh snapshot of the app and waiting for the app to idle before and
// after. The classes are XCUITest's own and not public API (WebDriverAgent and Maestro drive them the same way); a
// runner whose XCUITest lacks them taps through `XCUICoordinate`.

import ObjectiveC
import XCTest

enum Events {
  private static let pathClass: AnyClass? = NSClassFromString("XCPointerEventPath")
  private static let recordClass: AnyClass? = NSClassFromString("XCSynthesizedEventRecord")

  /// Whether this XCUITest has everything a synthesized touch needs.
  static let available: Bool = {
    guard let path = pathClass, let record = recordClass else { return false }
    return ["initForTouchAtPoint:offset:", "liftUpAtOffset:"].allSatisfy { path.instancesRespond(to: NSSelectorFromString($0)) }
      && ["initWithName:interfaceOrientation:", "addPointerEventPath:", "synthesizeWithError:"].allSatisfy { record.instancesRespond(to: NSSelectorFromString($0)) }
  }()

  /// A new, uninitialised instance (`alloc`), owned by the caller, which initialises it with an `init…` method.
  private static func alloc(_ cls: AnyClass) -> NSObject {
    (cls as AnyObject).perform(NSSelectorFromString("alloc")).takeRetainedValue() as! NSObject
  }

  private static func method<T>(_ object: NSObject, _ name: String, as _: T.Type) -> (T, Selector) {
    let selector = NSSelectorFromString(name)
    return (unsafeBitCast(object.method(for: selector), to: T.self), selector)
  }

  /// One finger: down at `point` `at` seconds into the record, lifted `hold` seconds later.
  private static func touch(_ point: CGPoint, at offset: TimeInterval, hold: TimeInterval) -> NSObject {
    typealias Start = @convention(c) (NSObject, Selector, CGPoint, Double) -> NSObject
    typealias Lift = @convention(c) (NSObject, Selector, Double) -> Void
    let blank = alloc(pathClass!)
    let (start, startSel) = method(blank, "initForTouchAtPoint:offset:", as: Start.self)
    let path = start(blank, startSel, point, offset)
    let (lift, liftSel) = method(path, "liftUpAtOffset:", as: Lift.self)
    lift(path, liftSel, offset + hold)
    return path
  }

  /// `UIInterfaceOrientation.portrait`, spelled out: the type is unavailable on tvOS, where the runner builds too.
  private static let portrait = 1

  /// The app's interface orientation, which the record turns points with; portrait when XCUITest does not say.
  private static func orientation(of app: XCUIApplication) -> Int {
    guard app.responds(to: NSSelectorFromString("interfaceOrientation")) else { return portrait }
    let value = (app.value(forKey: "interfaceOrientation") as? NSNumber)?.intValue ?? 0
    return value == 0 ? portrait : value
  }

  /// `count` taps at a point of the app's screen (two: a double tap), each held `hold` seconds (a long press). False
  /// when this XCUITest cannot synthesize them: the caller taps through `XCUICoordinate`.
  static func tap(_ point: CGPoint, count: Int = 1, hold: TimeInterval = 0, in app: XCUIApplication) -> Bool {
    guard available else { return false }
    typealias Make = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
    typealias Add = @convention(c) (NSObject, Selector, NSObject) -> Void
    typealias Synthesize = @convention(c) (NSObject, Selector, UnsafeMutablePointer<NSError?>?) -> Bool
    let blank = alloc(recordClass!)
    let (make, makeSel) = method(blank, "initWithName:interfaceOrientation:", as: Make.self)
    let record = make(blank, makeSel, "pitbox" as NSString, orientation(of: app))
    let (add, addSel) = method(record, "addPointerEventPath:", as: Add.self)
    // Synthesis costs about 200 ms plus the touch's length: a tap is down for one frame. A double tap's second touch
    // comes well inside UIKit's double-tap interval.
    let down = max(hold, 0.02)
    for i in 0..<count { add(record, addSel, touch(point, at: Double(i) * (down + 0.1), hold: down)) }
    let (synthesize, synthesizeSel) = method(record, "synthesizeWithError:", as: Synthesize.self)
    return synthesize(record, synthesizeSel, nil)
  }
}
