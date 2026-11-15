package dev.pitbox.example.relay

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.MessageClient

/** Ping the other device, show its pong; the pings this side answered are counted below. */
class RelayActivity : Activity() {
  private lateinit var nodes: TextView
  private lateinit var status: TextView
  private lateinit var pings: TextView

  private val listener = MessageClient.OnMessageReceivedListener { event ->
    when (event.path) {
      PingService.PONG -> status.text = "pong ${String(event.data)} from ${event.sourceNodeId}"
      PingService.PING -> showPings()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.relay)
    nodes = findViewById(R.id.relay_nodes)
    status = findViewById(R.id.relay_status)
    pings = findViewById(R.id.relay_pings)
    findViewById<Button>(R.id.relay_ping).setOnClickListener { ping() }
  }

  override fun onResume() {
    super.onResume()
    runCatching { DataLayer.addListener(this, listener) }
    showPings()
    DataLayer.connectedNodes(this).addOnCompleteListener { t ->
      val found = t.result.orEmpty()
      DataLayer.getCapability(this, "pitbox_relay", CapabilityClient.FILTER_REACHABLE).addOnCompleteListener { c ->
        val capable = if (c.isSuccessful) c.result.nodes.size else 0
        nodes.text = "nodes: ${found.joinToString { it.displayName }.ifEmpty { "none" }} (capable $capable)"
      }
    }
  }

  override fun onPause() {
    runCatching { DataLayer.removeListener(this, listener) }
    super.onPause()
  }

  private fun ping() {
    status.text = "pinging"
    DataLayer.connectedNodes(this).addOnCompleteListener { t ->
      val found = if (t.isSuccessful) t.result else emptyList()
      if (found.isEmpty()) {
        status.text = "no node"
        return@addOnCompleteListener
      }
      for (node in found) {
        DataLayer.sendMessage(this, node.id, PingService.PING, ByteArray(0)).addOnFailureListener { status.text = "send failed: ${it.message}" }
      }
    }
  }

  private fun showPings() {
    pings.text = "answered ${getSharedPreferences(PingService.PREFS, Context.MODE_PRIVATE).getInt(PingService.COUNT, 0)} pings"
  }
}
