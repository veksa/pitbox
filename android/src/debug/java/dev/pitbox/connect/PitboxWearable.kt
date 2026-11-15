package dev.pitbox.connect

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Status
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * The Wearable Data Layer between two emulators that `pitbox device pair watch` paired, for debug builds.
 *
 * A real Data Layer connection needs the companion app from the Play Store and a Google account on both devices;
 * emulators on a stand have neither. pitbox stands in: once it has paired a phone emulator and a watch emulator,
 * these calls answer with the peer it paired and carry messages through the pitbox daemon (to the host at
 * `10.0.2.2`, so the app needs the INTERNET permission). The other side gets them the way Play services hands them
 * over: in the listeners added here, and in the app's own `WearableListenerService` declared for
 * `MESSAGE_RECEIVED` with a matching path, woken in a process that was not running.
 *
 * On a device pitbox has not paired, every call is Play services' own (`Wearable.get…Client`), so a debug build
 * behaves as before on a real phone and watch. The signatures match Play services' clients and return its own
 * types (`Task`, `Node`, `CapabilityInfo`), so an app routes its few calls here in its debug source set
 * (`typealias DataLayer = dev.pitbox.connect.PitboxWearable`) and to `Wearable` in its release one.
 *
 * Needs `com.google.android.gms:play-services-wearable` in the app, which an app with a Data Layer has anyway.
 * Data items, channels and remote activities are not relayed.
 */
object PitboxWearable {
  /** The Data Layer status code for a node that is not connected (`WearableStatusCodes.TARGET_NODE_NOT_CONNECTED`). */
  const val TARGET_NODE_NOT_CONNECTED = 4000

  private const val FILE = "pitbox-wear.json"
  private const val TIMEOUT_MS = 5_000
  private val io = Executors.newCachedThreadPool { Thread(it, "pitbox-wear").apply { isDaemon = true } }
  private val main = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArrayList<MessageClient.OnMessageReceivedListener>()

  /** Whether pitbox has paired this device (and this is a debug build): the calls below then go through pitbox. */
  @JvmStatic
  fun isPaired(context: Context): Boolean = pairing(context) != null

  /** `NodeClient.getConnectedNodes`: the device pitbox paired, or none while the daemon does not answer. */
  @JvmStatic
  fun connectedNodes(context: Context): Task<List<Node>> {
    val p = pairing(context) ?: return Wearable.getNodeClient(context).connectedNodes
    return call(p, JSONObject().put("op", "nodes"), offline = { emptyList() }) { reply -> peers(reply).map { PitboxNode(it.getString("id"), it.getString("name")) } }
  }

  /** `NodeClient.getLocalNode`: this device as pitbox named it. */
  @JvmStatic
  fun localNode(context: Context): Task<Node> {
    val p = pairing(context) ?: return Wearable.getNodeClient(context).localNode
    return Tasks.forResult(PitboxNode(p.node, p.name))
  }

  /**
   * `MessageClient.sendMessage`: the request id once the peer's device has the message, or an [ApiException] with
   * [TARGET_NODE_NOT_CONNECTED] for a node pitbox did not pair or a daemon that does not answer.
   */
  @JvmStatic
  fun sendMessage(context: Context, nodeId: String, path: String, data: ByteArray?): Task<Int> {
    val p = pairing(context) ?: return Wearable.getMessageClient(context).sendMessage(nodeId, path, data)
    val body = JSONObject().put("op", "send").put("node", nodeId).put("path", path).put("data", Base64.encodeToString(data ?: ByteArray(0), Base64.NO_WRAP))
    return call(p, body) { it.getInt("id") }
  }

  /** `CapabilityClient.getCapability`: the paired device when its app declares the capability (`android_wear_capabilities`). */
  @JvmStatic
  fun getCapability(context: Context, capability: String, filter: Int): Task<CapabilityInfo> {
    val p = pairing(context) ?: return Wearable.getCapabilityClient(context).getCapability(capability, filter)
    return call(p, JSONObject().put("op", "nodes"), offline = { PitboxCapability(capability, emptySet()) }) { reply ->
      val nodes = peers(reply).filter { n ->
        val caps = n.optJSONArray("capabilities")
        caps != null && (0 until caps.length()).any { caps.getString(it) == capability }
      }.map { PitboxNode(it.getString("id"), it.getString("name")) }.toSet<Node>()
      PitboxCapability(capability, nodes)
    }
  }

