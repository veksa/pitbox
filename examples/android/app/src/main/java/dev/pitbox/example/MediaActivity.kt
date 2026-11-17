package dev.pitbox.example

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Opened by `pitboxexample://media`: what pitbox's media commands are checked against. It records the microphone
 * and says what it heard (how long it sounded, how loud, the strongest frequency), plays a tone, holds audio focus
 * while it plays (a phone call takes it), and shows the microphone and camera permissions.
 */
class MediaActivity : Activity() {
  private lateinit var perms: TextView
  private lateinit var heard: TextView
  private lateinit var focus: TextView
  private lateinit var route: TextView
  private var track: AudioTrack? = null
  private val audio by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }

  @Suppress("DEPRECATION")
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    val name = when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> "gain"
      AudioManager.AUDIOFOCUS_LOSS -> "loss"
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "loss transient"
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "duck"
      else -> "$change"
    }
    focus.post { focus.text = "focus: $name" }
  }

  // Headphones pulled out (or another route that makes playback noisy).
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      route.text = "route: noisy"
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val pad = (16 * resources.displayMetrics.density).toInt()
    val box = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(pad, pad * 3, pad, pad)
    }
    fun text(id: Int, value: String) = TextView(this).apply {
      this.id = id
      text = value
      textSize = 18f
    }.also { box.addView(it) }
    fun button(id: Int, label: String, onClick: () -> Unit) = Button(this).apply {
      this.id = id
      text = label
      setOnClickListener { onClick() }
    }.also { box.addView(it) }

    text(R.id.media_screen, "Media").textSize = 26f
    perms = text(R.id.media_perms, "")
    heard = text(R.id.mic_result, "mic: not recorded")
    focus = text(R.id.audio_focus, "focus: none")
    route = text(R.id.audio_route, "route: quiet")
    button(R.id.ask_mic, "Ask mic") { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA), 1) }
    button(R.id.record, "Record 3s") { record(3) }
    button(R.id.record_long, "Record 8s") { record(8) }
    button(R.id.play_tone, "Play tone") { play(880.0, 1.5) }
    button(R.id.play_long, "Play long") { play(440.0, 30.0) }
    button(R.id.stop_tone, "Stop tone") { stop() }
    setContentView(box)
    registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
  }

  override fun onResume() {
    super.onResume()
    fun state(p: String) = if (checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) "granted" else "denied"
    perms.text = "mic ${state(Manifest.permission.RECORD_AUDIO)} · camera ${state(Manifest.permission.CAMERA)}"
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    onResume()
  }

  override fun onDestroy() {
    stop()
    unregisterReceiver(noisy)
    super.onDestroy()
  }

  /** Records `seconds` at 16 kHz and writes what it heard: sound time, level and frequency, or that it was silent. */
  private fun record(seconds: Int) {
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      heard.text = "mic: no permission"
      return
    }
    heard.text = "mic: recording"
    thread {
      val rate = 16000
      val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      val rec = AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, rate))
      val samples = ShortArray(rate * seconds)
      rec.startRecording()
      var got = 0
      while (got < samples.size) {
        val n = rec.read(samples, got, samples.size - got)
        if (n <= 0) break
        got += n
      }
      rec.stop()
      rec.release()
      val result = describe(samples, got, rate)
      heard.post { heard.text = result }
    }
  }

  private fun describe(s: ShortArray, n: Int, rate: Int): String {
    val win = rate / 50
    var loud = 0
    var sum = 0.0
    var peak = 0
    var i = 0
    while (i + win <= n) {
      var w = 0.0
      for (k in i until i + win) {
        val x = s[k].toDouble()
        w += x * x
        peak = max(peak, abs(s[k].toInt()))
      }
      sum += w
      if (db(sqrt(w / win)) > -50) loud++
      i += win
    }
    if (loud == 0) return "mic: silent (peak ${db(peak.toDouble()).toInt()} dBFS)"
    val secs = loud * win.toDouble() / rate
    return "mic: sound %.1fs · rms %d dBFS · %d Hz".format(secs, db(sqrt(sum / n)).toInt(), freq(s, n, rate))
  }

  private fun db(x: Double) = if (x <= 0) -120.0 else 20 * log10(x / 32768.0)

  /** The strongest frequency of the loudest second, in 10 Hz steps (Goertzel). */
  private fun freq(s: ShortArray, n: Int, rate: Int): Int {
    var best = 0
    var bestE = -1.0
    var start = 0
    for (k in 0 until n - rate step rate / 4) {
      var e = 0.0
      for (j in k until k + rate step 8) e += s[j].toDouble() * s[j]
      if (e > bestE) {
        bestE = e
        start = k
      }
    }
    val len = minOf(rate, n - start)
    var bestP = -1.0
    var f = 50
    while (f <= 4000) {
      val c = 2 * cos(2 * PI * f / rate)
      var s1 = 0.0
      var s2 = 0.0
      for (j in start until start + len) {
        val v = s[j] + c * s1 - s2
        s2 = s1
        s1 = v
      }
      val p = s1 * s1 + s2 * s2 - c * s1 * s2
      if (p > bestP) {
        bestP = p
        best = f
      }
      f += 10
    }
    return best
  }

  /** A sine through the music stream, holding audio focus while it plays. */
  @Suppress("DEPRECATION")
  private fun play(hz: Double, seconds: Double) {
    stop()
    val rate = 44100
    val n = (rate * seconds).toInt()
    val pcm = ShortArray(n) { (sin(2 * PI * hz * it / rate) * 12000).toInt().toShort() }
    val t = AudioTrack(AudioManager.STREAM_MUSIC, rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT, n * 2, AudioTrack.MODE_STATIC)
    t.write(pcm, 0, n)
    val granted = audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
    focus.text = if (granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) "focus: gain" else "focus: refused"
    t.play()
    track = t
  }

  @Suppress("DEPRECATION")
  private fun stop() {
    track?.run {
      stop()
      release()
    }
    track = null
    audio.abandonAudioFocus(focusListener)
  }
}
