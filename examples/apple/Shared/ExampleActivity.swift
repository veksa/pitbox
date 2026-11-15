// The Live Activity the example shows: a delivery with a status and a progress. Shared by the app (which starts it)
// and the widget extension (which draws it).

#if canImport(ActivityKit) && os(iOS)
import ActivityKit

public struct DeliveryAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var status: String
    public var progress: Double

    public init(status: String, progress: Double) {
      self.status = status
      self.progress = progress
    }
  }

  public var order: String

  public init(order: String) {
    self.order = order
  }
}
#endif
