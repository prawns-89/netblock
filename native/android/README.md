# Android native layer

**Status: written, not compiled.** This environment has no Android SDK, Gradle
or `kotlinc`, so none of this Kotlin has been built or run. Treat it as a
reviewed reference implementation, not as verified code. The TypeScript engine
and its 66 tests are the executable specification it must reproduce.

Zero third-party dependencies, by requirement: only the Android framework,
`java.util.zip.CRC32`, `javax.crypto` and `org.json` — all part of the platform.
Nothing here can fail to resolve, and nothing here can fail to load in a way
that leaves the owner locked out.

## Files

| File | Role |
|---|---|
| `NetBlockPolicy.kt` | **The only class that touches connectivity.** Runtime capability detection, explicit apply/restore, and the attributable release valve. No reflection, no hidden APIs, no shell. |
| `Failsafe.kt` | The four-layer restore guarantee: `AlarmManager`, `BOOT_COMPLETED`, the USB release broadcast, and a dependency-free A/B transaction reader with CRC validation. |
| `LockdownService.kt` | Foreground service. Single-writer discipline via one single-threaded executor; minimal OS-mandated notification. |
| `NetBlockDeviceAdmin.kt` | Device admin receiver. Clears authored restrictions in `onDisabled`, so revoking admin cannot lock you out. |
| `AndroidManifest.xml` | Minimum permissions. **No** `BLUETOOTH_SCAN`, **no** location — the app never looks for nearby devices, so it never asks for the permissions that would let it. |

## Still to write

The Kotlin port of the engine itself: `StateManager`, `TransactionStore`,
`AuditLog`, `ReplayGuard`, the envelope codec and the TCP listener.
`LockdownService` currently implements the recovery and restore paths directly;
the full state machine needs porting from `src/core/`.

Port notes:

- `SerialExecutor` → `Executors.newSingleThreadExecutor` (already used in
  `LockdownService`) or a Kotlin coroutine `Mutex`. **One instance, process-wide.**
- `AtomicFs.writeAtomic` → temp file, `FileOutputStream.fd.sync()`, `renameTo`.
  Keep the A/B slot alternation and the CRC-32 envelope byte-for-byte compatible
  with `Failsafe.kt`'s reader, which is what makes the dependency-free fallback
  path work.
- `node:crypto` AES-256-GCM → `javax.crypto.Cipher("AES/GCM/NoPadding")` with a
  128-bit tag; HKDF-SHA256 → `Mac("HmacSHA256")`, about 20 lines.
- Keep the nonce counter reservation: reserve a block, persist, then use.
- Port `tests/` alongside it. The suite is the specification; a port that does
  not pass equivalent tests is not done.

## Hardening not yet done

The pairing secret sits in app-private storage, excluded from cloud backup and
device transfer. Moving it into the Android Keystore is the obvious next step.
