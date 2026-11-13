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
    "settle" -> settle(req.optLong("timeout", 2000))
    "tap" -> { tap(req.getInt("x"), req.getInt("y"), req.optLong("hold", 40)); JSONObject() }
    "doubletap" -> { doubleTap(req.getInt("x"), req.getInt("y"), req.optLong("gap", 90)); JSONObject() }
    "longpress" -> { tap(req.getInt("x"), req.getInt("y"), req.optLong("hold", 800)); JSONObject() }
    "swipe" -> {
      swipe(req.getInt("x1"), req.getInt("y1"), req.getInt("x2"), req.getInt("y2"), req.optLong("duration", 300), req.optLong("hold", 0))
      JSONObject()
    }
    "key" -> { key(req.getInt("code"), req.optInt("meta", 0)); JSONObject() }
    "mouse" -> { mouse(req.getString("action"), req.getInt("x"), req.getInt("y"), req.optDouble("amount", -1.0).toFloat()); JSONObject() }
    "touchnav" -> { touchNav(req.getString("gesture")); JSONObject() }
    "rotary" -> { rotary(req.getDouble("amount").toFloat(), req.optInt("steps", 1)); JSONObject() }
    "touch" -> { touch(req.getString("phase"), req.optInt("x"), req.optInt("y")); JSONObject().put("down", touchDown != null) }
    "text" -> JSONObject().put("set", setText(req.getString("text"), req.optBoolean("append", false), req.optJSONArray("bounds")))
    "action" -> JSONObject().put("done", action(req.getJSONArray("bounds"), req.getString("action")))
    "node-actions" -> JSONObject().put("actions", nodeActions(req.getInt("window"), req.getJSONArray("bounds")))
    "node-action" -> JSONObject().put("done", nodeAction(req.getInt("window"), req.getJSONArray("bounds"), req.getInt("action"), req.optJSONObject("args")))
    "screenshot" -> screenshot(req.optDouble("scale", 0.5), req.optInt("quality", 70))
    "relay" -> Relay.start(req.getJSONArray("ports"), req.optString("target", "10.0.2.2"))
    "relays" -> Relay.list()
    "unrelay" -> Relay.stopAll()
    "fingerprint" -> fingerprint(req.optInt("cols", 54), req.optJSONArray("masks"))
    "frames" -> frames(req.optJSONArray("bounds"), req.optInt("count", 4), req.optLong("interval", 400), req.optInt("size", 32))
    else -> throw IllegalArgumentException("unknown command: $cmd")
  }

  private fun info(): JSONObject {
    val m = instrumentation.context.resources.displayMetrics
    return JSONObject().put("width", m.widthPixels).put("height", m.heightPixels).put("density", m.densityDpi).put("sdk", Build.VERSION.SDK_INT)
  }

  /** Roots of every window, top layer first; the active window alone where windows are unavailable. */
  private fun roots(): List<Pair<AccessibilityNodeInfo, AccessibilityWindowInfo?>> {
    val windows = try { ui.windows } catch (e: Exception) { emptyList<AccessibilityWindowInfo>() }
    val out = windows.sortedByDescending { it.layer }.mapNotNull { w -> rootOf(w)?.let { it to w } }
    if (out.isNotEmpty()) return out
    return listOfNotNull(ui.rootInActiveWindow?.let { it to null })
  }

  /**
   * Every node is a call into the app's UI thread; when that thread is busy (video, animations) a node-by-node
   * walk takes seconds. From Android 13 the whole subtree is prefetched in batches instead. Uninterruptible: by
   * default the app stops a batch as soon as its UI thread has other work waiting, and on a screen that redraws
   * all the time (text streaming in) every batch stops after a node or two, so the walk falls back to one call per
   * node and a tree takes longer than the host waits for it.
   */
  private fun rootOf(w: AccessibilityWindowInfo): AccessibilityNodeInfo? =
    if (Build.VERSION.SDK_INT >= 33) prefetched { w.getRoot(PREFETCH) } else w.root

  private fun childOf(n: AccessibilityNodeInfo, i: Int): AccessibilityNodeInfo? =
    if (Build.VERSION.SDK_INT >= 33) prefetched { n.getChild(i, CHILD_PREFETCH) } else n.getChild(i)

  /**
   * A node that is gone by the time the app answers (a view detached mid-animation, a window closing) comes back
   * as "no node" in the single-node form; an uninterruptible fetch reads the list form, and on debuggable builds
   * (emulator images) the framework's integrity check then calls size() on the missing list and throws a
   * NullPointerException. That answer means no node, as it does without the flag: null, and the walk goes on.
   */
  private inline fun prefetched(fetch: () -> AccessibilityNodeInfo?): AccessibilityNodeInfo? = try {
    fetch()
  } catch (e: NullPointerException) {
    if (e.stackTrace.none { it.methodName == "checkFindAccessibilityNodeInfoResultIntegrity" }) throw e
    null
  }

  private companion object {
    val PREFETCH = AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_HYBRID or AccessibilityNodeInfo.FLAG_PREFETCH_SIBLINGS or AccessibilityNodeInfo.FLAG_PREFETCH_ANCESTORS or AccessibilityNodeInfo.FLAG_PREFETCH_UNINTERRUPTIBLE
    /** A child that is not cached yet comes with the next batch of its subtree, fetched the same way. */
    val CHILD_PREFETCH = AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_HYBRID or AccessibilityNodeInfo.FLAG_PREFETCH_UNINTERRUPTIBLE
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
    // Before Android 10 the client's node cache can keep a subtree as it was when a view in it was hidden
    // or moved (a screen that comes back over another one): its nodes stay out of later trees. Setting the
    // service info again clears that cache, so each tree is read anew.
    if (Build.VERSION.SDK_INT < 29) ui.serviceInfo = ui.serviceInfo
    val nodes = JSONArray()
    val windows = JSONArray()
    val paint = ArrayList<String>()
    roots().forEachIndexed { wi, (root, w) ->
      windows.put(JSONObject().put("type", windowType(w)).put("title", w?.title?.toString() ?: "").put("pkg", root.packageName?.toString() ?: ""))
      walk(root, -1, wi, all, nodes, 0, "", paint)
    }
    // "z": the node's place in its window's painting, later on top. Siblings paint in drawing order, which follows
    // elevation and differs from the order of the tree (a floating button early in the tree is drawn last).
    val order = paint.indices.sortedBy { paint[it] }
    order.forEachIndexed { rank, i -> nodes.getJSONObject(i).put("z", rank) }
    return JSONObject().put("windows", windows).put("nodes", nodes)
  }

  private fun walk(n: AccessibilityNodeInfo, parent: Int, window: Int, all: Boolean, out: JSONArray, depth: Int, key: String, paint: MutableList<String>) {
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
        paint.add(key)
      }
    }
    for (i in 0 until n.childCount) {
      val child = childOf(n, i) ?: continue
      // A parent paints before its children; fixed-width parts keep the string order numeric.
      val z = if (Build.VERSION.SDK_INT >= 24) child.drawingOrder else 0
      walk(child, index, window, all, out, depth + 1, "$key${"%05d%05d".format(z, i)}", paint)
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

  /**
   * Waits until the windows stop moving, up to `timeout`: a window still opening takes input where it is on the
   * way, and a snapshot taken then puts its nodes there too. First the window manager's own animations (the wait
   * the two-argument injection made before every event, see injectNoAnimationWait), then the windows' bounds, as a
   * desktop's freeform window slides in under the system shell, which the window manager does not count. Bounds,
   * not pixels: a spinner in the app would keep a screen from ever looking still.
   */
  private fun settle(timeout: Long): JSONObject {
    val t0 = SystemClock.uptimeMillis()
    val wm = runCatching {
      val m = Class.forName("android.view.WindowManagerGlobal").getMethod("getWindowManagerService").invoke(null)!!
      m.javaClass.getMethod("syncInputTransactions", Boolean::class.javaPrimitiveType).invoke(m, true)
      true
    }.getOrDefault(false)
    fun bounds() = ui.windows.joinToString(";") { w -> Rect().also { w.getBoundsInScreen(it) }.flattenToString() }
    var prev = bounds()
    var still = 0
    while (still < 2 && SystemClock.uptimeMillis() - t0 < timeout) {
      SystemClock.sleep(40)
      val now = bounds()
      still = if (now == prev) still + 1 else 0
      prev = now
    }
    return JSONObject().put("settled", still >= 2).put("wm", wm).put("ms", SystemClock.uptimeMillis() - t0)
  }

  private fun motion(downTime: Long, action: Int, x: Float, y: Float): MotionEvent =
    MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }

  /**
   * Asynchronous: a synchronous injection waits until the app's UI thread has handled the event, which on a
   * busy thread (a playing video) costs seconds per event. Gesture timing comes from the sleeps between events;
   * the host waits for the UI to settle afterwards.
   */
  private fun inject(e: MotionEvent) {
    injectEvent(e)
    e.recycle()
  }

  /**
   * From Android 14 the two-argument injection also waits for animations to end — on a screen with a playing
   * video they never do, and every event costs a 5 s timeout. The three-argument form skips that wait.
   */
  private val injectNoAnimationWait: java.lang.reflect.Method? = if (Build.VERSION.SDK_INT >= 34) {
    runCatching { UiAutomation::class.java.getMethod("injectInputEvent", android.view.InputEvent::class.java, Boolean::class.javaPrimitiveType, Boolean::class.javaPrimitiveType) }.getOrNull()
  } else null

  private fun injectEvent(e: android.view.InputEvent) {
    val m = injectNoAnimationWait
    if (m != null) m.invoke(ui, e, false, false) else ui.injectInputEvent(e, false)
  }

  /** A one-pointer event from a given source and tool, with optional buttons and axis values. */
  private fun pointerEvent(down: Long, action: Int, x: Int, y: Int, source: Int, tool: Int, buttons: Int = 0, axes: Map<Int, Float> = emptyMap()): MotionEvent {
    val props = MotionEvent.PointerProperties().apply { id = 0; toolType = tool }
    val coords = MotionEvent.PointerCoords().apply {
      this.x = x.toFloat()
      this.y = y.toFloat()
      pressure = if (buttons != 0) 1f else 0f
      size = 1f
      for ((axis, v) in axes) setAxisValue(axis, v)
    }
    return MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, 1, arrayOf(props), arrayOf(coords), 0, buttons, 1f, 1f, 0, 0, source, 0)
  }

  /** The button an ACTION_BUTTON_PRESS/RELEASE is about; the setter is hidden, and without it the event is ignored. */
  private val setActionButton: java.lang.reflect.Method? =
    runCatching { MotionEvent::class.java.getMethod("setActionButton", Int::class.javaPrimitiveType) }.getOrNull()

  /**
   * Mouse input, for tablets, desktops and headsets: `hover` moves the pointer over a point, `right` clicks the
   * secondary button there (context menus), `wheel` turns the wheel by `amount` notches (negative scrolls down).
   */
  private fun mouse(action: String, x: Int, y: Int, amount: Float) {
    val down = SystemClock.uptimeMillis()
    val src = InputDevice.SOURCE_MOUSE
    val tool = MotionEvent.TOOL_TYPE_MOUSE
    when (action) {
      "hover" -> {
        // The pointer may still hover from an earlier call: the dispatcher drops an enter while it does, and the
        // move after it. An exit first ends that hover; with none in progress it is dropped instead.
        inject(pointerEvent(down, MotionEvent.ACTION_HOVER_EXIT, x, y, src, tool))
        // In from a step beside the target a frame at a time, as a real pointer arrives: an exit, an enter and a
        // move in the same millisecond do not always reach the view under them.
        SystemClock.sleep(50)
        inject(pointerEvent(down, MotionEvent.ACTION_HOVER_ENTER, x - 8, y, src, tool))
        SystemClock.sleep(16)
        inject(pointerEvent(down, MotionEvent.ACTION_HOVER_MOVE, x - 4, y, src, tool))
        SystemClock.sleep(16)
        inject(pointerEvent(down, MotionEvent.ACTION_HOVER_MOVE, x, y, src, tool))
      }
      "right" -> {
        val b = MotionEvent.BUTTON_SECONDARY
        inject(pointerEvent(down, MotionEvent.ACTION_HOVER_MOVE, x, y, src, tool))
        inject(pointerEvent(down, MotionEvent.ACTION_DOWN, x, y, src, tool, b))
        inject(pointerEvent(down, MotionEvent.ACTION_BUTTON_PRESS, x, y, src, tool, b).also { setActionButton?.invoke(it, b) })
        SystemClock.sleep(40)
        inject(pointerEvent(down, MotionEvent.ACTION_BUTTON_RELEASE, x, y, src, tool, 0).also { setActionButton?.invoke(it, b) })
        inject(pointerEvent(down, MotionEvent.ACTION_UP, x, y, src, tool, 0))
      }
      "wheel" -> {
        inject(pointerEvent(down, MotionEvent.ACTION_HOVER_MOVE, x, y, src, tool))
        inject(pointerEvent(down, MotionEvent.ACTION_SCROLL, x, y, src, tool, axes = mapOf(MotionEvent.AXIS_VSCROLL to amount)))
      }
      else -> throw IllegalArgumentException("mouse: hover, right or wheel")
    }
  }

  /**
   * A touchpad that navigates instead of pointing (the temple of AI glasses): swipes and taps sent as that very
   * device, because the system turns them into D-pad focus moves only for a device whose ranges it knows.
   */
  private fun touchNav(gesture: String) {
    val dev = InputDevice.getDeviceIds().toList().mapNotNull { InputDevice.getDevice(it) }
      .firstOrNull { it.supportsSource(InputDevice.SOURCE_TOUCH_NAVIGATION) }
      ?: throw IllegalStateException("no touch navigation device here (the temple touchpad of glasses)")
    val src = InputDevice.SOURCE_TOUCH_NAVIGATION
    val xr = dev.getMotionRange(MotionEvent.AXIS_X, src) ?: dev.getMotionRange(MotionEvent.AXIS_X)
    val yr = dev.getMotionRange(MotionEvent.AXIS_Y, src) ?: dev.getMotionRange(MotionEvent.AXIS_Y)
    val w = xr?.range ?: 1000f
    val h = yr?.range ?: 1000f
    val cx = (xr?.min ?: 0f) + w / 2
    val cy = (yr?.min ?: 0f) + h / 2
    val (dx, dy) = when (gesture) {
      "forward" -> 0.4f * w to 0f
      "back" -> -0.4f * w to 0f
      "down" -> 0f to 0.4f * h
      "up" -> 0f to -0.4f * h
      "tap" -> 0f to 0f
      else -> throw IllegalArgumentException("touchnav: forward, back, up, down or tap")
    }
    val down = SystemClock.uptimeMillis()
    fun ev(action: Int, x: Float, y: Float): MotionEvent {
      val props = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
      val coords = MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 1f }
      return MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, 1, arrayOf(props), arrayOf(coords), 0, 0, 1f, 1f, dev.id, 0, src, 0)
    }
    inject(ev(MotionEvent.ACTION_DOWN, cx, cy))
    val steps = if (gesture == "tap") 0 else 8
    for (i in 1..steps) {
      SystemClock.sleep(15)
      inject(ev(MotionEvent.ACTION_MOVE, cx + dx * i / steps, cy + dy * i / steps))
    }
    SystemClock.sleep(if (gesture == "tap") 60 else 15)
    inject(ev(MotionEvent.ACTION_UP, cx + dx, cy + dy))
  }

  /** A watch crown or rotating bezel: `steps` events of `amount` each (scrolling views read positive as up). */
  private fun rotary(amount: Float, steps: Int) {
    repeat(steps.coerceIn(1, 50)) {
      val now = SystemClock.uptimeMillis()
      inject(pointerEvent(now, MotionEvent.ACTION_SCROLL, 0, 0, InputDevice.SOURCE_ROTARY_ENCODER, MotionEvent.TOOL_TYPE_UNKNOWN, axes = mapOf(MotionEvent.AXIS_SCROLL to amount)))
      SystemClock.sleep(30)
    }
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

  /** A finger that stays down between commands: snapshots can be taken mid-gesture (a scrubber held at 0:42). */
  private var touchDown: Long? = null
  private var lastX = 0f
  private var lastY = 0f

  private fun touch(phase: String, x: Int, y: Int) {
    when (phase) {
      "down" -> {
        if (touchDown != null) touch("up", lastX.toInt(), lastY.toInt())
        val t = SystemClock.uptimeMillis()
        touchDown = t
        inject(motion(t, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat()))
        lastX = x.toFloat(); lastY = y.toFloat()
      }
      "move" -> {
        val t = touchDown ?: throw IllegalStateException("no finger down")
        // Moves in ~8 ms steps over 250 ms, so the app sees a drag, not a jump.
        val steps = 30
        for (i in 1..steps) {
          val f = i.toFloat() / steps
          SystemClock.sleep(8)
          inject(motion(t, MotionEvent.ACTION_MOVE, lastX + (x - lastX) * f, lastY + (y - lastY) * f))
        }
        lastX = x.toFloat(); lastY = y.toFloat()
      }
      "up" -> {
        val t = touchDown ?: return
        inject(motion(t, MotionEvent.ACTION_UP, lastX, lastY))
        touchDown = null
      }
      else -> throw IllegalArgumentException("touch phase: down | move | up")
    }
  }

  private fun key(code: Int, meta: Int) {
    val now = SystemClock.uptimeMillis()
    val source = if (code in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_CENTER) InputDevice.SOURCE_DPAD else InputDevice.SOURCE_KEYBOARD
    val down = KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, source)
    injectEvent(down)
    val up = KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, source)
    injectEvent(up)
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
  /** The node of window `window` (snapshot order) with exactly these bounds; bounds alone repeat across windows on XR. */
  private fun nodeIn(window: Int, bounds: JSONArray): AccessibilityNodeInfo? {
    val root = roots().getOrNull(window)?.first ?: return null
    return findAt(root, bounds) { true }
  }

  /** The accessibility actions a node offers, standard and custom: what a shell lets an app's windows do. */
  private fun nodeActions(window: Int, bounds: JSONArray): JSONArray {
    val n = nodeIn(window, bounds) ?: throw IllegalArgumentException("no node at those bounds in window $window")
    val out = JSONArray()
    for (a in n.actionList) out.put(JSONObject().put("id", a.id).put("label", a.label?.toString() ?: actionName(a.id)))
    return out
  }

  private fun actionName(id: Int): String = AccessibilityNodeInfo.AccessibilityAction::class.java.fields
    .firstOrNull { f -> f.type == AccessibilityNodeInfo.AccessibilityAction::class.java && (runCatching { (f.get(null) as AccessibilityNodeInfo.AccessibilityAction).id }.getOrNull() == id) }
    ?.name ?: id.toString()

  /** Performs action `id` on a node; `args` become the action's integer, float or string arguments. */
  private fun nodeAction(window: Int, bounds: JSONArray, id: Int, args: JSONObject?): Boolean {
    val n = nodeIn(window, bounds) ?: throw IllegalArgumentException("no node at those bounds in window $window")
    val b = Bundle()
    if (args != null) for (k in args.keys()) {
      when (val v = args.get(k)) {
        is Int -> b.putInt(k, v)
        is Double -> b.putFloat(k, v.toFloat())
        is Boolean -> b.putBoolean(k, v)
        else -> b.putString(k, v.toString())
      }
    }
    // Some shells (XR system UI) answer an action only after the UI it opens has settled; the action itself has
    // happened long before, so the wait is bounded.
    var done = false
    val t = kotlin.concurrent.thread { done = n.performAction(id, b) }
    t.join(2000)
    return if (t.isAlive) true else done
  }

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

  /**
   * Is something moving in a region, and is it black? `count` frames `interval` ms apart, each cropped to
   * `bounds`, shrunk to `size`×`size` greyscale. Answers the mean brightness of each frame and the mean absolute
   * difference between neighbours (0–255) — no image leaves the device.
   */
  private fun frames(bounds: JSONArray?, count: Int, interval: Long, size: Int): JSONObject {
    val luma = JSONArray()
    val diff = JSONArray()
    var prev: IntArray? = null
    for (i in 0 until count) {
      if (i > 0) SystemClock.sleep(interval)
      val full = ui.takeScreenshot() ?: throw IllegalStateException("screenshot failed")
      val r = if (bounds != null) Rect(bounds.getInt(0), bounds.getInt(1), bounds.getInt(2), bounds.getInt(3)) else Rect(0, 0, full.width, full.height)
      r.intersect(0, 0, full.width, full.height)
      if (r.width() <= 0 || r.height() <= 0) throw IllegalArgumentException("bounds outside the screen")
      val crop = Bitmap.createBitmap(full, r.left, r.top, r.width(), r.height())
      val small = Bitmap.createScaledBitmap(crop, size, size, true)
      val px = IntArray(size * size)
      small.getPixels(px, 0, size, 0, 0, size, size)
      val grey = IntArray(px.size) { k ->
        val c = px[k]
        (((c shr 16) and 0xff) * 299 + ((c shr 8) and 0xff) * 587 + (c and 0xff) * 114) / 1000
      }
      luma.put(grey.average())
      prev?.let { p -> diff.put(grey.indices.sumOf { k -> kotlin.math.abs(grey[k] - p[k]) }.toDouble() / grey.size) }
      prev = grey
    }
    return JSONObject().put("luma", luma).put("diff", diff)
  }

  /**
   * The screen as a grid of mean brightness, `cols` wide and as tall as the aspect ratio makes it, with masked
   * rectangles blanked — enough to tell "the same screen" from "something moved" without sending an image.
   */
  private fun fingerprint(cols: Int, masks: JSONArray?): JSONObject {
    val full = ui.takeScreenshot() ?: throw IllegalStateException("screenshot failed")
    val rows = (cols * full.height.toDouble() / full.width).toInt().coerceAtLeast(1)
    val masked = full.copy(Bitmap.Config.ARGB_8888, true)
    if (masks != null && masks.length() > 0) {
      val canvas = android.graphics.Canvas(masked)
      val paint = android.graphics.Paint().apply { color = android.graphics.Color.BLACK }
      for (i in 0 until masks.length()) {
        val m = masks.getJSONArray(i)
        canvas.drawRect(m.getInt(0).toFloat(), m.getInt(1).toFloat(), m.getInt(2).toFloat(), m.getInt(3).toFloat(), paint)
      }
    }
    val small = Bitmap.createScaledBitmap(masked, cols, rows, true)
    val px = IntArray(cols * rows)
    small.getPixels(px, 0, cols, 0, 0, cols, rows)
    val grid = JSONArray()
    for (c in px) grid.put((((c shr 16) and 0xff) * 299 + ((c shr 8) and 0xff) * 587 + (c and 0xff) * 114) / 1000)
    return JSONObject().put("cols", cols).put("rows", rows).put("width", full.width).put("height", full.height).put("grid", grid)
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
  const val VERSION = 21
}
