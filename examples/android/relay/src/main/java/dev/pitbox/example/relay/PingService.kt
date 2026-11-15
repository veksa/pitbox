package dev.pitbox.example.relay

import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import java.util.concurrent.TimeUnit

/** A ping from the other device: counted, and answered with a pong that carries the count. */
class PingService : WearableListenerService() {
  override fun onMessageReceived(event: MessageEvent) {
    if (event.path != PING) return
    val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val n = prefs.getInt(COUNT, 0) + 1
    prefs.edit().putInt(COUNT, n).commit()
    // Off the main thread already, as Play services calls a listener service.
    Tasks.await(DataLayer.sendMessage(this, event.sourceNodeId, PONG, n.toString().toByteArray()), 10, TimeUnit.SECONDS)
  }

  companion object {
    const val PING = "/ping"
    const val PONG = "/pong"
    const val PREFS = "relay"
    const val COUNT = "pings"
  }
}
