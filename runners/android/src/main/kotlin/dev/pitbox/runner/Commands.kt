package dev.pitbox.runner

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeoutException

/** Every command the runner understands. Coordinates are raw screen pixels. */
class Commands(private val instrumentation: Instrumentation, private val ui: UiAutomation) {

  fun configure() {
    val info = ui.serviceInfo ?: AccessibilityServiceInfo()
    info.flags = info.flags or
      AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
      AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
      AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
    ui.serviceInfo = info
  }

  fun run(cmd: String, req: JSONObject): JSONObject = when (cmd) {
    "ping" -> JSONObject().put("version", BuildInfo.VERSION).put("sdk", Build.VERSION.SDK_INT)
    "info" -> info()
    "tree" -> tree(req.optBoolean("all", false))
    "focus" -> focus()
    "idle" -> JSONObject().put("idle", idle(req.optLong("quiet", 300), req.optLong("timeout", 3000)))
    "tap" -> { tap(req.getInt("x"), req.getInt("y"), req.optLong("hold", 40)); JSONObject() }
    "doubletap" -> { doubleTap(req.getInt("x"), req.getInt("y"), req.optLong("gap", 90)); JSONObject() }
    "longpress" -> { tap(req.getInt("x"), req.getInt("y"), req.optLong("hold", 800)); JSONObject() }
    "swipe" -> {
      swipe(req.getInt("x1"), req.getInt("y1"), req.getInt("x2"), req.getInt("y2"), req.optLong("duration", 300), req.optLong("hold", 0))
      JSONObject()
    }
    "key" -> { key(req.getInt("code"), req.optInt("meta", 0)); JSONObject() }
    "text" -> JSONObject().put("set", setText(req.getString("text"), req.optBoolean("append", false), req.optJSONArray("bounds")))
    "action" -> JSONObject().put("done", action(req.getJSONArray("bounds"), req.getString("action")))
    "screenshot" -> screenshot(req.optDouble("scale", 0.5), req.optInt("quality", 70))
    else -> throw IllegalArgumentException("unknown command: $cmd")
  }

  private fun info(): JSONObject {
    val m = instrumentation.context.resources.displayMetrics
    return JSONObject().put("width", m.widthPixels).put("height", m.heightPixels).put("density", m.densityDpi).put("sdk", Build.VERSION.SDK_INT)
  }

  /** Roots of every window, top layer first; the active window alone where windows are unavailable. */
  private fun roots(): List<Pair<AccessibilityNodeInfo, AccessibilityWindowInfo?>> {
    val windows = try { ui.windows } catch (e: Exception) { emptyList<AccessibilityWindowInfo>() }
    val out = windows.sortedByDescending { it.layer }.mapNotNull { w -> w.root?.let { it to w } }
    if (out.isNotEmpty()) return out
    return listOfNotNull(ui.rootInActiveWindow?.let { it to null })
  }

  private fun windowType(w: AccessibilityWindowInfo?): String = when (w?.type) {
    AccessibilityWindowInfo.TYPE_APPLICATION -> "app"
    AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "ime"
    AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
    AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "overlay"
    else -> "window"
  }

  /**
   * Visible nodes as a flat list with parent indexes. Without `all`, only nodes worth targeting or reading:
   * with text, a description, an id, or an interaction.
   */
  private fun tree(all: Boolean): JSONObject {
    val nodes = JSONArray()
    val windows = JSONArray()
    roots().forEachIndexed { wi, (root, w) ->
      windows.put(JSONObject().put("type", windowType(w)).put("title", w?.title?.toString() ?: "").put("pkg", root.packageName?.toString() ?: ""))
      walk(root, -1, wi, all, nodes, 0)
    }
    return JSONObject().put("windows", windows).put("nodes", nodes)
  }

