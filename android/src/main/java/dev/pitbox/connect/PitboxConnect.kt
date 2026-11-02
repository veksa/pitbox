package dev.pitbox.connect

import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.preference.PreferenceManager

/**
 * The hosts a debug build should talk to, kept across launches. `devserver` is also written where React
 * Native's dev support reads its bundler address (`debug_http_host` in the default shared preferences), so no
 * dev launcher is needed to point the app at a server.
 */
object PitboxConnect {
  private const val PREFS = "pitbox.connect"
  private const val RN_HOST_KEY = "debug_http_host"

  fun isDebuggable(context: Context): Boolean = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  /** `name → host:port` pairs from the last connect link. */
  fun hosts(context: Context): Map<String, String> =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).all.mapNotNull { (k, v) -> (v as? String)?.let { k to it } }.toMap()

  fun host(context: Context, name: String): String? = hosts(context)[name]

  /** Saves every query parameter of a connect link; an empty value forgets the name. */
  fun save(context: Context, link: Uri) {
    val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    for (name in link.queryParameterNames) {
      val value = link.getQueryParameter(name)
      if (value.isNullOrEmpty()) editor.remove(name) else editor.putString(name, value)
    }
    // commit(), not apply(): the connect screen kills the process right after, and apply() writes later.
    editor.commit()
    apply(context, sync = true)
  }

  /** Mirrors the saved dev server into React Native's own setting. */
  @Suppress("DEPRECATION")
  fun apply(context: Context, sync: Boolean = false) {
    val devserver = host(context, "devserver") ?: return
    val rn = PreferenceManager.getDefaultSharedPreferences(context)
    if (rn.getString(RN_HOST_KEY, null) == devserver) return
    val edit = rn.edit().putString(RN_HOST_KEY, devserver)
    if (sync) edit.commit() else edit.apply()
  }
}
