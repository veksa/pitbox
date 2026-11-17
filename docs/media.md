# Media

Sound into the microphone, the sound and the picture an app puts out, the camera, the gallery, phone calls that
interrupt audio, volumes and the permissions in between — on Android emulators and iOS simulators, through the same
commands in the CLI, the MCP tools and flows. What a platform cannot do is refused with the reason; nothing is faked.

## Support

Checked on emulator 37.2.13 (Android 16, API 36) and Xcode 27.2 (iOS 27.2).

| Feature | Android emulator | iOS simulator |
|---|---|---|
| Microphone: a file (WAV as is, anything else through ffmpeg) | ✅ `mic <file>` through the emulator's gRPC `injectAudio`; boot with `--audio` | ❌ the simulator records from the Mac's input device; see [iOS microphone](#ios-microphone) |
| Microphone: tone, noise (white, pink, brown), silence, parts joined, noise mixed in at an SNR, repeats | ✅ | ❌ (same) |
| Microphone: in the background, stopped mid-sound, again and again | ✅ `bg`, `mic stop`, `mic status` | ❌ |
| What the app plays, to a WAV | ✅ `capture start audio` (gRPC `streamAudio`) | ❌ the simulator plays through the Mac's output; simctl captures no sound |
| Checks on that sound: there is sound, how long, how loud, which frequency | ✅ `capture check`, `expect sound …` | ❌ (no sound to check) |
| A transcript of it | ✅ through your own command (`media.transcribe`) | ❌ |
| Screen recording | ✅ `capture start` (the emulator records on the host: WebM, up to 4 h) | ✅ `capture start` (`simctl io recordVideo`, H.264) |
| …with the device's sound | ✅ when the emulator runs with audio | ❌ simctl records the screen only |
| …fps and size | ✅ by the emulator's recorder | ✅ re-encoded afterwards (needs ffmpeg) |
| …touches drawn | ⚠️ `touches` turns on `show_touches`: it draws touches that come through the touchscreen (a person, the emulator window), not pitbox's own taps, which UI automation injects past it | ❌ the simulator draws none into its recording |
| Frames out of a recording, to look at | ✅ `capture frames` (needs ffmpeg) | ✅ |
| Camera: a still image, a video, the virtual 3D room, the host webcam | ✅ `boot --camera image:<file>` / `video:<file>` / `virtualscene` / `webcam0`; the image or video changes at run time (`camera image|video <file>`) | ❌ no camera: `AVCaptureDevice` finds no video device, simctl has no camera service, there is no Camera app |
| Photos and videos into the gallery | ✅ `library add` (pushed, then scanned into MediaStore) | ✅ `library add` (`simctl addmedia`) |
| An incoming call taking audio focus, ended | ✅ `call incoming`, `call end` (the emulator's modem) | ❌ the simulator has no phone |
| Volumes and the ringer mode | ✅ `audio volume …`, `audio ringer …` | ❌ the simulator follows the Mac's volume |
| Headphones plugged or pulled | ❌ the emulator has no wired-headset control, and the "becoming noisy" broadcast is the system's alone | ❌ |
| Microphone, camera and photo permissions: grant, revoke, reset to "ask again" | ✅ `settings grant=mic revoke=camera reset=mic` | ✅ for `mic` and `photos` (`simctl privacy`); a camera has no permission to grant |

A phone or tablet on USB has none of the emulator's channels: `mic`, `capture start audio`, `camera` and `call` refuse
it, and `capture start` uses the device's own `screenrecord` (an MP4 without sound, at most 3 minutes).

### Known emulator problems

- **`injectAudio` crashes emulator 37.2 when no app records.** The emulator ends with a segmentation fault (in
  `audio_forwarder_enable`) when sound is sent to the microphone while nothing in the guest records from it. `mic`
  therefore waits for a recording (`dumpsys audio`) before the first packet, and asks again before each 2-second call
  after it: when the app stops recording, the rest of the sound is not played, and the answer says so. Do not call
  `injectAudio` yourself on an emulator where nothing records.
- **A loaded machine loses audio.** With several emulators running and the host load well above its core count, the
  guest's audio capture fails (`pcm_readi … I/O error` in the emulator's log) and the app hears silence or gaps. Run
  one emulator with audio at a time when sound matters.

## Microphone

```sh
pitbox boot Pixel_8 --audio                  # or android.audio: true in the config
pitbox mic speech.wav                        # plays once the app records; answers when it has played
pitbox mic speech.m4a noise=pink snr=10      # any audio file (through ffmpeg), pink noise 10 dB under it
pitbox mic silence 1s + hello.wav + tone 1k 300ms   # parts joined with +
pitbox mic tone 440 2s -12dB                 # a sine: frequency, length, peak level
pitbox mic noise brown 3s -30dB              # white (default), pink or brown noise at an RMS level
pitbox mic hello.wav repeat=3 gap=2s         # three times, two seconds apart
pitbox mic long-talk.wav bg                  # answers at once; plays as soon as the app starts recording
pitbox mic status                            # what plays, how far it is
pitbox mic stop                              # ends it mid-sound
```

Options anywhere in the value: `noise=white|pink|brown|<file>` with `snr=<dB>` (default 10; the signal's RMS over the
part that sounds against the noise's RMS), `gain=<dB>`, `repeat=<n>` with `gap=<secs>`, `wait=<secs>` (how long to
wait for the app to record: 10 s by default, 60 s with `bg`), `bg`. Paths are from the project root. The sound is made
at 48 kHz mono and sent in real time, 100 ms a packet; what the app does not record while it plays is lost, as with a
person speaking. A new `mic` replaces the one playing.

In a flow, a sound in the background lines up with the press that starts recording:

```
mic question.wav noise=pink snr=15 bg
press id=record
wait text~="Transcript"
```

### iOS microphone

A simulator records from the Mac's current input device, and nothing in simctl feeds it a file. The route that works is
a loopback audio device on the Mac (BlackHole or similar): install it, choose it as the Mac's input (or as the
Simulator's in its I/O menu), play the file to it, and allow Simulator to use the microphone in System Settings ›
Privacy & Security › Microphone. That permission is the Mac's own and is given by a person; pitbox never changes it.
pitbox does not install audio drivers.

## Capture: what the device plays and shows

```sh
pitbox capture start audio                   # what an emulator plays, as a WAV
pitbox press id=play
pitbox capture stop                          # file, length, size, and the sound: how long, how loud, where
pitbox capture check sound min=1s level=-30 freq=880
pitbox capture check silence

pitbox capture start screen fps=30 size=720x1600 touches   # with the device's sound on an emulator with audio
pitbox capture stop
pitbox capture frames count=6                # JPEGs spread over the recording, 540 px wide
pitbox capture frames every=0.5s width=320
```

`capture stop` answers with one line about the sound, for example
`sound 1.6s of 5.2s, first at 0.7s · level -11.9 dBFS peak -8.7 dBFS · 0.68–2.28s`: it sounds where 20 ms windows are
louder than -50 dBFS, pauses under 300 ms joined. Checks on the last capture (or on a `file`): `sound` (any), `silence`,
`min=` / `max=` seconds of sound, `level=` (dBFS while it sounds), `freq=` (the strongest frequency, within 3 %),
`said "words"`. Files go to `.pitbox/captures/`; `name=` names them.

In flows: `capture start [screen|audio] [fps=…] [size=…] [touches]`, `capture stop`, `capture frames …`, and
`expect sound …`, `expect silence`, `expect said "…"` on what was captured.

**Transcripts** are left to a command of your own, which prints what a 16 kHz mono WAV says:

```ts
media: {transcribe: 'whisper-cli -nt -f {file}'},
```

then `capture stop transcribe` adds what was said, and `expect said "order confirmed"` checks it (case does not
matter).

ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`, or `PITBOX_FFMPEG`) is needed for audio files other than WAV,
for frames, for checks on a video's sound and for fps and size on iOS. An emulator's audio capture and WAV files need
nothing.

## Camera

An emulator's back camera is chosen when it boots:

```sh
pitbox boot Pixel_8 --camera image:card.png       # a still picture
pitbox boot Pixel_8 --camera video:walkthrough.mp4 # a clip, looped
pitbox boot Pixel_8 --camera virtualscene          # a 3D room; move with the emulator's controls
pitbox boot Pixel_8 --camera emulated              # the emulator's moving test pattern
pitbox boot Pixel_8 --camera webcam0               # the computer's own camera (the system asks for camera access)
```

or `android.camera` in the config. The image or video is copied to a file of pitbox's, which the emulator shows; it can
change while the emulator runs, and an app sees the new one when it next opens the camera:

```sh
pitbox camera image receipt.png
pitbox camera video other.mp4
pitbox camera scene wall poster.png          # a poster in the virtual room (scene table … for the table)
pitbox camera status
```

The host webcam is never the default: it needs the computer's camera permission. An iOS simulator has no camera at all;
give the app pictures through the photo library (`library add`) or a test seam in the app.

## Gallery

```sh
pitbox library add photo.jpg clip.mp4
```

Android: the files go to `Pictures/pitbox`, `Movies/pitbox` or `Music/pitbox` on the device and are scanned into
MediaStore, where galleries and pickers look. iOS: `simctl addmedia` puts them in Photos.

## Calls and volumes

```sh
pitbox call incoming 5550100                 # the phone rings: a playing app loses audio focus
pitbox call end                              # the app gets it back
pitbox call busy | hold | accept | list
pitbox audio volume music 8                  # music, ring, alarm, notification, call, system; max, mute, unmute
pitbox audio ringer silent                   # normal, silent, vibrate
pitbox audio status
```

## Permissions

`settings` takes short names: `mic`, `camera`, `photos` (images and videos on Android 13 and later, storage before),
`notifications`, `location`, or a full Android permission. `reset` makes the app ask again (Android clears the user's
choice flags; iOS `simctl privacy reset`).

```sh
pitbox settings grant=mic revoke=camera
pitbox settings reset=mic                    # the next request prompts
```

## MCP

- `device action=mic value="hello.wav noise=pink snr=10 bg"`, `value=stop`, `value=status`
- `device action=camera value="image card.png"`, `action=library value="add a.jpg"`, `action=call value="incoming"`,
  `action=audio value="volume music max"`; `action=boot audio=true camera=image:card.png`
- `capture action=start what=screen fps=30 touches=true`, `action=stop`, `action=frames count=6`,
  `action=check value="sound min=1s"`
- `settings grant=mic reset=camera`

Each answers in one to three lines; `capture frames` lists file names, never images.
