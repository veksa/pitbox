package dev.pitbox.runner

import android.app.Instrumentation
import android.app.UiAutomation
import android.os.Bundle
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * Entry point: `am instrument -w -e port 7912 dev.pitbox.runner/.RunnerInstrumentation`.
 *
 * Serves newline-delimited JSON on the device's loopback: one request per line (`{"id":1,"cmd":"tree",...}`),
 * one answer per line (`{"id":1,"ok":true,...}`). The host reaches it through `adb forward`. The instrumentation
 * stays alive until it gets `shutdown` or the host kills it.
 */
class RunnerInstrumentation : Instrumentation() {
  private var port = DEFAULT_PORT
  @Volatile private var running = true

  override fun onCreate(arguments: Bundle?) {
    super.onCreate(arguments)
    port = arguments?.getString("port")?.toIntOrNull() ?: DEFAULT_PORT
    start()
  }

  override fun onStart() {
    val automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
    val commands = Commands(this, automation)
    commands.configure()
    try {
      ServerSocket(port, 4, InetAddress.getByName("127.0.0.1")).use { server ->
        Log.i(TAG, "listening on $port")
        // The host waits for this line on the instrumentation's output before it connects.
        sendStatus(0, Bundle().apply { putString("pitbox", "ready $port") })
        while (running) {
          val socket = server.accept()
          serve(socket, commands)
        }
      }
    } catch (e: Exception) {
      Log.e(TAG, "runner stopped", e)
    }
    finish(0, Bundle())
  }

  private fun serve(socket: Socket, commands: Commands) {
    socket.use { s ->
      s.tcpNoDelay = true
      val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
      val writer = PrintWriter(s.getOutputStream().bufferedWriter(Charsets.UTF_8), false)
      while (running) {
        val line = reader.readLine() ?: break
        if (line.isBlank()) continue
        val reply = JSONObject()
        try {
          val req = JSONObject(line)
          reply.put("id", req.opt("id"))
          val cmd = req.getString("cmd")
          if (cmd == "shutdown") {
            running = false
            reply.put("ok", true)
          } else {
            val result = commands.run(cmd, req)
            reply.put("ok", true)
            for (key in result.keys()) reply.put(key, result.get(key))
          }
        } catch (e: Throwable) {
          reply.put("ok", false)
          reply.put("error", "${e.javaClass.simpleName}: ${e.message}")
        }
        writer.print(reply.toString())
        writer.print('\n')
        writer.flush()
      }
    }
  }

  companion object {
    const val TAG = "pitbox"
    const val DEFAULT_PORT = 7912
  }
}
