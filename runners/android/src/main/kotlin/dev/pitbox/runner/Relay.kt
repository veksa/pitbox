package dev.pitbox.runner

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * A device-side replacement for `adb reverse` on emulators: listens on the device's loopback and pipes each
 * connection to the host through the emulator's host alias (10.0.2.2). `adb reverse` sometimes lists its
 * forwards while carrying no data; the app cannot tell the difference between that and a dead server.
 */
object Relay {
  private val servers = ConcurrentHashMap<Int, ServerSocket>()

  fun start(ports: JSONArray, target: String): JSONObject {
    val started = JSONArray()
    val failed = JSONObject()
    for (i in 0 until ports.length()) {
      val port = ports.getInt(i)
      if (servers.containsKey(port)) {
        started.put(port)
        continue
      }
      try {
        val server = ServerSocket()
        server.reuseAddress = true
        server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 50)
        servers[port] = server
        thread(name = "relay-$port", isDaemon = true) { accept(server, target, port) }
        started.put(port)
      } catch (e: Exception) {
        failed.put(port.toString(), e.message ?: e.javaClass.simpleName)
      }
    }
    return JSONObject().put("relayed", started).put("failed", failed)
  }

  fun list(): JSONObject = JSONObject().put("relayed", JSONArray(servers.keys.sorted()))

  fun stopAll(): JSONObject {
    for (s in servers.values) runCatching { s.close() }
    servers.clear()
    return JSONObject().put("relayed", JSONArray())
  }

  private fun accept(server: ServerSocket, target: String, port: Int) {
    while (!server.isClosed) {
      val client = try { server.accept() } catch (e: Exception) { break }
      thread(name = "relay-$port-conn", isDaemon = true) {
        try {
          val upstream = Socket()
          upstream.connect(InetSocketAddress(target, port), 5000)
          client.tcpNoDelay = true
          upstream.tcpNoDelay = true
          val a = thread(isDaemon = true) { pipe(client.getInputStream(), upstream.getOutputStream(), upstream) }
          pipe(upstream.getInputStream(), client.getOutputStream(), client)
          a.join(1000)
          runCatching { upstream.close() }
        } catch (e: Exception) {
          // the host side is down: the client sees a closed connection, as with no server
        } finally {
          runCatching { client.close() }
        }
      }
    }
  }

  private fun pipe(from: InputStream, to: OutputStream, close: Socket) {
    val buf = ByteArray(32 * 1024)
    try {
      while (true) {
        val n = from.read(buf)
        if (n < 0) break
        to.write(buf, 0, n)
        to.flush()
      }
    } catch (e: Exception) {
      // either side went away
    } finally {
      runCatching { close.shutdownOutput() }
    }
  }
}
