// The widget extension: draws the delivery Live Activity on the Lock Screen and in the Dynamic Island.

import ActivityKit
import SwiftUI
import WidgetKit

@main
struct ExampleWidgets: WidgetBundle {
  var body: some Widget {
    DeliveryActivity()
  }
}

struct DeliveryActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: DeliveryAttributes.self) { context in
      VStack(alignment: .leading) {
        Text("Order \(context.attributes.order)").font(.headline)
        Text(context.state.status)
        ProgressView(value: context.state.progress)
      }
      .padding()
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Text("Order \(context.attributes.order)") }
        DynamicIslandExpandedRegion(.trailing) { Text("\(Int(context.state.progress * 100))%") }
        DynamicIslandExpandedRegion(.bottom) { Text(context.state.status) }
      } compactLeading: {
        Text(context.attributes.order)
      } compactTrailing: {
        Text("\(Int(context.state.progress * 100))%")
      } minimal: {
        Text("\(Int(context.state.progress * 100))")
      }
    }
  }
}
