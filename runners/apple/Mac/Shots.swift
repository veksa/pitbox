// Images of one window, reduced here: a downscaled JPEG, a brightness grid for visual comparison, and per-frame
// brightness and motion for media checks. The window comes from `screencapture`, so nothing else on the screen is
// in it. Rectangles come in points from the window's top left.

import AppKit
import ImageIO

enum Shots {
  static func run(_ cmd: String, _ req: [String: Any], window: CGWindowID, points: CGSize) throws -> [String: Any] {
    let num = { (k: String, d: Double) in (req[k] as? NSNumber)?.doubleValue ?? d }
    switch cmd {
    case "screenshot": return try jpeg(capture(window), scale: num("scale", 0.5), quality: num("quality", 70) / 100)
    case "png":
      let out = NSMutableData()
      guard let dest = CGImageDestinationCreateWithData(out, "public.png" as CFString, 1, nil) else { throw RunnerError("no png encoder") }
      CGImageDestinationAddImage(dest, try capture(window), nil)
      if !CGImageDestinationFinalize(dest) { throw RunnerError("png encoding failed") }
      return ["png": (out as Data).base64EncodedString()]
    case "fingerprint": return try fingerprint(window, points: points, cols: Int(num("cols", 54)), masks: rects(req["masks"]))
    default: return try frames(window, points: points, bounds: rects(req["bounds"].map { [$0] }).first, count: Int(num("count", 4)), interval: num("interval", 400) / 1000, size: Int(num("size", 32)))
    }
  }

  static func rects(_ v: Any?) -> [CGRect] {
    guard let list = v as? [[NSNumber]] else { return [] }
    return list.filter { $0.count == 4 }.map { b in CGRect(x: b[0].doubleValue, y: b[1].doubleValue, width: b[2].doubleValue - b[0].doubleValue, height: b[3].doubleValue - b[1].doubleValue) }
  }

  static func capture(_ window: CGWindowID) throws -> CGImage {
    let file = (NSTemporaryDirectory() as NSString).appendingPathComponent("pitbox-mac-\(getpid())-\(window).png")
    defer { try? FileManager.default.removeItem(atPath: file) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-l\(window)", "-t", "png", file]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0, let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
      throw RunnerError("could not take an image of the window (screencapture exited \(p.terminationStatus))\nhint: \(Host.screenHint())")
    }
    return image
  }

  private static func grey(_ cg: CGImage, crop: CGRect? = nil, cols: Int, rows: Int, masks: [CGRect] = []) throws -> [UInt8] {
    var source = cg
    if let crop {
      guard let c = cg.cropping(to: crop.intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))) else { throw RunnerError("bounds outside the window") }
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

  static func jpeg(_ cg: CGImage, scale: Double, quality: Double) throws -> [String: Any] {
    let w = max(1, Int(Double(cg.width) * scale)), h = max(1, Int(Double(cg.height) * scale))
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

  static func fingerprint(_ window: CGWindowID, points: CGSize, cols: Int, masks: [CGRect]) throws -> [String: Any] {
    let cg = try capture(window)
    let scale = CGFloat(cg.width) / max(1, points.width)
    let rows = max(1, Int(Double(cols) * Double(points.height) / Double(max(1, points.width))))
    let grid = try grey(cg, cols: cols, rows: rows, masks: masks.map { toPixels($0, scale) })
    return ["cols": cols, "rows": rows, "width": Int(points.width), "height": Int(points.height), "grid": grid.map { Int($0) }]
  }

  static func frames(_ window: CGWindowID, points: CGSize, bounds: CGRect?, count: Int, interval: TimeInterval, size: Int) throws -> [String: Any] {
    var luma: [Double] = [], diff: [Double] = []
    var prev: [UInt8]?
    for i in 0..<max(1, count) {
      if i > 0 { pause(interval) }
      let cg = try capture(window)
      let scale = CGFloat(cg.width) / max(1, points.width)
      let px = try grey(cg, crop: bounds.map { toPixels($0, scale) }, cols: size, rows: size)
      luma.append(Double(px.reduce(0) { $0 + Int($1) }) / Double(px.count))
      if let p = prev { diff.append(Double(zip(px, p).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(px.count)) }
      prev = px
    }
    return ["luma": luma, "diff": diff]
  }
}
