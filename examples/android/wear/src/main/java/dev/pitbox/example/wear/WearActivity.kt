package dev.pitbox.example.wear

import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.wear.ambient.AmbientLifecycleObserver

/** Says whether the watch is interactive or ambient, so a flow can check the transition. */
class WearActivity : ComponentActivity() {
  private lateinit var state: TextView
  private lateinit var served: TextView

  private val ambient = AmbientLifecycleObserver(
    this,
    object : AmbientLifecycleObserver.AmbientLifecycleCallback {
      override fun onEnterAmbient(ambientDetails: AmbientLifecycleObserver.AmbientDetails) {
        state.text = "ambient"
      }

      override fun onExitAmbient() {
        state.text = "interactive"
      }
    },
  )

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    lifecycle.addObserver(ambient)
    state = TextView(this).apply {
      id = R.id.ambient_state
      text = "interactive"
      textSize = 18f
      gravity = Gravity.CENTER
    }
    setContentView(
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        addView(TextView(this@WearActivity).apply {
          id = R.id.wear_title
          text = "pitbox wear"
          textSize = 20f
          gravity = Gravity.CENTER
        })
        addView(state)
        served = TextView(this@WearActivity).apply {
          id = R.id.complication_state
          gravity = Gravity.CENTER
        }
        addView(served)
      },
    )
  }

  override fun onResume() {
    super.onResume()
    val n = getSharedPreferences(PitboxComplicationService.PREFS, MODE_PRIVATE).getInt(PitboxComplicationService.SERVED, 0)
    served.text = if (n > 0) "complication served" else "complication not asked"
  }
}
