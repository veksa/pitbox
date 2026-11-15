package dev.pitbox.connect

import android.Manifest
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Base64
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
 * INTERNET, signing certificate), `pair` (`host`, `port`, `token`, `node`, `name`), `unpair`, `message` (`source`,
 * `path`, `data` base64, `id`). The answer is the broadcast's result: code 1 and `ok …`, or 2 and `error …`.
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
   * What Play services does with a message for this app: every listener the app added gets it, and so does each
   * `WearableListenerService` the app declares for `MESSAGE_RECEIVED` whose data filter matches the path — started
   * in this process even when nothing of the app was running (this broadcast started it).
   */
  private fun message(context: Context, intent: Intent) {
    val source = intent.getStringExtra("source") ?: return answer(2, "error bad-message")
    val path = intent.getStringExtra("path") ?: return answer(2, "error bad-message")
    val data = try {
      Base64.decode(intent.getStringExtra("data") ?: "", Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      return answer(2, "error bad-message: ${e.message}")
    }
    if (!PitboxWearable.isPaired(context)) return answer(2, "error not-paired")
    val event = PitboxMessageEvent(intent.getStringExtra("id")?.toIntOrNull() ?: 0, path, data, source)
    val heard = PitboxWearable.deliverToListeners(event)
    val names = messageServices(context, source, path)
    val ordered = isOrderedBroadcast
    val pending = goAsync()
    // Play services calls a listener service off the main thread; the broadcast waits for it (within its 10 s).
    Thread {
      val served = names.map { name -> runService(context, name, event) }
      if (ordered) pending.setResult(1, "ok listeners=$heard services=${served.joinToString(",").ifEmpty { "-" }}", null)
      pending.finish()
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
     * Runs one listener service for one message the way the system would bring it up for Play services' bind: a
     * new instance on the app's context, `onCreate`, `onMessageReceived`, `onDestroy`. Answers its short name, with
     * the failure when it threw.
     */
    fun runService(context: Context, name: String, event: MessageEvent): String {
      val short = name.substringAfterLast('.')
      return try {
        val service = Class.forName(name).getDeclaredConstructor().newInstance() as Service
        ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java).apply { isAccessible = true }.invoke(service, context.applicationContext)
        service.onCreate()
        try {
          (service as WearableListenerService).onMessageReceived(event)
        } finally {
          runCatching { service.onDestroy() }
        }
        short
      } catch (e: Throwable) {
        val cause = (e as? java.lang.reflect.InvocationTargetException)?.targetException ?: e
        "$short(failed: ${cause.javaClass.simpleName} ${cause.message})"
      }
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
