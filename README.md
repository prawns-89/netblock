# NetBlock

A transactional, authenticated connectivity-lockdown system for **your own
explicitly paired phones**.

Trigger it from your laptop and the phone drops every connectivity surface the
OS will actually let it drop. Fifty seconds later it comes back — to exactly the
state it was in before, not to a guess.

Phones only. No laptop, desktop, wearable or nearby-device control.

---

## The two things worth knowing before anything else

**1. Lockdown severs its own control channel.** The LOCKDOWN command arrives over
Wi-Fi, and then disables Wi-Fi. The reply usually never comes back. This is not a
bug to be worked around — it is the shape of the problem. So the **durable
50-second timer is the restore path**, and it is engineered to be unmissable:
four independent layers, three of which do not require this app's process to be
alive. An explicit RESTORE is best-effort on top of that, never relied upon.

**2. A normal Android app cannot do any of this.** On Android 10+ an ordinary
installed app cannot toggle Wi-Fi; since Android 13 it cannot toggle Bluetooth
either; it has never been able to disable cellular data, NFC or tethering. This
project does not pretend otherwise and contains no bypasses. Real capability
comes from provisioning the app as **Device Owner**, which is the supported,
documented path for an owner locking down their own phone. See
[docs/CAPABILITIES.md](docs/CAPABILITIES.md) for exactly what works where, and
[docs/ANDROID-PROVISIONING.md](docs/ANDROID-PROVISIONING.md) for the one-time
setup.

---

## Status

| Component | Language | State |
|---|---|---|
| Lockdown engine (state machine, store, recovery) | TypeScript | **Runs and is tested here** — 66 tests |
| Command protocol (pairing, AEAD, replay defence) | TypeScript | **Runs and is tested here** over real sockets |
| Controller CLI (Linux / Windows / macOS) | TypeScript | **Runs here** |
| Reference phone daemon | TypeScript | **Runs here** against a simulated device |
| Android native policy + fail-safe | Kotlin | **Written, not compiled** — no Android SDK in this environment |
| iOS | — | **Skipped by decision.** The adapter and its honest capability matrix are in the tree; there is no Swift code or Xcode project |

The TypeScript side is the executable specification: it pins down every
semantic the Kotlin service must reproduce, and the test suite is what proves
those semantics hold.

---

## Quick start, on one machine

No phone needed — the reference daemon runs against a simulated device, so you
can watch the whole protocol work first.

```bash
# Terminal 1 — the "phone"
node --experimental-strip-types src/device/main.ts pair --label laptop
#   -> prints a pairing code, a device id and a fingerprint
node --experimental-strip-types src/device/main.ts start --port 8731 --host 127.0.0.1

# Terminal 2 — the controller
node --experimental-strip-types src/controller/cli.ts pair \
    --host 127.0.0.1 --device <device-id> --label "My Phone"
#   -> paste the code, confirm the fingerprint matches

node --experimental-strip-types src/controller/cli.ts status
node --experimental-strip-types src/controller/cli.ts lock
node --experimental-strip-types src/controller/cli.ts status   # LOCKED, restore in ~50s
# ...50 seconds later...
node --experimental-strip-types src/controller/cli.ts status   # IDLE, exact prior state
```

`toggle` does lock-or-restore depending on live state, resolved inside the lock
so "press it again" can never race itself.

Run the suite with `npm test`.

---

## Architecture

```
  controller (laptop)                         phone
  ┌──────────────────┐                ┌─────────────────────────┐
  │ CLI              │                │  DeviceServer           │
  │  └ ControllerClient ──AES-GCM──▶  │   └ replay guard        │
  │     · durable outbox │   TCP      │      └ Command Queue    │
  │     · resume on      │            │         └ StateManager  │ ← the single writer
  │       reconnect      │            │            └ Adapter    │
  └──────────────────┘                │               └ Store   │ (A/B slots + CRC)
                                      └─────────────────────────┘
```

**Single writer.** One `SerialExecutor` owns all state change. Network handlers,
timers, startup recovery and the settings screen all submit to it; none of them
can touch the adapter or the store. "Two state-changing operations never run
concurrently" is therefore structural, not a convention — and the test suite
asserts `maxObservedConcurrency === 1` under a 200-task storm.

**State machine.** `IDLE → PREPARING → LOCKED → RESTORING → IDLE`, plus `ERROR`
and `RECOVERY`.

**Fencing.** Every activation gets a fresh `lockdownId`. Every asynchronous
callback must prove its `lockdownId` is still the active transaction before it
may change anything. `TIMEOUT` and `RECOVER` without a fence token are rejected
outright, and a controller cannot issue either of them at all.

**Transactional snapshot.** Captured and durably committed *before* the first
irreversible change, then updated after each individual operation so a crash
mid-apply leaves an accurate record of exactly what was modified. Written to
alternating A/B slots with a CRC-32, so a torn write is detected and the
previous valid snapshot is never destroyed by a failed commit.

**Restoration is never a toggle.** The exact prior value is always passed in
explicitly. A capability that was already off before the lockdown is recorded
`NO_CHANGE_NEEDED`, never enters the modified set, and is never touched by
restore — so **nothing that was off gets switched on**.

See [docs/SAFETY.md](docs/SAFETY.md) for the fail-safe layers, the data-integrity
guarantees, and the escape hatch; [docs/PROTOCOL.md](docs/PROTOCOL.md) for the
wire format and how clean reconnection works; [docs/TESTS.md](docs/TESTS.md) for
the scenario-to-test map.

---

## What this will never do

Enforced by the design, not by policy text:

- No scanning for nearby devices, and no permission requested that would allow
  it — there is no `BLUETOOTH_SCAN` and no location permission in the manifest.
- No deauthentication frames, no jamming, no protocol exploits, no undocumented
  or hidden APIs, no reflection, no root, no shell invocation. Every operation
  maps to one documented public platform API.
- No command accepted from anything but a peer that completed explicit
  authenticated pairing.
- Nothing deleted or modified beyond connectivity settings and the app's own
  transaction metadata: saved Wi-Fi networks and keys, Bluetooth pairings,
  hotspot configuration, SIM/eSIM profiles, photos, messages, contacts and
  documents are untouched, and there is no code path that could reach them.
- No unsupported operation faked. If the OS does not expose it, it is reported
  `UNSUPPORTED_BY_OS` and the lockdown proceeds with what is genuinely permitted.

---

## Silence

No countdown, no progress, no banner, no sound, no vibration, no flashing.

Android requires a notification for a foreground service, so the service uses
the minimum permitted form — `IMPORTANCE_MIN`, silent, no badge, no timestamp,
`VISIBILITY_SECRET` — rather than attempting to hide it. Trying to evade that
requirement would be both futile and a policy violation. The owner-facing
settings screen shows full status on demand; nothing is pushed.
