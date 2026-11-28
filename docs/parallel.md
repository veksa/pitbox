# Working in parallel

Several agents (or people) often use one machine at once: different projects, or several sessions of one project
in different worktrees. pitbox keeps them from disturbing each other — nobody's simulator is shut down, wiped or
driven by another session — by leasing every device to the session that drives it. It is enforced by pitbox, not
left to each agent's discipline.

## The model

- **A lease per device.** `~/.pitbox/leases/<platform>-<udid|serial>.json` (`PITBOX_HOME` moves `~/.pitbox`):
  the holder's label, its pid and the pid's start time, its project folder, what for, since when, whether pitbox
  booted (or created) the device for it and which boot that was, and for Android the emulator instance it was taken on. Every change to a
  lease happens under that device's lock file and replaces the file whole: two sessions racing for one device
  cannot both get it. The folder must be writable (else pitbox says so and asks for a writable `PITBOX_HOME`); on a
  file system without hard links the lock files are created exclusively instead.
- **An Android serial is not a device.** `emulator-5556` goes to the next emulator on that port; a lease names the
  emulator process, not the kernel boot id — a quickboot snapshot restores that — so a new emulator on a reused
  serial is free, and the session that held the old one neither drives nor shuts down the new one. pitbox reads the
  process and the AVD from the discovery file each emulator writes as it starts (`avd/running/pid_<N>.ini` in the
  emulator's temp folder: `~/Library/Caches/TemporaryItems` on macOS, `$XDG_RUNTIME_DIR`, `/run/user/<uid>`,
  `$ANDROID_TMP` or `/tmp/android-$USER` on Linux, `%LOCALAPPDATA%\Temp` on Windows), so it knows an emulator in any
  state, offline or not yet listed by adb, without asking its console. Without one it asks the console
  (`adb emu avd name`, `adb emu avd discoverypath`) once per adb connection, and again every 15 s while either
  answer is missing; a lease taken meanwhile gets the instance on a later beat, and only from an emulator of the
  same AVD.
- **The holder is the project's daemon.** Sessions of one project share its daemon, and so its devices; parallel
  sessions of one project work from separate worktrees (each has its own config folder, daemon and stand ports).
  The label others see is the project's folder name, plus `PITBOX_SESSION` when the agent's environment sets one
  (`PITBOX_SESSION="checkout pass" pitbox …`).
- **Taken on first use.** Any call that changes or drives a device — boot, install, open, stop, clear, uninstall,
  settings, network, the UI runner (snapshot, press, swipe…), push, states, perf, forwards — leases it, or is
  refused when another session holds it:

  ```
  iPhone 17 is held by "shop · checkout pass" (pid 4242, /work/shop, for 12 min): pitbox does not touch another session's device
  hint: `device boot` gives you one of your own (a free one of the same model, or a new instance), or pass a free device; `device list` shows who holds what
  ```

- **Looking is allowed.** `device list`, `status`, `app logs`, the installed apps, `info` and a plain `screenshot`
  work on any device; nothing that changes state does.
- **No device named** means the device this session holds. A device another session holds is never chosen, and
  neither is a device that runs with no lease (booted by hand, by another tool or by an older pitbox — someone may
  be driving it): `device list` marks it `running, unleased`, and it is taken only when named (`device=<udid>`).
