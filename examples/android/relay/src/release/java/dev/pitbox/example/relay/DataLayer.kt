package dev.pitbox.example.relay

import android.content.Context
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.Wearable

/** Release builds: Play services, with the calls the debug source set routes through pitbox. */
object DataLayer {
  fun connectedNodes(context: Context) = Wearable.getNodeClient(context).connectedNodes
  fun sendMessage(context: Context, nodeId: String, path: String, data: ByteArray?) = Wearable.getMessageClient(context).sendMessage(nodeId, path, data)
  fun getCapability(context: Context, capability: String, filter: Int) = Wearable.getCapabilityClient(context).getCapability(capability, filter)
  fun addListener(context: Context, listener: MessageClient.OnMessageReceivedListener) = Wearable.getMessageClient(context).addListener(listener)
  fun removeListener(context: Context, listener: MessageClient.OnMessageReceivedListener) = Wearable.getMessageClient(context).removeListener(listener)
}
