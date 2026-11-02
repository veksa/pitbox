package dev.pitbox.example

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.ContextMenu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** One screen with what a UI test needs: a field, buttons, a long list, a request to the stand, a crash. */
class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.main)

    // The window's shape, for checks on folding, rotation and resizing: measured from the laid-out window, which
    // follows every change, whether or not the activity is recreated.
    val shape = findViewById<TextView>(R.id.screen_shape)
    val root = findViewById<View>(android.R.id.content)
    root.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
      val d = resources.displayMetrics.density
      val w = v.width / d
      val h = v.height / d
      // The display's rotation from its natural orientation, which is landscape on many tablets.
      @Suppress("DEPRECATION") val turn = windowManager.defaultDisplay.rotation * 90
      val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
      val text = "${if (w >= 600) "wide" else "narrow"} ${if (w > h) "landscape" else "portrait"} r$turn ${if (night) "night" else "day"}"
      if (shape.text != text) shape.post { shape.text = text }
    }

    // A watch crown's events go to the focused view, and in touch mode nothing has focus: the scroller asks for it,
    // as Wear OS apps should.
    // Only on a watch: on a TV the first D-pad press must reach the first control, not the scroller.
    if (packageManager.hasSystemFeature(PackageManager.FEATURE_WATCH)) {
      findViewById<View>(R.id.main_screen).apply {
        isFocusableInTouchMode = true
        requestFocus()
      }
    }

    // A mouse pointer over the view, for hover checks.
    findViewById<TextView>(R.id.hover_target).setOnHoverListener { v, e ->
      if (e.actionMasked == MotionEvent.ACTION_HOVER_ENTER || e.actionMasked == MotionEvent.ACTION_HOVER_MOVE) (v as TextView).text = "hovered"
      false
    }
    // A right click opens the context menu.
    registerForContextMenu(findViewById(R.id.menu_target))

    val name = findViewById<EditText>(R.id.name)
    val greeting = findViewById<TextView>(R.id.greeting)
    findViewById<Button>(R.id.greet).setOnClickListener {
      greeting.text = "Hello, ${name.text.ifBlank { "stranger" }}"
    }

    val response = findViewById<TextView>(R.id.response)
    findViewById<Button>(R.id.fetch).setOnClickListener {
      response.text = "asking…"
      thread {
        val text = try {
          val c = URL("http://localhost:4100/hello").openConnection() as HttpURLConnection
          c.connectTimeout = 3000
          c.readTimeout = 3000
          c.inputStream.bufferedReader().use { it.readText() }
        } catch (e: Exception) {
          "failed: ${e.javaClass.simpleName}"
        }
        runOnUiThread { response.text = text }
      }
    }

    findViewById<Button>(R.id.crash).setOnClickListener {
      throw IllegalStateException("example crash")
    }

    // Rows below the fold, for scrolling to a target.
    val list = findViewById<LinearLayout>(R.id.content_list)
    for (i in 1..40) {
      list.addView(
        TextView(this).apply {
          text = "Row $i"
          textSize = 18f
          setPadding(0, 24, 0, 24)
          contentDescription = "row $i"
        },
      )
    }
  }

  override fun onCreateContextMenu(menu: ContextMenu, v: View, info: ContextMenu.ContextMenuInfo?) {
    menu.add(0, 1, 0, "Copy")
  }

  override fun onContextItemSelected(item: MenuItem): Boolean {
    findViewById<TextView>(R.id.menu_target).text = "copied"
    return true
  }
}