- **`boot` gives you your own.** The named simulator when it is shut down and nobody holds it, or already yours.
  When another session holds it, or it runs with no lease: a shut-down simulator of the same model and runtime that
  nobody holds, else a new one (`iPhone 17 (pitbox 2)`, named under a machine-wide lock and deleted again when the
  session gives it back — `devices.deleteCreated: false` keeps it; `pitbox devices clean` / `device action=clean`
  deletes this project's leftover ones that are shut down and held by nobody). pitbox records each simulator it creates
  (`$PITBOX_HOME/created-simulators.json`) with the project that created it and deletes only those, never one named
  like them by hand, and `clean` never one another project created — a twin it keeps is its next boot (one an older
  pitbox recorded without a project goes only with `devices clean --all` / `force=true`); cleaning runs
  under the lock that creates them, so a simulator created a moment ago and not leased yet is never taken for a
  leftover. For Android: the instance of the AVD this session holds — or the copy of it pitbox made for the session
  — else the AVD when nothing runs it. The emulator starts a second instance of an AVD only when every instance
  (running, starting or offline) runs `-read-only`, so beside an ordinary one pitbox creates an AVD of its own for
  the session: `<avd>_pitbox_N`, a copy of the AVD's config with no data (a first boot, as after a wipe; up to
  10 min) that never points into the original AVD's folder and boots `-no-snapshot`. Beside instances that all run
  `-read-only` it starts another `-read-only` one (its changes go when it shuts down); whether an instance runs
  `-read-only` comes from its discovery file (on every system) or its command line. Boots of emulators take one
  machine-wide lock from the decision until the new emulator writes its discovery file or takes its AVD's lock —
  a second or two — so two sessions booting one AVD at once never take each other's emulator, and boots of other
  AVDs queue for those seconds instead of being refused. pitbox launches each emulator with a marker
  (`-prop qemu.pitbox_launch=<id>`), finds it by that marker in the discovery files, and knows it from then on by
  its process and that process's start time: a serial its launch gave up is never taken for its own, and a pid the
  system has since given to another process is never killed. An emulator that does not come up, does not show
  within a minute, or that it cannot lease, is killed (on Windows with the processes the launcher started), and a
  copy made for it deleted. A second `boot` answers the session's own emulator or copy — its serial with its
  process — even while it is offline or adb lists nothing for a moment; one that is gone (another emulator on its
  port, or none) gets a new boot at once. A copy is recorded with its folder's identity and
  deleted when the session gives it back; one whose emulator does not let go in time (the release says so), or one
  left by a daemon that died or a device that went away, is deleted by a later beat of any daemon (every 5 min)
  or `devices clean` — never while an emulator runs it or a live lease names it, never within 15 min of its
  creation, and never a folder someone made later under the same name. With `devices.deleteCreated: false` a copy
  stays, and only `devices clean` deletes it. The AVD folder is found as the emulator finds it: `ANDROID_AVD_HOME`, else
  `avd` in `ANDROID_EMULATOR_HOME` or `ANDROID_USER_HOME`, else `.android/avd` in `ANDROID_PREFS_ROOT` or
  `ANDROID_SDK_HOME`, else `~/.android/avd`. Before a new
  device starts, pitbox looks at free memory and load and prints a warning when another device is likely to make
  the machine swap — never a refusal.
- **Shutting down** works only on a device this session holds; `force` shuts down another's anyway and says whose
  it was — only with the device named, never on a device pitbox picked by itself.
- **Giving back.** `device release` (or `down` for the whole stand, or `pitbox daemon stop`) releases the leases;
  a device pitbox booted for the session shuts down with it (`devices.shutdownOnRelease: false` keeps it up) —
  only while it still runs the boot pitbox made, checked against the devices running now (the same rule as below:
  `daemon stop` never shuts down another emulator that took the serial, or a simulator booted again by hand); a
  device it found running stays running. Any other end of the daemon — `pitbox daemon restart`, a swap to another
  version, a signal, a crash — keeps its leases and leaves every device running: the next daemon of the project
  adopts them, and an agent in the middle of a run does not lose its simulator to someone else's restart.
