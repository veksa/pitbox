package dev.pitbox.connect

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Process

/**
 * Handles `pitbox.<applicationId>://connect?devserver=host:port[&name=host:port…]` — scanned from a QR code or
 * opened by pitbox — saves the hosts and restarts the app on them. Does nothing in a non-debuggable build.
 */
class PitboxConnectActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val link = intent?.data
    if (link != null && PitboxConnect.isDebuggable(this)) {
      PitboxConnect.save(this, link)
      // A cold start, so the next process reads the new host before anything is loaded.
      packageManager.getLaunchIntentForPackage(packageName)?.let {
        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        startActivity(it)
      }
      finish()
      Process.killProcess(Process.myPid())
      return
    }
    finish()
  }
}
