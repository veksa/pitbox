package dev.pitbox.example

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/** Opened by `pitboxexample://detail/<id>`: the deep link target for `goto`. */
class DetailActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(
      TextView(this).apply {
        id = R.id.detail_screen
        text = "Detail ${intent?.data?.lastPathSegment ?: "?"}"
        textSize = 28f
        setPadding(48, 160, 48, 48)
      },
    )
  }
}
