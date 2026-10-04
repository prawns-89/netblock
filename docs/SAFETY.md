# Safety, fail-safes and data integrity

Priority order, as specified: user data, correct restoration, race prevention,
transaction integrity, authentication, OS-compliant background execution,
silence.

## The restore guarantee

The constraint that shaped the whole design: **no dependency may be able to
leave you locked out.** The restore path therefore does not require the app's
process to be alive, a network to exist, a UI to work, or even the state file to
be readable.

Four independent layers. Each is fenced by `lockdownId`, so when an earlier one
has already restored, the later ones are ignored as stale rather than doing
damage.

| # | Layer | Survives | Notes |
|---|---|---|---|
| 1 | In-process timer | nothing | Fastest. Armed only after `LOCKED` is durably committed. |
| 2 | Second in-process timer, +5s | a deferred first timer | Backstop for coalescing. |
| 3 | `AlarmManager` exact alarm (+ a `set` backstop at +5s) | **process kill, Doze** | Held by the OS. Armed *before* restrictions are applied, so a crash in between yields a harmless no-op alarm, never a lockdown with no end. |
| 4 | `BOOT_COMPLETED` + recovery on every start | **reboot, power loss** | Decides from durable state alone whether restoration is required. |

If the record says `LOCKED` and the deadline has passed, startup restores
immediately. If the deadline is still in the future, it re-arms for **the
remaining time only** — never a fresh 50 seconds.

### Degradation

If the snapshot cannot be read, the fail-safe falls back to clearing every
restriction the app authored, using only `DevicePolicyManager` and `org.json`
— both part of the platform. `FailsafeReceiver` wraps everything in a final
`catch` that clears restrictions unconditionally. Being un-restricted is always
recoverable; being stuck restricted is not.

### The escape hatch

Works with no network, no listener and no working UI:

```bash
adb shell am broadcast -a net.netblock.android.RELEASE \
    -n net.netblock.android/.FailsafeReceiver
```

Also on the settings screen, and on the reference daemon by creating a
`release.request` file in the state directory. All four entry points converge on
the same single implementation of "let me out", so there is no second code path
to get wrong.

Revoking device admin also clears the restrictions — `onDisabled` is the last
moment the app can let you out, so it does.

## Never enable what was already off

A capability already in its locked state before the lockdown is recorded
`NO_CHANGE_NEEDED`, never added to `successfullyModifiedCapabilities`, and never
passed to restore. Restoration iterates **only** over what this transaction
actually changed, and always with an explicit recorded target value.

This holds on the recovery paths too. The corrupt-state policy is
`lift-restrictions`: clear the restrictions we authored (attributable — they
exist only because we created them) and **change no radio's power state**
(not attributable — it may reflect your own choice). `hold` is available if you
would rather nothing automatic happen at all.

There is no `wifi = !wifi` anywhere in the codebase, and
[`tests/01-lifecycle.test.ts`](../tests/01-lifecycle.test.ts) asserts that a
capability that was off beforehand is never even a restore *target*.

## Data integrity

**Not touched, with no code path that could reach them:** photos, messages,
contacts, documents, application databases, saved Wi-Fi networks and keys,
Bluetooth pairings, hotspot SSID and password, SIM/eSIM profiles.

**Structural, not merely intended:** the state model can represent a capability
only as `ON`/`OFF`/`UNKNOWN` plus three booleans. No type in
[`src/core/types.ts`](../src/core/types.ts) is *capable* of holding an SSID, a
key, a pairing or a SIM identifier, so snapshots and audit records cannot leak
them. A test asserts the persisted snapshot's exact field set.

**Our own writes.** Before any connectivity change: `DataGuard.quiesce()` flushes
application-owned persistence, then `store.checkpoint()` fsyncs. Only then is
the first radio touched, so losing the network cannot truncate a write of ours.
No other application is ever signalled or terminated. A test asserts the
ordering.

**Crash-safe persistence.** Atomic writes — temp file, `fsync`, `rename`,
`fsync` the directory. Two slots written alternately, each with a CRC-32 over
its canonical payload, so the previous valid record stays readable until the new
one is fully durable. A failed or torn commit leaves the earlier snapshot
intact; a torn write is detected rather than trusted. Both are tested with
injected faults.

## Bounded, redacted logging

Audit records carry `timestamp, deviceId, lockdownId, commandId, operation,
previousState, requestedState, result, error` and nothing else. Every string is
sanitised: control characters stripped, length capped at 200, and anything
matching a secret-shaped pattern (password, SSID, PSK, IMSI/ICCID/IMEI, token,
private key, MAC address) replaced with `[redacted]` rather than truncated,
because a partial secret is still a secret. The log is a ring buffer with a hard
entry cap. A damaged audit file is discarded, never trusted, and never allowed
to block the engine — it is diagnostic data, not state.

## Threat model

**Defended:** an unpaired peer on the LAN (dropped after its first frame fails
to authenticate, with no reply emitted at all); replayed, duplicated, delayed,
reordered, expired and tampered frames; a controller trying to inject a fenced
internal callback (`TIMEOUT`/`RECOVER` are refused over the wire); a
man-in-the-middle during pairing (the secret never crosses the network, and the
fingerprint is confirmed out of band on both ends).

**Not defended, and worth stating:** an attacker with physical access to an
unlocked phone, or root on either endpoint. The pairing secret is stored on both
endpoints; on Android it is in app-private storage excluded from cloud backup
and device transfer, which is the best an app can do without a hardware-backed
keystore. Moving the secret into the Android Keystore is the obvious next
hardening step and is not done yet.
