# Working in parallel

Several agents (or people) often use one machine at once: different projects, or several sessions of one project
in different worktrees. pitbox keeps them from disturbing each other — nobody's simulator is shut down, wiped or
driven by another session — by leasing every device to the session that drives it. It is enforced by pitbox, not
left to each agent's discipline.

## The model

- **A lease per device.** `~/.pitbox/leases/<platform>-<udid|serial>.json` (`PITBOX_HOME` moves `~/.pitbox`):
  the holder's label, its pid and the pid's start time, its project folder, what for, since when, whether pitbox
  booted (or created) the device for it, and for Android the boot it was taken on. Every change to a lease happens
  under that device's lock file and replaces the file whole: two sessions racing for one device cannot both get it.
- **An Android serial is not a device.** `emulator-5556` goes to the next emulator on that port; a lease names the
  boot of the device (its kernel boot id), so a new emulator on a reused serial is free, and the session that held
  the old one neither drives nor shuts down the new one.
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
  deletes leftover ones that are shut down and held by nobody). For Android: the instance of the AVD this session
  holds, else a new one, started `-read-only` beside an instance that already runs (its changes go when it shuts
  down); an emulator it started that it cannot lease is shut down again, not left running. Before a new
  device starts, pitbox looks at free memory and load and prints a warning when another device is likely to make
  the machine swap — never a refusal.
- **Shutting down** works only on a device this session holds; `force` shuts down another's anyway and says whose
  it was — only with the device named, never on a device pitbox picked by itself.
- **Giving back.** `device release` (or `down` for the whole stand, or `pitbox daemon stop`) releases the leases;
  a device pitbox booted for the session shuts down with it (`devices.shutdownOnRelease: false` keeps it up), a
  device it found running stays running. A daemon restarted after an upgrade keeps its leases.
- **Stale leases.** A lease lives as long as its holder process: the same pid with the same start time, so a pid
  the system reused for another program does not count, and a machine that slept does not lose its leases. Once the
  process is gone (after a minute's grace, in which a restarted daemon picks its devices up) the next session that
  needs the device takes it over. Only a shell lease with no `--pid` expires by time. A daemon renews its leases
  every 30 s on a timer of its own and gives back the devices that went away.
- **Forwards follow leases.** The daemon applies `adb reverse` only on devices it holds, and removes only the
  ports it forwarded, never another stand's.
- **The push gateway delivers only to this session's devices.** A gateway request goes to a device the session
  holds; a token bound to a device it no longer holds is routed by kind instead, with a note in the verdict. With no
  device of the session online the gateway answers 503.
- **Shared caches.** The Apple runner, the fold helper and the Mac runner are built once per source and Xcode
  version under `~/Library/Caches/pitbox` and shared by every daemon. A version in use is marked
  (`.in-use-<pid>`), a build holds `<version>.lock` (a second daemon building the same version waits and finds it
  done; the lock is kept fresh while a long build runs), and an old version is removed only when nobody uses or builds it, it is not among the three most recently
  used, and it was last used more than 7 days ago.

## Commands

| | |
|---|---|
| `device action=list` · `pitbox devices` | every device with `[yours]`, `[held by "…" (pid, folder, for N min)]` or `[running, unleased]` |
| `device action=clean` · `pitbox devices clean` | delete the shut-down simulators pitbox created for sessions that nobody holds |
| `device action=boot` · `pitbox boot [name]` | your own device: the named one, or a free twin / new instance |
| `device action=lease value=<purpose>` · `pitbox device lease [--device d] [--purpose text]` | hold a device now (it is taken on first use anyway) |
| `device action=release [keep=true]` · `pitbox device release [--keep]` | give it back; one pitbox booted shuts down unless `keep` |
| `device action=shutdown [force=true]` · `pitbox shutdown [--force]` | only your device; `force` (with the device named) names whose it was |
| `pitbox lease acquire <device> --as "<label>" [--ttl 30m] [--purpose text] [--pid n] [--wait 5m]` | a lease from a shell, no daemon: for scripts that drive a device with `simctl` or `adb` themselves; exits 1 naming the holder |
| `pitbox lease release <device> --as "<label>" [--force]` · `pitbox lease list` | give it back · every lease, live and stale |

A shell lease (`pitbox lease acquire`) lives for its `--ttl` (default 30 min) or as long as `--pid` runs; acquiring
again renews it. Its holder is the label together with the project (the nearest pitbox config's folder, else the
working folder): the same `--as` in two worktrees is two holders. Taken inside a project, the project's daemon treats it as its own, so a script and pitbox can
share the device. The device is a udid, serial, simulator name or AVD, or `apple:<udid>` / `android:<serial>`.

## What an agent does

1. Boot through pitbox (`device action=boot`), never `simctl boot` / `emulator` by hand: pitbox gives this session
   a device of its own and leases it.
2. Shut down only your own device. This replaces any "one emulator or simulator at a time — shut down the running
   one before starting another" rule: several devices run side by side, one per session. Never shut down, erase or
   drive a device that `device list` shows as held by someone else or as `running, unleased`; do not "free up" the
   machine by stopping other sessions' devices. If memory is short (`boot` warns), shut down your own.
3. A script or skill that calls `simctl` / `adb` directly takes `pitbox lease acquire <device> --as "<label>"`
   first and stops when it exits 1; renews it on long runs; `pitbox lease release` at the end.
4. At the end of the task: `device action=release` (or `stand action=down`) — pitbox shuts down what it booted
   for you and leaves the rest.

## Moving from a hand-made lock

Teams that kept one machine-wide lock folder (`mkdir <lock dir>` before booting anything, an `owner` file inside,
removed after shutdown) can drop it once every session uses a pitbox with leases: the lock serialised all devices
on the machine, a lease covers one device, so sessions run side by side on devices of their own. While some
sessions still use the old convention, keep honouring the lock around boots and shutdowns, and take a lease as
well — the lease is what pitbox checks.
