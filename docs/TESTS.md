# Test suite

```bash
npm test            # 66 tests
npm run test:verbose
```

Deterministic throughout: a `VirtualClock` drives the 50-second policy, a
`MemoryAtomicFs` injects power-loss faults at the exact instants that matter,
and the simulated device injects per-capability operation failures. The protocol
tests use **real TCP sockets and the real AEAD wire format**, not mocks.

## The 19 required scenarios

| # | Scenario | Test |
|---|---|---|
| 1 | Normal LOCKDOWN → RESTORE | `01-lifecycle` — asserts state is byte-identical to the snapshot |
| 2 | LOCKDOWN → 50-second timeout | `01-lifecycle` — and that it does not fire a millisecond early |
| 3 | LOCKDOWN → immediate RESTORE | `01-lifecycle` — timer and OS alarm both cancelled |
| 4 | Duplicate LOCKDOWN | `01-lifecycle` — `ALREADY_LOCKED`, same `lockdownId`, **deadline does not move** |
| 5 | Duplicate RESTORE | `01-lifecycle` — nothing toggles back |
| 6 | LOCKDOWN → RESTORE → LOCKDOWN | `01-lifecycle` — distinct `lockdownId`s |
| 7 | Timeout from an old lockdown | `02-fencing` — three variants, incl. a genuinely pending A timer firing while B is live |
| 8 | Controller disconnect during lockdown | `03-crash-recovery` (engine) + `05-protocol` (real socket cut mid-command) |
| 9 | Phone reboot during lockdown | `03-crash-recovery` — both past the deadline and inside the window |
| 10 | App process killed during lockdown | `03-crash-recovery` — killed mid-apply, rolled back on restart |
| 11 | Partial connectivity failure | `04-failures` — Wi-Fi/BT succeed, cellular fails → full rollback |
| 12 | Two commands arriving simultaneously | `02-fencing` — three variants incl. a 6-command storm |
| 13 | Duplicate network packets | `05-protocol` — same frame ×3, applied once, two cached replies |
| 14 | Delayed network packets | `05-protocol` — stale `seq`, expired, implausible timestamp |
| 15 | Corrupted persisted state | `03-crash-recovery` — both policies; asserts an off capability stays off |
| 16 | Power loss during state persistence | `03-crash-recovery` — pre-commit, torn-post-commit, and pre-snapshot |
| 17 | Unsupported OS capability | `04-failures` — all-unsupported and partially-capable devices |
| 18 | Restoration failure | `04-failures` — permanent failure holds ERROR, retries safely, recovers |
| 19 | Multiple paired phones | `05-protocol` — three phones, independent state, keys and capability reports |

## The central claim

> no race condition can cause an old command or timer to modify the state of a
> newer transaction

Proved from four directions:

1. **Structurally** — `06-invariants` runs 200 overlapping tasks with multiple
   await points each through the `SerialExecutor` and asserts peak concurrency
   is exactly 1 and completion order is strict submission order. A throwing task
   does not break the chain.
2. **By fencing** — `02-fencing` fires `RESTORE`, `TIMEOUT` and `RECOVER`
   carrying a retired `lockdownId` at a live transaction; all three are
   `IGNORED_STALE` and the live transaction's deadline is untouched.
3. **With a real in-flight timer** — A's timer is genuinely pending in the clock
   when B begins. After time passes the deadline, Wi-Fi has been restored
   exactly twice — once per transaction, never three times.
4. **Under contention** — commands racing a firing timeout, and a 6-command
   storm, always leave the engine's record and the device's actual state in
   agreement, with no half-applied capability set.

## Adapter honesty tests (`07-adapters`)

The capability layer is the part that must never over-claim, so it is tested
directly against a scriptable native bridge:

- NFC and Nearby Share are `UNSUPPORTED_BY_OS` at **every** privilege level,
  even when the bridge claims every method is available.
- A Device Owner gets exactly wifi, bluetooth and hotspot.
- An ordinary install claims nothing, and distinguishes "the API exists but we
  lack the role" (`REQUIRES_PRIVILEGE`) from "no such API" (`UNSUPPORTED_BY_OS`).
- The native probe overrides a claimed role: probe says no, we do not try.
- An unsupported capability results in **zero** native calls.
- `restore` refuses to act on an `UNKNOWN` prior value rather than guessing.
- `captureState` discards readings for capabilities it may not control, so no
  value is recorded that could later be "restored" to.
- The release valve clears only what was read back as authored.
- iOS: a sideloaded app claims nothing; supervised MDM gets AirDrop and hotspot
  and nothing more.

## Additional coverage beyond the 19

- A capability that was **off before** the lockdown is never a restore target.
- `TOGGLE` resolves against live state inside the lock.
- Write ordering: `quiesce` → `checkpoint` → first connectivity change.
- A/B slot alternation keeps the previous valid record intact.
- Audit log bounded; secret-shaped strings redacted; no SSID can reach it.
- The persisted snapshot's exact field set — nothing capable of holding user data.
- Pairing code round-trip ×200, ambiguous-character mapping, fingerprint binding
  to the device, malformed-code rejection.
- Envelope tampering: ciphertext, tag, nonce, version, wrong direction, wrong
  device — all rejected.
- 20,000 nonces with no repeat, including across a simulated restart.
- Unpaired peer gets zero bytes of reply; malformed frames and an absurd length
  prefix close the connection without touching state.
- `TIMEOUT`/`RECOVER` cannot be injected by a controller.
- Only the engine's own files are ever written.

## Two bugs this suite caught during development

Both in the reconnection path, both the kind that only show up under a real
cut link:

1. **Unbounded reconnection with no diagnosis.** A link that kept failing its
   handshake looked identical to a sleeping phone. The first fix over-corrected
   and made it *terminal*, which would wedge the controller permanently after
   any flaky link. Resolved by always retrying but publishing a diagnosis.
2. **No handshake timeout.** A peer that accepted the TCP connection and then
   black-holed data left the client waiting forever with no reconnect — a real
   captive-portal and NAT failure mode. Fixed with bounded handshake and idle
   timeouts on both ends.