  /**
   * `MessageClient.addListener`: added both here and to Play services, so it hears messages pitbox relays as well as
   * real ones, whichever comes first — also when pitbox pairs the device after the listener was added.
   */
  @JvmStatic
  fun addListener(context: Context, listener: MessageClient.OnMessageReceivedListener): Task<Void> {
    if (!listeners.contains(listener)) listeners += listener
    return Wearable.getMessageClient(context).addListener(listener)
  }

  @JvmStatic
  fun removeListener(context: Context, listener: MessageClient.OnMessageReceivedListener): Task<Boolean> {
    listeners -= listener
    return Wearable.getMessageClient(context).removeListener(listener)
  }

  // --- The receiver's side ---------------------------------------------------------------------------------------

  /** What `op=pair` saved: where the daemon listens, the token that names this side, and this device's node. */
  internal class Pairing(val host: String, val port: Int, val token: String, val node: String, val name: String)

  internal fun pairing(context: Context): Pairing? {
    if (!PitboxConnect.isDebuggable(context)) return null
    val file = file(context)
    if (!file.exists()) return null
    return try {
      val j = JSONObject(file.readText())
      Pairing(j.getString("host"), j.getInt("port"), j.getString("token"), j.getString("node"), j.getString("name"))
    } catch (e: Exception) {
      null
    }
  }

  internal fun savePairing(context: Context, p: Pairing) {
    file(context).writeText(JSONObject().put("host", p.host).put("port", p.port).put("token", p.token).put("node", p.node).put("name", p.name).toString())
  }

  internal fun forget(context: Context): Boolean = file(context).delete()

  /** Kept out of backups: a restored pairing would point at a daemon that is long gone. */
  private fun file(context: Context) = File(context.noBackupFilesDir, FILE)

  /** Hands a relayed message to the listeners added here, on the main thread as Play services does. */
  internal fun deliverToListeners(event: MessageEvent): Int {
    val now = listeners.toList()
    if (now.isNotEmpty()) main.post { for (l in now) runCatching { l.onMessageReceived(event) } }
    return now.size
  }

  // --- The daemon ------------------------------------------------------------------------------------------------

  /** One request, one connection: a JSON line out, a JSON line back. Fails the task like Play services would. */
  private fun peers(reply: JSONObject): List<JSONObject> {
    val all = reply.getJSONArray("nodes")
    return (0 until all.length()).map { all.getJSONObject(it) }
  }

  /** `offline` answers a daemon that is gone (no connection, so no nodes); without it the task fails. */
  private fun <T> call(p: Pairing, body: JSONObject, offline: (() -> T)? = null, read: (JSONObject) -> T): Task<T> {
    val source = TaskCompletionSource<T>()
    io.execute {
      try {
        val reply = Socket().use { s ->
          s.connect(InetSocketAddress(p.host, p.port), TIMEOUT_MS)
          s.soTimeout = TIMEOUT_MS
          s.getOutputStream().write((body.put("token", p.token).toString() + "\n").toByteArray(Charsets.UTF_8))
          s.getOutputStream().flush()
          JSONObject(s.getInputStream().bufferedReader(Charsets.UTF_8).readLine() ?: throw IllegalStateException("no answer"))
        }
        if (!reply.optBoolean("ok")) {
          source.setException(ApiException(Status(reply.optInt("code", TARGET_NODE_NOT_CONNECTED), "pitbox: ${reply.optString("error")}")))
        } else {
          source.setResult(read(reply))
        }
      } catch (e: Exception) {
        // A socket without the INTERNET permission fails with EACCES: a build problem, never hidden as "no nodes".
        if (e is SecurityException || e.message?.contains("EACCES") == true) {
          source.setException(ApiException(Status(TARGET_NODE_NOT_CONNECTED, "pitbox: the app lacks the INTERNET permission the relay needs")))
        } else if (offline != null) {
          source.setResult(offline())
        } else {
          source.setException(ApiException(Status(TARGET_NODE_NOT_CONNECTED, "pitbox: the daemon at ${p.host}:${p.port} does not answer (${e.javaClass.simpleName})")))
        }
      }
    }
    return source.task
  }
}

internal data class PitboxNode(private val id: String, private val name: String) : Node {
  override fun getId(): String = id
  override fun getDisplayName(): String = name
  override fun isNearby(): Boolean = true
}

internal data class PitboxCapability(private val name: String, private val nodes: Set<Node>) : CapabilityInfo {
  override fun getName(): String = name
  override fun getNodes(): Set<Node> = nodes
}

internal class PitboxMessageEvent(private val requestId: Int, private val path: String, private val data: ByteArray, private val source: String) : MessageEvent {
  override fun getRequestId(): Int = requestId
  override fun getPath(): String = path
  override fun getData(): ByteArray = data
  override fun getSourceNodeId(): String = source
}