  private fun walk(n: AccessibilityNodeInfo, parent: Int, window: Int, all: Boolean, out: JSONArray, depth: Int) {
    if (depth > 80) return
    var index = parent
    if (n.isVisibleToUser) {
      val text = n.text?.toString()
      val desc = n.contentDescription?.toString()
      val id = n.viewIdResourceName
      val interactive = n.isClickable || n.isLongClickable || n.isFocusable || n.isEditable || n.isScrollable || n.isCheckable
      if (all || interactive || !text.isNullOrEmpty() || !desc.isNullOrEmpty() || id != null) {
        val r = Rect()
        n.getBoundsInScreen(r)
        val o = JSONObject().put("p", parent).put("w", window).put("c", n.className?.toString()?.substringAfterLast('.') ?: "")
          .put("b", JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom))
        if (id != null) o.put("id", id.substringAfter(":id/"))
        if (!text.isNullOrEmpty()) o.put("t", text)
        if (!desc.isNullOrEmpty()) o.put("d", desc)
        val hint = if (Build.VERSION.SDK_INT >= 26) n.hintText?.toString() else null
        if (!hint.isNullOrEmpty() && hint != text) o.put("h", hint)
        val f = StringBuilder()
        if (n.isClickable) f.append('c')
        if (n.isLongClickable) f.append('l')
        if (n.isFocusable) f.append('f')
        if (n.isFocused) f.append('F')
        if (n.isAccessibilityFocused) f.append('A')
        if (n.isEditable) f.append('e')
        if (n.isScrollable) f.append('s')
        if (n.isCheckable) f.append(if (n.isChecked) 'X' else 'x')
        if (n.isSelected) f.append('S')
        if (!n.isEnabled) f.append('d')
        if (n.isPassword) f.append('p')
        if (f.isNotEmpty()) o.put("f", f.toString())
        index = out.length()
        out.put(o)
      }
    }
    for (i in 0 until n.childCount) {
      val child = n.getChild(i) ?: continue
      walk(child, index, window, all, out, depth + 1)
    }
  }

  /** Input focus (what a D-pad or keyboard acts on) and accessibility focus, from every window. */
  private fun focus(): JSONObject {
    val out = JSONObject()
    for ((root, _) in roots()) {
      if (!out.has("input")) root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { out.put("input", describe(it)) }
      if (!out.has("accessibility")) root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)?.let { out.put("accessibility", describe(it)) }
    }
    return out
  }

  private fun describe(n: AccessibilityNodeInfo): JSONObject {
    val r = Rect()
    n.getBoundsInScreen(r)
    val o = JSONObject().put("c", n.className?.toString()?.substringAfterLast('.') ?: "").put("b", JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom))
    n.viewIdResourceName?.let { o.put("id", it.substringAfter(":id/")) }
    n.text?.let { o.put("t", it.toString()) }
    n.contentDescription?.let { o.put("d", it.toString()) }
    return o
  }

  /** Waits until no accessibility events arrive for `quiet` ms; false when the UI kept changing until `timeout`. */
  private fun idle(quiet: Long, timeout: Long): Boolean = try {
    ui.waitForIdle(quiet, timeout)
    true
  } catch (e: TimeoutException) {
    false
  }

  private fun motion(downTime: Long, action: Int, x: Float, y: Float): MotionEvent =
    MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }

  private fun inject(e: MotionEvent) {
    ui.injectInputEvent(e, true)
    e.recycle()
  }

  private fun tap(x: Int, y: Int, hold: Long) {
    val down = SystemClock.uptimeMillis()
    inject(motion(down, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat()))
    SystemClock.sleep(hold)
    inject(motion(down, MotionEvent.ACTION_UP, x.toFloat(), y.toFloat()))
  }

  /** Two taps `gap` ms apart — inside the platform's double-tap window (300 ms), unlike two separate commands. */
  private fun doubleTap(x: Int, y: Int, gap: Long) {
    tap(x, y, 30)
    SystemClock.sleep(gap)
    tap(x, y, 30)
  }

  /** A straight swipe in `duration` ms, moves every ~8 ms, so velocity is what was asked; `hold` pauses at the end. */
  private fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Long, hold: Long) {
    val down = SystemClock.uptimeMillis()
    inject(motion(down, MotionEvent.ACTION_DOWN, x1.toFloat(), y1.toFloat()))
    val steps = (duration / 8).coerceAtLeast(2)
    for (i in 1..steps) {
      val t = i.toFloat() / steps
      SystemClock.sleep(duration / steps)
      inject(motion(down, MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    }
    if (hold > 0) SystemClock.sleep(hold)
    inject(motion(down, MotionEvent.ACTION_UP, x2.toFloat(), y2.toFloat()))
  }

  private fun key(code: Int, meta: Int) {
    val now = SystemClock.uptimeMillis()
    val source = if (code in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_CENTER) InputDevice.SOURCE_DPAD else InputDevice.SOURCE_KEYBOARD
    val down = KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, source)
    ui.injectInputEvent(down, true)
    val up = KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, source)
    ui.injectInputEvent(up, true)
  }

  /** The node at the centre of `bounds` that is editable, or the focused editable node when no bounds are given. */
  private fun findEditable(bounds: JSONArray?): AccessibilityNodeInfo? {
    for ((root, _) in roots()) {
      if (bounds == null) {
        root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { if (it.isEditable) return it }
      } else {
        findAt(root, bounds) { it.isEditable }?.let { return it }
      }
    }
    return null
  }

  private fun findAt(n: AccessibilityNodeInfo, bounds: JSONArray, accept: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
    val r = Rect()
    n.getBoundsInScreen(r)
    val want = Rect(bounds.getInt(0), bounds.getInt(1), bounds.getInt(2), bounds.getInt(3))
    if (r == want && accept(n)) return n
    for (i in 0 until n.childCount) {
      val c = n.getChild(i) ?: continue
      val cr = Rect()
      c.getBoundsInScreen(cr)
      if (!cr.contains(want) && cr != want) continue
      findAt(c, bounds, accept)?.let { return it }
    }
    return null
  }

  private fun setText(text: String, append: Boolean, bounds: JSONArray?): Boolean {
    val node = findEditable(bounds) ?: return false
    val value = if (append) (node.text?.toString() ?: "") + text else text
    val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) }
    return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
  }

  /** An accessibility action on the node with exactly these bounds: click, scroll_forward, scroll_backward, focus. */
  private fun action(bounds: JSONArray, name: String): Boolean {
    val id = when (name) {
      "click" -> AccessibilityNodeInfo.ACTION_CLICK
      "long_click" -> AccessibilityNodeInfo.ACTION_LONG_CLICK
      "scroll_forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
      "scroll_backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
      "focus" -> AccessibilityNodeInfo.ACTION_FOCUS
      else -> throw IllegalArgumentException("unknown action: $name")
    }
    for ((root, _) in roots()) findAt(root, bounds) { true }?.let { return it.performAction(id) }
    return false
  }

  /** A downscaled JPEG, base64 — small enough to hand to a model only when it is really needed. */
  private fun screenshot(scale: Double, quality: Int): JSONObject {
    val full = ui.takeScreenshot() ?: throw IllegalStateException("screenshot failed")
    val w = (full.width * scale).toInt().coerceAtLeast(1)
    val h = (full.height * scale).toInt().coerceAtLeast(1)
    val bmp = if (scale < 1.0) Bitmap.createScaledBitmap(full, w, h, true) else full
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
    return JSONObject().put("width", w).put("height", h).put("jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
  }
}

object BuildInfo {
  const val VERSION = 1
}
