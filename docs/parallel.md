# Working in parallel

Several agents (or people) often use one machine at once: different projects, or several sessions of one project
in different worktrees. pitbox keeps them from disturbing each other — nobody's simulator is shut down, wiped or
driven by another session — by leasing every device to the session that drives it. It is enforced by pitbox, not
left to each agent's discipline.

## The model

- **A lease per device.** `~/.pitbox/leases/<platform>-<udid|serial>.json` (`PITBOX_HOME` moves `~/.pitbox`):
  the holder's label, its pid and the pid's start time, its project folder, what for, since when, whether pitbox
  booted (or created) the device for it, and for Android the emulator instance it was taken on. Every change to a
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
  deletes leftover ones that are shut down and held by nobody). pitbox records each simulator it creates
  (`$PITBOX_HOME/created-simulators.json`) and deletes only those, never one named like them by hand; cleaning runs
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
  a device pitbox booted for the session shuts down with it (`devices.shutdownOnRelease: false` keeps it up), a
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
  - a device **pitbox booted** for the lease is shut down — a simulator by its udid, an emulator only while it is
    the same emulator process (never by a bare serial). The reaper first replaces the lease with a short one of its
    own (`pitbox, shutting down a device whose lease ended`, 5 min), so no session takes the device half way down;
    if the shutdown fails, that lease runs out and a later sweep tries again. A simulator or AVD copy pitbox created
    is shut down, not deleted: `devices clean` and the daemons' sweep of AVD copies delete it later;
  - any other ended lease (a device pitbox did not boot, a device no longer running, a serial now another
    emulator's, at once, a device booted for a project with `devices.shutdownOnRelease: false`) is only removed.
    pitbox never shuts down a device it did not boot.

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
- **Project tools run on the session's device.** A tool's `{apple_device}` / `{android_device}` is the udid or
  serial of the device this session holds on that platform ([config.md](config.md#tools)); with none, or several,
  the tool is refused rather than pointed at `booted` or the only device adb sees.
- **Ports are checked, not trusted.** A stand's proxy, push gateway and LLM mock start only on a port nobody
  answers on, and its bundler's port is adopted only from a bundler running in the dev server's folder: a stand
  never serves, or forwards to, another stand's bundle ([config.md](config.md#devserver)). A service whose probe
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
- **Shared caches.** The Apple runner, the fold helper and the Mac runner are built once per source and Xcode
  version under `~/Library/Caches/pitbox` and shared by every daemon. A version in use is marked
  (`.in-use-<pid>`), a build holds `<version>.lock` (a second daemon building the same version waits and finds it
  done; the lock is kept fresh while a long build runs), and an old version is removed only when nobody uses or builds it, it is not among the three most recently
  used, and it was last used more than 7 days ago.

## Commands

| | |
|---|---|
| `device action=list` · `pitbox devices` | every device with `[yours]`, `[held by "…" (pid, folder, for N min)]` or `[running, unleased]` |
| `device action=clean` · `pitbox devices clean` | delete the shut-down simulators and AVD copies pitbox created for sessions that nobody holds (an AVD copy only 15 min after it was made) |
| `device action=boot` · `pitbox boot [name]` | your own device: the named one, or a free twin / new instance |
| `device action=lease value=<purpose>` · `pitbox device lease [--device d] [--purpose text]` | hold a device now (it is taken on first use anyway) |
| `device action=release [keep=true]` · `pitbox device release [--keep]` | give it back; one pitbox booted shuts down unless `keep` |
| `device action=shutdown [force=true]` · `pitbox shutdown [--force]` | only your device; `force` (with the device named) names whose it was |
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
   for you and leaves the rest.

## Moving from a hand-made lock

Teams that kept one machine-wide lock folder (`mkdir <lock dir>` before booting anything, an `owner` file inside,
removed after shutdown) can drop it once every session uses a pitbox with leases: the lock serialised all devices
on the machine, a lease covers one device, so sessions run side by side on devices of their own. While some
sessions still use the old convention, keep honouring the lock around boots and shutdowns, and take a lease as
well — the lease is what pitbox checks.
