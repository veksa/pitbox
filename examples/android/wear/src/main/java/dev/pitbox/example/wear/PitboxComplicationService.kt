package dev.pitbox.example.wear

import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

/** A short-text complication ("42"), for putting a data source on a watch face from a flow. */
class PitboxComplicationService : SuspendingComplicationDataSourceService() {
  override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData {
    // Counted, so the app can show that a watch face really asked this data source.
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    prefs.edit().putInt(SERVED, prefs.getInt(SERVED, 0) + 1).apply()
    return data()
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? = if (type == ComplicationType.SHORT_TEXT) data() else null

  private fun data() =
    ShortTextComplicationData.Builder(PlainComplicationText.Builder("42").build(), PlainComplicationText.Builder("pitbox").build()).build()

  companion object {
    const val PREFS = "pitbox"
    const val SERVED = "served"
  }
}
