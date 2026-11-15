package dev.pitbox.connect

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import java.security.MessageDigest

/**
 * The device half of `pitbox device pair watch` between two emulators (see [PitboxWearable]): pitbox pairs the app,
 * forgets the pairing, and hands it the messages the other side sent.
 *
 * Reached by explicit component from `adb shell am broadcast`, guarded by the DUMP permission (held by the shell,
 * never by an installed app), present only in the library's debug variant, and checks the build is debuggable.
 *
 * Extras: `op` — `probe` (what the app has: Play services' Wearable classes, its message services, capabilities,
 * INTERNET, signing certificate), `pair` (`host`, `port`, `token`, `node`, `name`), `unpair`, `message` (`id` of a
 * message waiting in the daemon). The answer is the broadcast's result: code 1 and `ok …`, or 2 and `error …`.
 */
class PitboxWearReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!PitboxConnect.isDebuggable(context)) return answer(2, "error not-debuggable")
    if (!wearableLinked()) return answer(2, "error no-wearable: the app has no com.google.android.gms:play-services-wearable")
    when (intent.getStringExtra("op")) {
      "probe" -> answer(1, probe(context))
      "pair" -> {
        val port = intent.getStringExtra("port")?.toIntOrNull()
        val token = intent.getStringExtra("token")
        val node = intent.getStringExtra("node")
        if (port == null || token.isNullOrEmpty() || node.isNullOrEmpty()) return answer(2, "error bad-pair")
        PitboxWearable.savePairing(context, PitboxWearable.Pairing(intent.getStringExtra("host") ?: "10.0.2.2", port, token, node, intent.getStringExtra("name") ?: node))
        answer(1, "ok paired node=$node")
      }
      "unpair" -> answer(1, if (PitboxWearable.forget(context)) "ok unpaired" else "ok not-paired")
      "message" -> message(context, intent)
      else -> answer(2, "error unknown-op")
    }
  }

  private fun probe(context: Context): String {
    val internet = context.checkSelfPermission(Manifest.permission.INTERNET) == PackageManager.PERMISSION_GRANTED
    val services = listenerServices(context).joinToString(",") { it.substringAfterLast('.') }.ifEmpty { "-" }
    return "ok paired=${PitboxWearable.isPaired(context)} internet=$internet services=$services capabilities=${capabilities(context).joinToString(",").ifEmpty { "-" }} cert=${certificate(context)} sdk=${Build.VERSION.SDK_INT}"
  }

  /**
   * A message is waiting in the daemon (`id`): fetched over the app's own connection — no message content travels on
   * a command line —, then handed over the way Play services hands it: every listener the app added gets it, and
   * so does each `WearableListenerService` the app declares for `MESSAGE_RECEIVED` whose data filter matches the
   * path, brought up by the system (bound, as Play services binds it) even when nothing of the app was running. The
   * broadcast is finished as soon as the work is under way: a bound service keeps the process alive, so neither the
   * receiver's time limit nor a cold start delays the sender. What the app did goes back to the daemon's log.
   */
  private fun message(context: Context, intent: Intent) {
    val id = intent.getStringExtra("id")?.toIntOrNull() ?: return answer(2, "error bad-message")
    val pairing = PitboxWearable.pairing(context) ?: return answer(2, "error not-paired")
    val app = context.applicationContext
    val ordered = isOrderedBroadcast
    val pending = goAsync()
    Thread {
      var result = 1 to "ok accepted"
      try {
        val m = PitboxWearable.take(pairing, id)
        val event = PitboxMessageEvent(id, m.path, m.data, m.source)
        val heard = PitboxWearable.deliverToListeners(event)
        val names = messageServices(app, m.source, m.path)
        if (names.isEmpty()) {
          PitboxWearable.report(pairing, id, "listeners=$heard services=-")
        } else {
          val served = java.util.concurrent.ConcurrentLinkedQueue<String>()
          val left = java.util.concurrent.atomic.AtomicInteger(names.size)
          for (name in names) {
            bindService(app, name, event) { result ->
              served += result
              if (left.decrementAndGet() == 0) PitboxWearable.report(pairing, id, "listeners=$heard services=${served.joinToString(",")}")
            }
          }
        }
      } catch (e: Exception) {
        result = 2 to "error ${e.javaClass.simpleName}: ${e.message}"
      } finally {
        if (ordered) pending.setResult(result.first, result.second, null)
        pending.finish()
      }
    }.start()
  }

  private fun answer(code: Int, data: String) {
    if (isOrderedBroadcast) setResult(code, data, null)
  }

  companion object {
    private const val MESSAGE_RECEIVED = "com.google.android.gms.wearable.MESSAGE_RECEIVED"

    fun wearableLinked(): Boolean = try {
      Class.forName("com.google.android.gms.wearable.Wearable")
      true
    } catch (e: ClassNotFoundException) {
      false
    }

    /**
     * The app's services for MESSAGE_RECEIVED whose filter matches `wear://<source><path>`, the way Play services
     * resolves them (a filter without data matches no message since Play services 11).
     */
    fun messageServices(context: Context, source: String, path: String): List<String> {
      val intent = Intent(MESSAGE_RECEIVED).setPackage(context.packageName).setData(Uri.parse("wear://$source$path"))
      return context.packageManager.queryIntentServices(intent, 0)
        .map { it.serviceInfo }
        .filter { it.packageName == context.packageName }
        .map { if (it.name.startsWith(".")) context.packageName + it.name else it.name }
    }

    /** Every WearableListenerService the app declares, whatever its filters (an intent filter is not listed by path). */
    @Suppress("DEPRECATION")
    fun listenerServices(context: Context): List<String> = try {
      context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SERVICES).services.orEmpty()
        .map { if (it.name.startsWith(".")) context.packageName + it.name else it.name }
        .filter { name -> runCatching { WearableListenerService::class.java.isAssignableFrom(Class.forName(name)) }.getOrDefault(false) }
    } catch (e: Exception) {
      emptyList()
    }

    /**
     * Runs one listener service for one message: bound by the system with Play services' own action, so it is
     * created, attached and started on the main thread like any service (`getApplication()`, a `Handler()`, injection
     * all work), then given the message on its own looper thread, as WearableListenerService does, and unbound.
     * The service instance comes from the binder its `onBind` returns in this process, found by its field type.
     * `done` gets the service's short name, with the failure when it threw.
     */
    fun bindService(context: Context, name: String, event: MessageEvent, done: (String) -> Unit) {
      val short = name.substringAfterLast('.')
      val main = android.os.Handler(android.os.Looper.getMainLooper())
      val connection = object : android.content.ServiceConnection {
        private var finished = false

        private fun finish(result: String) {
          if (finished) return
          finished = true
          main.post { runCatching { context.unbindService(this) } }
          done(result)
        }

        override fun onServiceConnected(component: android.content.ComponentName, binder: android.os.IBinder?) {
          val service = binder?.let { listenerOf(it) } ?: return finish("$short(failed: no WearableListenerService behind its binder)")
          android.os.Handler(service.looper).post {
            val result = try {
              service.onMessageReceived(event)
              short
            } catch (e: Throwable) {
              "$short(failed: ${e.javaClass.simpleName} ${e.message})"
            }
            finish(result)
          }
        }

        override fun onServiceDisconnected(component: android.content.ComponentName) = finish("$short(failed: disconnected)")
        override fun onNullBinding(component: android.content.ComponentName) = finish("$short(failed: no binder for ${BIND_LISTENER})")
      }
      val intent = Intent(BIND_LISTENER).setComponent(android.content.ComponentName(context.packageName, name))
      val bound = try {
        context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
      } catch (e: Exception) {
        false
      }
      if (!bound) done("$short(failed: could not bind)")
    }

    private const val BIND_LISTENER = "com.google.android.gms.wearable.BIND_LISTENER"

    /** The WearableListenerService a binder from its `onBind` belongs to (a field of that type, whatever its name). */
    fun listenerOf(binder: Any): WearableListenerService? {
      var c: Class<*>? = binder.javaClass
      while (c != null && c != Any::class.java) {
        for (f in c.declaredFields) {
          if (WearableListenerService::class.java.isAssignableFrom(f.type)) {
            f.isAccessible = true
            return f.get(binder) as? WearableListenerService
          }
        }
        c = c.superclass
      }
      return null
    }

    /** The capabilities the app declares for the Data Layer (`res/values/wear.xml`, `android_wear_capabilities`). */
    fun capabilities(context: Context): List<String> {
      val id = context.resources.getIdentifier("android_wear_capabilities", "array", context.packageName)
      return if (id == 0) emptyList() else context.resources.getStringArray(id).toList()
    }

    /** The first 16 hex of the signing certificate's SHA-256: the Data Layer pairs only apps signed alike. */
    @Suppress("DEPRECATION")
    fun certificate(context: Context): String = try {
      val pm = context.packageManager
      val bytes = if (Build.VERSION.SDK_INT >= 28) {
        pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners?.firstOrNull()?.toByteArray()
      } else {
        pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures?.firstOrNull()?.toByteArray()
      }
      bytes?.let { MessageDigest.getInstance("SHA-256").digest(it).joinToString("") { b -> "%02x".format(b) }.take(16) } ?: "-"
    } catch (e: Exception) {
      "-"
    }
  }
}
