package dev.pitbox.connect

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Base64
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Push emulation for debug builds: `pitbox push` hands a message to the app's own FirebaseMessagingService, the
 * way Google Play services does with a real FCM message, so expo-notifications, React Native Firebase or any
 * other FCM client behaves as it would in production — the foreground handler, the notification Firebase posts
 * itself while the app is in the background, the tap, data-only messages.
 *
 * Real FCM arrives as `com.google.android.c2dm.intent.RECEIVE` from Play services, a broadcast only a holder of
 * its signature may send. This receiver takes its place: it is reached by explicit component from `adb shell am
 * broadcast`, guarded by the DUMP permission (held by the shell, never by an installed app), enabled only in
 * debug builds (res/values/pitbox.xml) and checks the build is debuggable before it does anything.
 *
 * Extras: `op` (`deliver`, default; `clear` cancels the app's notifications; `probe` reports the service) and
 * `payload`, a base64 JSON object of string extras — the FCM wire format (`gcm.n.e`, `gcm.notification.title`,
 * `google.message_id`, data keys…). The answer is the broadcast's result: code 1 and `ok …`, or code 2 and
 * `error <reason> …`, which `am broadcast` prints.
 */
class PitboxPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!PitboxConnect.isDebuggable(context)) return answer(2, "error not-debuggable")
    when (intent.getStringExtra("op") ?: "deliver") {
      "probe" -> {
        val service = messagingService(context)
        answer(1, "ok service=${service?.className ?: "-"} firebase=${firebaseReady(context)} sdk=${Build.VERSION.SDK_INT} notifications=${notificationsEnabled(context)}")
      }
      "clear" -> {
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancelAll()
        answer(1, "ok cleared")
      }
      "deliver" -> deliver(context, intent)
      else -> answer(2, "error unknown-op")
    }
  }

  private fun deliver(context: Context, intent: Intent) {
    val service = messagingService(context) ?: return answer(2, "error no-fcm-service: the app declares no service for com.google.firebase.MESSAGING_EVENT (no FCM client library)")
    if (!firebaseReady(context)) return answer(2, "error firebase-not-initialized: FirebaseApp has no default app (google-services.json missing?) — a real FCM message could not reach this app either")
    val extras = try {
      val json = JSONObject(String(Base64.decode(intent.getStringExtra("payload") ?: "", Base64.DEFAULT), Charsets.UTF_8))
      json.keys().asSequence().associateWith { json.getString(it) }
    } catch (e: Exception) {
      return answer(2, "error bad-payload: ${e.message}")
    }
    val message = Intent(RECEIVE).setPackage(context.packageName)
    for ((k, v) in extras) message.putExtra(k, v)
    // Firebase reads a high-priority message from the broadcast's foreground flag.
    if (extras["google.delivered_priority"] == "high") message.addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
    // Play services broadcasts a message to every receiver of the app that listens for it, not only to
    // Firebase's: React Native Firebase, for one, takes its messages in a receiver of its own. Those get it here,
    // in the app's process, the way the system would call them.
    val others = mutableListOf<String>()
    for (name in otherReceivers(context)) {
      others += try {
        (Class.forName(name).getDeclaredConstructor().newInstance() as BroadcastReceiver).onReceive(context, Intent(message).setComponent(ComponentName(context.packageName, name)))
        name.substringAfterLast('.')
      } catch (e: Throwable) {
        "${name.substringAfterLast('.')}(failed: ${e.javaClass.simpleName} ${e.message})"
      }
    }
    val alsoTo = if (others.isEmpty()) "" else " receivers=${others.joinToString(",")}"
    val ordered = isOrderedBroadcast
    val pending = goAsync()
    Thread {
      val (code, data) = try {
        hand(context, message, service)
      } catch (e: Throwable) {
        2 to "error ${e.javaClass.simpleName}: ${(e.cause ?: e).message}"
      }
      if (ordered) pending.setResult(code, "$data$alsoTo notifications=${notificationsEnabled(context)}", null)
      pending.finish()
    }.start()
  }

  /**
   * What Firebase's own receiver (FirebaseInstanceIdReceiver) does with a message from Play services:
   * FcmBroadcastProcessor queues it for the messaging service and starts the service (a high-priority message)
   * or binds to it (a normal one, or when Android refuses the start). Older Firebase versions without the
   * processor get the same through ServiceStarter.
   */
  private fun hand(context: Context, message: Intent, service: ComponentName): Pair<Int, String> {
    val processor = try {
      Class.forName("com.google.firebase.messaging.FcmBroadcastProcessor")
    } catch (e: ClassNotFoundException) {
      null
    }
    if (processor != null) {
      val task = processor.getConstructor(Context::class.java).newInstance(context).let { processor.getMethod("process", Intent::class.java).invoke(it, message) }
      val tasks = Class.forName("com.google.android.gms.tasks.Tasks")
      val task0 = Class.forName("com.google.android.gms.tasks.Task")
      val result = tasks.getMethod("await", task0, Long::class.javaPrimitiveType, TimeUnit::class.java).invoke(null, task, 10L, TimeUnit.SECONDS) as Int
      return if (result == -1) 1 to "ok service=${service.className}" else 2 to "error service-start ${result}: Firebase could not start or bind ${service.className}"
    }
    val starter = Class.forName("com.google.firebase.messaging.ServiceStarter")
    val getInstance = starter.getDeclaredMethod("getInstance").apply { isAccessible = true }
    val result = starter.getMethod("startMessagingService", Context::class.java, Intent::class.java).invoke(getInstance.invoke(null), context, message) as Int
    return if (result == -1) 1 to "ok service=${service.className}" else 2 to "error service-start ${result}: Android refused to start ${service.className}"
  }

  private fun answer(code: Int, data: String) {
    if (isOrderedBroadcast) setResult(code, data, null)
  }

  companion object {
    private const val RECEIVE = "com.google.android.c2dm.intent.RECEIVE"
    private const val MESSAGING_EVENT = "com.google.firebase.MESSAGING_EVENT"
    private const val FIREBASE_RECEIVER = "com.google.firebase.iid.FirebaseInstanceIdReceiver"

    /** The service Firebase itself would start: the best match for MESSAGING_EVENT in the app's own package. */
    fun messagingService(context: Context): ComponentName? {
      val info = context.packageManager.resolveService(Intent(MESSAGING_EVENT).setPackage(context.packageName), 0)?.serviceInfo ?: return null
      if (info.packageName != context.packageName) return null
      val name = if (info.name.startsWith(".")) context.packageName + info.name else info.name
      return ComponentName(context.packageName, name)
    }

    /** The app's other receivers of FCM messages; Firebase's own one is what FcmBroadcastProcessor stands for. */
    fun otherReceivers(context: Context): List<String> =
      context.packageManager.queryBroadcastReceivers(Intent(RECEIVE).setPackage(context.packageName), 0)
        .map { it.activityInfo }
        .filter { it.packageName == context.packageName && it.name != FIREBASE_RECEIVER && it.name != PitboxPushReceiver::class.java.name }
        .map { if (it.name.startsWith(".")) context.packageName + it.name else it.name }

    /** Whether Firebase has its default app, without depending on Firebase. */
    fun firebaseReady(context: Context): Boolean = try {
      val app = Class.forName("com.google.firebase.FirebaseApp")
      (app.getMethod("getApps", Context::class.java).invoke(null, context) as List<*>).isNotEmpty()
    } catch (e: Exception) {
      false
    }

    fun notificationsEnabled(context: Context): Boolean =
      (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled()
  }
}
