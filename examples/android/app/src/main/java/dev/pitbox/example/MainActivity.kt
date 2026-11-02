package dev.pitbox.example

import android.app.Activity
import android.os.Bundle
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
}
