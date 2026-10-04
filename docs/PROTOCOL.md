# Command protocol

Peer-to-peer, no server, no cloud, no third party at any point.

## Pairing

The phone generates a 160-bit random secret, displays it as 32 Crockford base32
characters, and you type it into the controller once. Both sides derive
directional keys with HKDF-SHA256, salted with the device id:

```
k_c2d = HKDF(secret, salt=deviceId, info="netblock/v1/c2d")
k_d2c = HKDF(secret, salt=deviceId, info="netblock/v1/d2c")
```

Separate keys per direction mean a device reply can never be replayed back as a
controller command. Both ends display a 24-hex-character fingerprint derived
from the secret *and* the device id; you confirm they match before trusting the
link. The secret never crosses the network, so there is nothing for a network
attacker to interpose on.

The alphabet omits I, L, O and U; the decoder maps those characters to their
visual twins anyway, so a mistyped `O` still pairs instead of failing opaquely.

**Why a typed secret and not X25519:** Android's JCA only exposes X25519 from
API 33, and the governing requirement is that no dependency can wedge the
system. A 160-bit pre-shared secret with HKDF and AES-GCM uses nothing beyond
what every supported Android version and every supported Node version already
ship.

## Envelopes

AES-256-GCM. The whole command is encrypted; only the version, the device id
(needed to select a key when several phones are paired) and the nonce travel in
the clear, and all three are bound as additional authenticated data.

```
{ v, deviceId, nonce, ct, tag }
```

Nonces are a persisted monotonic counter in the high 8 bytes plus 4 random
bytes. The counter guarantees uniqueness even with a poor random source; the
random tail guarantees it even if a counter write were lost. Nonce reuse under
GCM is catastrophic, so neither mechanism is trusted alone. Counter blocks are
reserved *before* use, so a crash cannot cause a value to be reused after
restart.

## Every command carries

`deviceId, commandId, lockdownId, commandType, timestamp, expiresAt, seq`, plus
the AEAD tag as its authentication data.

## Four independent rejection checks

Each would stop some attacks; none is trusted alone.

| Check | Rejects |
|---|---|
| `expiresAt <= now` | `EXPIRED` |
| `abs(now - timestamp) > 120s` | `CLOCK_SKEW` |
| `commandId` already processed | `DUPLICATE` → replies with the **cached result**, so an honest retry still gets its answer and nothing runs twice |
| `seq <= highestSeq` | `OUT_OF_ORDER` — a delayed or reordered frame |

Plus: wrong device, malformed, oversized frame, and `FORBIDDEN_TYPE` for
`TIMEOUT`/`RECOVER`, which a controller may never issue.

The seen-set and sequence high-water mark are **persisted**, so a restart does
not reopen a replay window. The seen-set is bounded.

## Clean reconnection

The insight that makes resume and replay-defence coexist:

- **`seq` is per-FRAME** — a transport sequence number. It must strictly advance,
  which is what detects reordering and delayed frames.
- **`commandId` is per-COMMAND** — an identity, stable across every retry.

So a command that may or may not have been delivered is resent with the **same
`commandId`** and a **fresh `seq`**:

- if the device already processed it, the `commandId` is in the seen-set and the
  device replies from its exactly-once cache, applying nothing twice;
- if it never arrived, the fresh `seq` passes the ordering check and it is
  processed exactly once.

Either way the controller learns the true outcome and the device's state is
identical to the no-failure case.

### The sequence on a real lockdown

1. Controller writes the command to a **durable outbox**, then sends it.
2. The phone applies the lockdown. Wi-Fi goes away. The reply is lost.
3. The command's TTL elapses; the controller reports **`UNCONFIRMED`**. It does
   not guess that it worked.
4. The link returns. `HELLO`/`HELLO_ACK` exchanges high-water marks, the
   device's live lockdown state, and its **processed-`commandId` list**.
5. The controller settles each outbox entry against what the device actually
   did, and resends only what is genuinely outstanding and still in TTL.

Tested end-to-end over real sockets through a proxy that swallows replies and
cuts the connection, asserting the lockdown was applied **exactly once** across
the outage.

### Liveness, with nothing left hanging

- Heartbeat `PING`/`PONG` every 5s.
- **Handshake timeout (5s default).** A peer can accept a TCP connection and
  then never answer — a half-open connection through a NAT, or a phone whose
  Wi-Fi died between the SYN and the reply. Without a deadline the client would
  wait on that socket forever and never reconnect.
- **Idle timeout (20s), both ends.** A silent established connection is dropped
  rather than waited on.
- Reconnect with exponential backoff and jitter, capped at 15s. The backoff
  counter resets only on a **completed handshake**, so a peer that accepts and
  immediately drops us is still backed off instead of being hammered in a tight
  loop.
- Reconnection **never stops**. After three consecutive handshake failures the
  client publishes a diagnosis ("the phone no longer holds this pairing key —
  re-pair — or the link is dropping our replies"), so you are told the likely
  cause instead of seeing a bare "unreachable". It keeps retrying regardless,
  because a flaky link must always heal by itself.
