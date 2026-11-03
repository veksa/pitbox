// Screen images reduced on the device: a downscaled JPEG, a brightness grid for visual comparison, and
// per-frame brightness and motion for media checks. Rectangles come in screen points.

import ImageIO
import UIKit
import XCTest

enum Images {
  /// The app's window, where the screen's own screenshot is empty: on visionOS it is 1×1, and a visual check
  /// would always match. Set for each command that takes an image.
  static var window: XCUIElement?

  /// visionOS reports element bounds in a space of its own, not as places on the window's image.
  static func checkRegions(_ any: Bool) throws {
    if any && window != nil { throw RunnerError("a part of the window cannot be picked out on visionOS: element bounds are not places on its image — check the whole window") }
  }

  private static func screen() -> (cg: CGImage, points: CGSize) {
    let image = window?.screenshot().image ?? XCUIScreen.main.screenshot().image
    guard let cg = image.cgImage else { fatalError("screenshot has no bitmap") }
    return (cg, image.size)
  }

  /// Greyscale bitmap of `rect` (pixels of `cg`) drawn into `cols`×`rows`, masks (pixels) blacked out first.
  private static func grey(_ cg: CGImage, crop: CGRect? = nil, cols: Int, rows: Int, masks: [CGRect] = []) throws -> [UInt8] {
    var source = cg
    if let crop {
      guard let c = cg.cropping(to: crop.intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))) else { throw RunnerError("bounds outside the screen") }
      source = c
    }
    if !masks.isEmpty {
      guard let ctx = CGContext(data: nil, width: source.width, height: source.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw RunnerError("no bitmap context") }
      ctx.draw(source, in: CGRect(x: 0, y: 0, width: source.width, height: source.height))
      ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
      // CoreGraphics counts y from the bottom.
      for m in masks { ctx.fill(CGRect(x: m.minX, y: CGFloat(source.height) - m.maxY, width: m.width, height: m.height)) }
      guard let masked = ctx.makeImage() else { throw RunnerError("mask failed") }
      source = masked
    }
    var px = [UInt8](repeating: 0, count: cols * rows)
    let ok = px.withUnsafeMutableBytes { raw -> Bool in
      guard let ctx = CGContext(data: raw.baseAddress, width: cols, height: rows, bitsPerComponent: 8, bytesPerRow: cols, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
      ctx.interpolationQuality = .medium
      ctx.draw(source, in: CGRect(x: 0, y: 0, width: cols, height: rows))
      return true
    }
    if !ok { throw RunnerError("no grey context") }
    return px
  }

  private static func toPixels(_ r: CGRect, _ scale: CGFloat) -> CGRect {
    CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale)
  }

  /// Downscaled with CoreGraphics and encoded with ImageIO: UIKit's renderer does not exist on watchOS.
  static func jpeg(scale: Double, quality: Double) throws -> [String: Any] {
    let (cg, _) = screen()
    let w = max(1, Int(Double(cg.width) * scale))
    let h = max(1, Int(Double(cg.height) * scale))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw RunnerError("no bitmap context") }
    ctx.interpolationQuality = .medium
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let small = ctx.makeImage() else { throw RunnerError("downscale failed") }
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { throw RunnerError("no jpeg encoder") }
    CGImageDestinationAddImage(dest, small, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    if !CGImageDestinationFinalize(dest) { throw RunnerError("jpeg encoding failed") }
    return ["width": w, "height": h, "jpeg": (out as Data).base64EncodedString()]
  }

  static func fingerprint(cols: Int, masks: [CGRect]) throws -> [String: Any] {
    try checkRegions(!masks.isEmpty)
    let (cg, points) = screen()
    let scale = CGFloat(cg.width) / max(1, points.width)
    let rows = max(1, Int(Double(cols) * Double(points.height) / Double(points.width)))
    let grid = try grey(cg, cols: cols, rows: rows, masks: masks.map { toPixels($0, scale) })
    return ["cols": cols, "rows": rows, "width": Int(points.width), "height": Int(points.height), "grid": grid.map { Int($0) }]
  }

  static func frames(bounds: CGRect?, count: Int, interval: TimeInterval, size: Int) throws -> [String: Any] {
    try checkRegions(bounds != nil)
    var luma: [Double] = []
    var diff: [Double] = []
    var prev: [UInt8]?
    for i in 0..<max(1, count) {
      if i > 0 { Thread.sleep(forTimeInterval: interval) }
      let (cg, points) = screen()
      let scale = CGFloat(cg.width) / max(1, points.width)
      let px = try grey(cg, crop: bounds.map { toPixels($0, scale) }, cols: size, rows: size)
      luma.append(Double(px.reduce(0) { $0 + Int($1) }) / Double(px.count))
      if let p = prev { diff.append(Double(zip(px, p).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(px.count)) }
      prev = px
    }
    return ["luma": luma, "diff": diff]
  }
}
