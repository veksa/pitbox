package dev.pitbox.example.wear

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture

/** A tile with one line of text, for adding, showing and removing tiles from a flow. */
class PitboxTileService : TileService() {
  override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> =
    CallbackToFutureAdapter.getFuture { completer ->
      val text = LayoutElementBuilders.Text.Builder().setText("pitbox tile").build()
      completer.set(
        TileBuilders.Tile.Builder()
          .setResourcesVersion(RESOURCES)
          .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(text))
          .build(),
      )
      "tile"
    }

  override fun onTileResourcesRequest(requestParams: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
    CallbackToFutureAdapter.getFuture { completer ->
      completer.set(ResourceBuilders.Resources.Builder().setVersion(RESOURCES).build())
      "resources"
    }

  private companion object {
    const val RESOURCES = "1"
  }
}