- **Stale leases.** A lease lives as long as its holder process: the same pid with the same start time, so a pid
  the system reused for another program does not count, and a machine that slept does not lose its leases. Once the
  process is gone (after a minute's grace, in which a restarted daemon picks its devices up) the next session that
  needs the device takes it over. The start time is kept as seconds since the epoch, so it reads the same whatever
  the time zone or language of the session reading it (on Windows only the pid is checked). Only a shell lease with
  no `--pid` expires by time. A daemon renews its leases every 30 s on a timer of its own and gives back the
  devices that went away — only after three beats and 90 s missing from the device list (5 min when the whole list
  comes back empty, as when adb restarts); an `offline` device counts as present for up to 10 min, a device back in
  the list starts the count again, and a platform whose list could not be read is not judged. A different emulator
  on the serial ends the lease at once.
- **Leases nobody released are ended.** A holder that dies (an agent killed together with its daemon or script) or
  a shell lease that runs out leaves a lease nobody gives back, and a running device with no live lease is someone
  else's to every other session — so the device would run unowned while sessions boot twins beside it. Every
  daemon sweeps the lease folder (on start and every 30 s, whichever project's leases they are: the daemon that
  took one may be the one that died), and so does `pitbox lease list`. A lease counts as ended 1 min after its
  holder process is gone, or once its ttl is out; 10 min after that:
  - a device **pitbox booted** for the lease is shut down — only while it still runs the very boot pitbox made, which
    the lease records (`boot`): for a simulator its `launchd_sim` process (pid and start time, read from the process
    list), for an emulator its process — never by a bare udid or serial, so a simulator booted again later by hand,
    by Xcode or by another tool on the same udid is left running. The reaper first replaces the lease with a short one of its
    own (`pitbox, shutting down a device whose lease ended`, 5 min), so no session takes the device half way down;
    if the shutdown fails, that lease runs out and a later sweep tries again. A simulator or AVD copy pitbox created
    is shut down, not deleted: `devices clean` and the daemons' sweep of AVD copies delete it later;
  - any other ended lease (a device pitbox did not boot, a device no longer running, a simulator booted again since,
    a serial now another emulator's, at once, a lease with no `boot` — written by a pitbox before 0.3.2, or a boot
    whose process could not be read —, a device booted for a project with `devices.shutdownOnRelease: false`) is
    only removed. pitbox never shuts down a device it did not boot, or cannot tell is still the boot it made.

  The 10 min are for the session to come back. A restarted daemon of the project adopts its devices as before
  (the project's daemon is the holder). A shell holder of **the same session** — the same project folder and the
  same session name (`--as`, else `PITBOX_SESSION`; a daemon's is its `PITBOX_SESSION`) — that takes the device
  (`pitbox lease acquire`) keeps it marked as booted by pitbox, so it still goes down when that lease ends; another
  session, or another project, that takes an ended lease over gets the device as one it found running. `lease
  list` and `doctor` (`device-leases`) show a device waiting out its 10 min, and warn when one holder has several
  devices of one platform (a session that booted a second instead of using its first). A platform whose device list
  could not be read is not swept.
- **One version per project.** Sessions of one project share its daemon. A session with another pitbox version
  replaces the daemon only when it is newer and the daemon is idle; otherwise it uses the daemon as it is and says
  so. `doctor` (`daemon-versions`) warns while clients of other versions use the daemon.
- **One daemon per config.** `.pitbox/daemon.json` names one daemon; a second one for the same config (started by
  hand, by an older pitbox, by a client without the start lock) would overwrite it and leave the first running
  unreachable. So a daemon that starts looks at the process list (`node …/daemon/main.js --config <file>`; a
  relative `--config` is read from that process's own folder, and never matches when the folder cannot be read): it
  refuses while the daemon in the file answers, and otherwise stops the other daemons of its config with SIGTERM
  first (their services and device leases stay with the project, and it adopts the leases). Starts of one config
  take turns (`.pitbox/daemon-start.lock`, from this check until the daemon file is written), so the second of two
  daemons started at once finds the first answering and refuses; and a daemon younger than 30 s, or of unknown age,
  is never stopped — it may still be starting. `pitbox daemon status`
  names an unreachable daemon of the config (and exits 1); `daemon stop` and `restart` stop those too, before the
  daemon in the file, which then gives their devices back with its own. On Windows the process list is not read.
- **Project tools run on the session's device.** A tool's `{apple_device}` / `{android_device}` is the udid or
  serial of the device this session holds on that platform ([config.md](config.md#tools)); with none, or several,
  the tool is refused rather than pointed at `booted` or the only device adb sees.
- **Ports are checked, not trusted.** A stand's proxy, push gateway and LLM mock start only on a port nobody
  answers on, and its bundler's port is adopted only from a bundler running in the project: a stand
  never serves, or forwards to, another stand's bundle: every process listening on the port must run in the
  project's repository ([config.md](config.md#devserver)). A service whose probe
  another project's server answers fails with that server's pid and folder instead of being adopted
  ([config.md](config.md#services)). Projects that share a machine each keep a block of ports (`ports.block`), and
  `doctor` (`port-block`) warns about a port outside it ([config.md](config.md#ports)). Worktrees of one
  project need ports of their own, a pair apart, and none of them takes 8097, React DevTools' port.
  `PITBOX_PORTS=lo-hi` keeps the ports pitbox picks itself inside a range ([config.md](config.md#actors)).
- **Forwards follow leases.** The daemon applies `adb reverse` only on devices it holds, and removes only the
  ports it forwarded, never another stand's.
- **The push gateway delivers only to devices the session holds.** Never to another session's, never to one that
  runs with no lease, and it never takes a device: a `POST /push` naming a device the session does not hold is
  refused with the holder in the verdict. A token bound to a device it no longer holds is routed by kind instead,
  with a note in the verdict. With no device of the session online the gateway answers 503.
- **Watch pairs stay with their session.** <a id="watch-pairs"></a>`device action=pair value=watch` pairs an Apple
  Watch simulator with the iPhone the session holds, and leases the watch too (its lease names the phone, so
  `lease list` does not count it as a second device left running, and a call with no device still means the phone).
  The watch is the named one (`watch=`, `apple.watch`) or a twin, taken only when it is shut down, nobody holds it
  and it is in no pair with another phone — `simctl list pairs` shows every session's pairs, shut-down ones too,
  and none of them is touched. With no such watch, a new one is created (`<name> (pitbox N)`). Pairing again
  answers the same pair. `device action=unpair value=watch`, a release of the phone or the watch, `down` and a
  daemon's exit undo only what pitbox made: the pair it created (while it still joins the same two simulators),
  the watch it booted (shut down) or created (deleted). A pair the phone already had with a free watch stays. A
  pair left by a session that died is unpaired by the next beat or `devices clean` once neither simulator has a
  live lease. `simctl pair_activate` that hangs (45 s) is rolled back with a hint to boot a fresh phone. With an
  Android phone emulator the pair is pitbox's Data Layer stand-in ([wear.md](wear.md)): only a Wear OS emulator the
  session holds or boots for it is taken (its lease names the phone the same way), never one another session holds,
  and unpair, a release of either device, `down` and a daemon's orderly exit make both apps forget it. Pairs of a
  daemon that died are kept in its state directory: the next daemon takes them up while both devices are still the
  session's, and makes the apps forget the others.
- **Shared caches.** The Apple runner, the fold helper and the Mac runner are built once per source and Xcode
  version under `~/Library/Caches/pitbox` and shared by every daemon. A version in use is marked
  (`.in-use-<pid>`), a build holds `<version>.lock` (a second daemon building the same version waits and finds it
  done; the lock is kept fresh while a long build runs), and an old version is removed only when nobody uses or builds it, it is not among the three most recently
  used, and it was last used more than 7 days ago.

## Commands

| | |
|---|---|
| `device action=list` · `pitbox devices` | every device with `[yours]`, `[held by "…" (pid, folder, for N min)]` or `[running, unleased]` |
| `device action=clean` · `pitbox devices clean` | delete the shut-down simulators and AVD copies pitbox created for this project's sessions that nobody holds (an AVD copy only 15 min after it was made); never another project's; `--all` / `force=true` also those an older pitbox recorded without a project |
| `device action=boot` · `pitbox boot [name]` | your own device: the named one, or a free twin / new instance |
| `device action=lease value=<purpose>` · `pitbox device lease [--device d] [--purpose text]` | hold a device now (it is taken on first use anyway) |
| `device action=release [keep=true]` · `pitbox device release [--keep]` | give it back; one pitbox booted shuts down unless `keep` |
| `device action=shutdown [force=true]` · `pitbox shutdown [--force]` | only your device; `force` (with the device named) names whose it was |
| `device action=pair value=watch [watch=<name\|udid>]` · `pitbox device pair watch [<watch>]` | pair an Apple Watch simulator with your iPhone simulator, or a Wear OS emulator with your Android phone emulator (`watch=<avd\|serial>`); `device=watch` then names it |
| `device action=unpair value=watch` · `pitbox device unpair watch` | undo the pair pitbox made and give the watch back |
| `pitbox lease acquire <device> --as "<label>" [--ttl 30m] [--purpose text] [--pid n] [--wait 5m]` | a lease from a shell, no daemon: for scripts that drive a device with `simctl` or `adb` themselves; exits 1 naming the holder |
| `pitbox lease release <device> --as "<label>" [--force]` · `pitbox lease list` | give it back · every lease, live and stale, after ending the ones nobody released (see *Leases nobody released are ended*) |

A shell lease (`pitbox lease acquire`) lives for its `--ttl` (default 30 min) or as long as `--pid` runs; acquiring
again renews it. Its holder is the label together with the project (the nearest pitbox config's folder, else the
working folder): the same `--as` in two worktrees is two holders. Taken inside a project, the project's daemon treats it as its own, so a script and pitbox can
share the device; the other way round, `lease acquire` on a device that project's running daemon holds succeeds and
shares it (exit 0), and `lease release` leaves it with the daemon. Another project's or another label's lease is
still refused, and a lease of a daemon that is gone is taken over once its grace ends. The device is a udid, serial, simulator name or AVD, or `apple:<udid>` / `android:<serial>`.

## What an agent does

1. Boot through pitbox (`device action=boot`), never `simctl boot` / `emulator` by hand: pitbox gives this session
   a device of its own and leases it.
2. Shut down only your own device. This replaces any "one emulator or simulator at a time — shut down the running
   one before starting another" rule: several devices run side by side, one per session. Never shut down, erase or
   drive a device that `device list` shows as held by someone else or as `running, unleased`; do not "free up" the
   machine by stopping other sessions' devices. If memory is short (`boot` warns), shut down your own.
3. A script or skill that calls `simctl` / `adb` directly takes `pitbox lease acquire <device> --as "<label>"`
   first and stops when it exits 1; renews it on long runs; `pitbox lease release` at the end. A project tool
   that does gets the device as `{apple_device}` / `{android_device}` — never `simctl … booted`, a bare `adb` or
   `gradlew installDebug` with no serial: those reach whichever device the system picks.
4. At the end of the task: `device action=release` (or `stand action=down`) — pitbox shuts down what it booted
   for you and leaves the rest; `stand action=down` also stops the project's daemon with its browsers, never
   another project's.

## Slim devices

More devices fit on one machine, and each answers faster, when they run without what an app under test never
reaches. pitbox boots devices slim by default; `boot --stock` (`device action=boot slim=false`) or `slim: false` in
the config boots them as the image ships.

**Android emulators** (`android.slim`). The boot disables the image's background apps — YouTube and YouTube Music,
Maps, Gmail, Photos, Calendar, Messages, Drive, the Google app, Android System Intelligence, Digital Wellbeing,
Android Auto, TalkBack and the other accessibility services, the clock, feedback and diagnostics — with
`pm disable-user`, which persists in the AVD: the first slim boot does it, later boots find them off and spend two
shell calls on checking. Play services, the Play Store, Chrome and WebView, the launcher, the keyboard, the camera,
contacts and the dialer stay on. A headless emulator renders on the computer's GPU (`-gpu host`); without it, it
draws every frame on the CPU (`lavapipe`). What pitbox disabled is listed on the device
(`/data/local/tmp/pitbox-slim`); a stock boot enables exactly those again, never an app disabled by hand. An app
enabled again stays stopped (no boot broadcasts) until something starts it; a wipe brings back the image as shipped.

Measured on an Apple M-series Mac, an API 36 Google APIs phone image, 2 GB of guest RAM, headless; each figure the
median of three boots after the first (stock and slim from the same freshly wiped AVD), 60 s after the boot:

| | Stock | Slim |
|---|---|---|
| Boot to `sys.boot_completed` | 15.0 s | 12.9 s |
| Settings cold start (`am start -W`, median of 5) | 207 ms | 117 ms |
| App processes running | 46 | 28 |
| Guest swap in use | 583 MB | 227 MB |
| Emulator CPU while idle | 0.15 cores | 0.11 cores |
| Emulator footprint on the Mac | 2.7 GB | 2.9 GB |

The footprint does not drop: what the apps no longer take, the GPU's buffers take. The gain is speed (boot,
app starts, every frame), less swapping inside the guest and less CPU.

Each slim boot also turns off work that starts on its own in the middle of a run:

- **Background dexopt** (`pm bg-dexopt-job --disable`, API 34 and later). The job waits only for the screen to be
  off a while — an emulator always charges — and then compiles apps: on a fresh AVD one run took 21 s and kept
  three cores busy. The switch lasts until the emulator shuts down, so a stock boot has nothing to put back. Before
  API 34 the command takes no `--disable` and would start a run instead; it is not sent there.
- **Server-pushed feature flags** (`cmd device_config set_sync_disabled_for_tests until_reboot`, API 31 and later),
  as Android's own compatibility tests do: Play services cannot change the device's behaviour mid-run.
- **The keyboard's spell checker** (`secure spell_checker_enabled 0`). The earlier value is written down
  (`/data/local/tmp/pitbox-slim-settings`) and a stock boot puts it back.

Wi-Fi and Bluetooth scanning are already off in the emulator images. A cold boot (the default) runs `-no-snapshot`:
`-no-snapshot-load` only skipped loading the quickboot snapshot, and the emulator still wrote the guest's RAM to
disk on every exit (2.6 GB for a 2 GB guest) — no snapshot is written now, and a release takes 2.1 s instead of
3.1–3.8 s. `coldBoot: false` keeps the quickboot snapshot, loaded and saved.

**iOS simulators** (`apple.slim`; iPhone and iPad on iOS 18.5 and later). launchd_sim reads its disable
overrides from a file on the Mac when the simulator starts
(`/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>/disabled.plist`, kept across an erase). pitbox writes
them there while the simulator is shut down, just before its boot, so slimming costs no extra boot: Siri and Apple
Intelligence, Spotlight, Mail, Screen Time and Family, the Health app, Home, Fitness, News, Weather,
lock screen posters, ads, experiments and diagnostics, Find My, Memoji, media analysis. SpringBoard and the keyboard, notifications and push, widgets
and Live Activities, location, privacy prompts, the photo library, accessibility (the UI runner reads through it),
universal links, keychain, contacts, calendars and reminders, HealthKit, Wallet, StoreKit, Game Center and the link to a
paired watch stay (xcodebuild's launch of the UI runner waits about 10 s for Game Center's daemon when it is off, on
every start; WatchConnectivity between the phone and a paired watch runs over identityservicesd). Each label's
earlier value is kept beside the file (`pitbox-slim.json`); a stock boot puts exactly those back. After the boot
pitbox reads the state back from launchd (`launchctl print-disabled system`) and says how many are off.

Measured on the same Mac, an iPhone 17 simulator on iOS 27.2, headless; the median of three boots after the first,
60 s after the boot, summed over every process under the simulator's `launchd_sim`:

| | Stock | Slim |
|---|---|---|
| | Stock | Slim | Slim, `disable: ['widgets']` |
|---|---|---|---|
| Processes | 207 | 122 | 111 |
| Footprint (phys_footprint, what Activity Monitor shows) | 8.5 GB | 4.5 GB | 3.8 GB |
| Settings launch (`simctl launch`, median of 5) | 108 ms | 115 ms | 112 ms |

A simulator that has booted before comes up in under two seconds either way; the gain is memory: about twice as
many simulators fit before the Mac starts swapping. Widgets and Live Activities (`chronod`, `liveactivitiesd`, with
their extensions) stay on by default, as an app's own widgets need them; `apple.slim: {disable: ['widgets']}`
takes them off too.

Not every daemon can go: some are called in a tight loop while they are off. With `sleepd` off, `healthd`,
`mobiletimerd` and SpringBoard kept 4.5 cores busy for good; such daemons are never disabled, even when listed.

## Warm templates

When the simulator a session asks for is another session's, pitbox gives it one of its own (`<name> (pitbox N)`),
deleted again when it is given back — and a new simulator's first boot is the slowest there is: the runtime fills
the new data (caches, databases, the app registry), indexes and migrates it, and keeps the Mac busy for a minute
after. So the first time pitbox creates one of a model and runtime, it also makes that model's **template** in the
background: a simulator (`pitbox template · iPhone 17 · iOS 27.2`) booted slim and headless, left until its
processes are quiet (under 0.3 cores over 10 s; 4 minutes at most), and shut down. Every later one is a clone of
it (`simctl clone`, copy-on-write on APFS) and boots into data that has settled already.

A template is the Mac's, used by every project, and written down in `~/.pitbox/sim-templates.json`; a simulator the
file does not name is never taken for one, and no session is ever handed the template itself. It is made only when
the Mac has room — no boot warning, and under three devices running, so the background boot never makes a fourth —
under a lease of its own, so another session cannot take it meanwhile; a template left half-made by a daemon that
died is deleted and made again. `devices clean --all` deletes the templates; `apple.templates: false` turns them off.

Measured through pitbox on an Apple-silicon Mac, iPhone 17 on iOS 27.2, slim, two runs each: boot, install the
example app, open it and wait for its first screen (the boot also starts the UI runner in the background):

| | New simulator | Clone of the warm template |
|---|---|---|
| Boot | 12.0–13.2 s | 1.9–2.0 s |
| Boot to the app's first screen | 29.1–32.1 s | 21.6–22.9 s |
| The simulator's CPU over the minute after | 0.24–0.28 cores | 0.02–0.16 cores |

What was left of the first screen's time then was the UI runner's start (`xcodebuild test-without-building`,
15–20 s); it is down to about 3.4 s now ([The UI runner's start](#the-ui-runners-start)).

## The UI runner's start

The first UI call on an iOS simulator waits for the XCUITest runner (a boot starts it in the background). Three
things keep that short:

- **Game Center stays on in slim simulators.** When xcodebuild launches a test runner, the simulator's
  DTServiceHub asks Game Center's daemon (`com.apple.gamed`) and, with it off, holds the runner suspended for about
  10 s before it runs, on every start. Slim never disables it, even when `apple.slim.disable` names it.
- **simctl instead of xcodebuild** (iOS and iPadOS 17 and later). The runner app is launched like any app, with the
  environment xcodebuild would give it (the test frameworks' paths from the build's `.xctestrun`); XCTest finds the
  test bundle inside the app on its own. It is installed only when the simulator has none or another build of it.
  No xcodebuild start, no install on every start, no launch held while Xcode's tools attach. A runner that does not
  answer within 30 s, or exits, is started with xcodebuild instead, and so is every later one of that build in the
  daemon; tvOS, watchOS and visionOS always use xcodebuild. `PITBOX_RUNNER_XCODEBUILD=1` in the daemon's
  environment turns the simctl start off.
- **Kept across a daemon restart.** A daemon that stops and keeps its devices (a restart, a version swap, a signal)
  leaves a runner it launched with simctl running and writes its port to `~/.pitbox/runners/<udid>.json`; the next
  daemon on that simulator takes it over when it runs the same build and answers, instead of starting one. A stop
  that gives the devices back (`daemon stop`, `down`) ends the runner, and any other start clears one left behind.

After a relaunch (`open`, `open!`), XCUITest's first query looks for the app's old process and tries again only a
second later: pitbox activates the app through the runner right after the launch, which finds the new process at
once.

Measured through the daemon on an iPhone 17 Pro simulator, iOS 27.2, slim; median of five:

| | Before | Now |
|---|---|---|
| Runner start, to the first snapshot | 14.1 s | 3.4 s (5.6 s with Game Center on and xcodebuild) |
| … after a daemon restart | 14.1 s | 0.24 s |
| Relaunch of the app and the first snapshot after it | 2.49 s (0.15 + 2.34) | 1.78 s (1.54 + 0.24) |

Tried and left out, no difference measured on the xcodebuild start (2.86 s median each, with Game Center on):
`-skipPackagePluginValidation -skipMacroValidation -disableAutomaticPackageResolution`, `-test-timeouts-enabled NO`,
`-collect-test-diagnostics never`.

## Native builds

A native build is the slowest step of a pass, and the one parallel work repeats most: every worktree builds the
same app, and two sessions on JS-only branches build the same native code twice, fighting for the CPU. `build`
(`app.build` in the config) makes each build once:

- **Fingerprinted.** The build is keyed by a hash of its native inputs: the command and output, the path and
  content of every input file (as git lists them: tracked and untracked, not ignored), and for iOS the Xcode
  version. For an app whose JS comes from a dev server the JS is not an input: a JS edit keeps the build.
- **Shared.** Builds are kept in `~/Library/Caches/pitbox/builds/<app id>/<platform>/<fingerprint>` (an .app is
  cloned on APFS, costing no space), so every checkout and worktree of the app reuses them. A fingerprint built
  before — a branch switched back, an edit undone — is installed at once.
- **Single flight.** Sessions asking for the same missing fingerprint build it once: the first builds, the others
  wait and take its result. Native builds of any app take turns on the machine (one `native-build` lock), as
  several at once only make each slower and starve the devices.
- **Variants.** A build whose output depends on the environment (an instrumented variant, an architecture, a
  config preset) declares those variables in `env` (`['APP_PROBE', 'APP_PUBLIC_*']`): their values are in the
  fingerprint, an unset variable and an empty one differ, and the build runs with the values of the caller — the
  shell that ran `pitbox build`, or the MCP server's environment with `env={…}` of `app action=build` over it — not
  those of the daemon, which has the environment of whichever session started it: a variable a declared pattern
  names that the caller has not set is unset in the build, whatever the daemon has. Each set of values is a variant
  (`variant <hash>` in the answer), kept apart from the others.
- **Leaving variables out.** A namespace glob catches variables the build does not read (a dev server's port, a
  fixture server's address): `!name` and `!glob` entries leave them out wherever they stand in the list
  (`['APP_*', '!APP_DEV_PORT', '!APP_FIXTURE_*']`), so changing one keeps the build. A left-out variable is not
  taken from the caller either.
- **Defaults.** A command that defaults a variable (`${APP_ARCH:-arm64}`) makes the same build whether the variable
  is unset or set to that value; declare the default (`{name: 'APP_ARCH', default: 'arm64'}`) and the two are one
  fingerprint, and the build gets the default when the caller leaves the variable unset (an empty value is still a
  value of its own). The config is TypeScript, so a default that depends on the machine is computed when it loads:
  `default: process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'`. Declaring a default for a variable already in `env`
  keeps the fingerprints of the builds made with it set to the default.
- **Strict environment.** Without it, the build inherits the daemon's other variables, which are not in the
  fingerprint: one the build reads but `env` forgot gets another session's value, and the build made with it is
  served to everyone. `envStrict: true` closes that: the build runs with only its declared variables and a
  baseline the toolchains need to start, all taken from the caller — `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
  `TMPDIR` / `TMP` / `TEMP`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`; the toolchain roots `DEVELOPER_DIR`, `JAVA_HOME`,
  `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME`, `ANDROID_NDK_ROOT`, `ANDROID_USER_HOME`,
  `GRADLE_USER_HOME`; the version managers' and package managers' homes (`NVM_DIR`, `VOLTA_HOME`, `COREPACK_*`,
  `GEM_HOME`, `GEM_PATH`, `RBENV_ROOT`, `ASDF_DIR`, `ASDF_DATA_DIR`, `MISE_DATA_DIR`); `SSH_AUTH_SOCK`, the
  proxies and `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS`; and on Windows its system variables (`SystemRoot`,
  `ComSpec`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ProgramFiles`, …). The toolchain roots' values
  are then in the fingerprint (a build with another JDK or Xcode is another build); `PATH` and the rest are not.
  Anything else the build needs — `GRADLE_OPTS`, `NODE_OPTIONS`, `CI` — goes in `env`. A missing variable shows up
  as a failed build, not as a wrong one; CocoaPods, for one, wants `LANG` set to a UTF-8 locale.
- **Exclusions and outside files.** A build with its JS inside takes every file (`inputs: ['**']`); `!glob` entries
  leave out what does not reach the build (`['**', '!docs/**', '!flows/**']`), so a doc or test edit keeps it.
  `inputs: ['!glob']` alone excludes from the default inputs. Files the build reads that git does not list — a
  preset outside the checkout, an ignored local file — go in `files` (`['~/presets/local.json', '.env.local',
  '$APP_PRESET']`, `$NAME` a variable of `env`): their content is in the fingerprint. A missing one counts as
  absent, its own fingerprint; a `$NAME` set to a path that does not exist fails the build before it starts.
- **Kept, then dropped.** After a build, old builds of the app and platform go: past the five most recently used
  of each variant, unused for 30 days, or past `keep.mb` in all, least recently used first (`keep: {count, days,
  mb}`). Reusing a build counts as a use. One used in the last 15 minutes never goes — another session may be
  installing it — and a build is dropped by a rename first, so a reader finds it whole or not at all. `devices
  clean` leaves the cache alone; deleting the folder is safe while no build or install runs.

Measured on the React Native example (Android, warm Gradle daemon), `pitbox build android` from the command line:

| Step | Result | Wall time |
|---|---|---|
| first build | built (Gradle) | 12.0 s |
| again, same inputs | reused, installed | 0.24 s |
| a JS edit (`App.tsx`) | reused | 0.08 s |
| another worktree of the repository | reused | 0.26 s |
| a native edit (`MainActivity.kt`) | new fingerprint, built | 1.3 s |
| the native edit undone | the earlier build reused | 0.08 s |
| one native edit in two worktrees, built at once | one Gradle run (10.0 s); the other waited 10.1 s and reused it | 10.1 s |

The same on iOS (`pitbox build ios`, warm DerivedData; the first build ran `pod install`, which rewrote
`Podfile.lock` — the build is kept under the fingerprint before and after, so the next request reuses it):

| Step | Result | Wall time |
|---|---|---|
| first build | built (`pod install`, xcodebuild), installed | 16.1 s |
| again, same inputs | reused, installed | 0.37 s |
| a JS edit (`App.tsx`) | reused | 0.11 s |
| another worktree of the repository | reused | 0.16 s |
| a native edit (`AppDelegate.swift`) | new fingerprint, built | 7.7 s |
| the native edit undone | the earlier build reused | 0.12 s |
| one native edit in two worktrees, asked 2 s apart | one xcodebuild (3.1 s); the other waited 1.1 s and reused it | 3.1 s |

## Moving from a hand-made lock

Teams that kept one machine-wide lock folder (`mkdir <lock dir>` before booting anything, an `owner` file inside,
removed after shutdown) can drop it once every session uses a pitbox with leases: the lock serialised all devices
on the machine, a lease covers one device, so sessions run side by side on devices of their own. While some
sessions still use the old convention, keep honouring the lock around boots and shutdowns, and take a lease as
well — the lease is what pitbox checks.
