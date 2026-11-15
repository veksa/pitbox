package dev.pitbox.example.relay

import android.content.Context
import android.os.Handler
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import java.util.concurrent.TimeUnit

/** A ping from the other device: counted, and answered with a pong that carries the count. */
class PingService : WearableListenerService() {
  private lateinit var created: Handler

  // What a service usually does on creation, which the system's own start makes possible: a Handler needs the main
  // thread's looper, and the Application is there only for a service the system attached.
  override fun onCreate() {
    super.onCreate()
    created = Handler()
    checkNotNull(application) { "not attached by the system" }
  }

  override fun onMessageReceived(event: MessageEvent) {
    if (event.path != PING) return
    check(::created.isInitialized) { "onCreate did not run" }
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
