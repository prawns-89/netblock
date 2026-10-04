# Controller OS × phone OS

The controller is dependency-free Node ≥ 22.6. Paths come from
[`src/core/paths.ts`](../src/core/paths.ts), directory fsync is skipped on
Windows (where `rename` is already durable), and the transport is ordinary TCP.
Nothing in the controller is platform-specific beyond that.

| Controller | Android phone | iOS phone |
|---|---|---|
| **Linux** | Supported | Not built (decision) |
| **Windows** | Supported | Not built (decision) |
| **macOS** | Supported | Not built (decision) |

State directories:

| OS | Location |
|---|---|
| Linux | `$XDG_STATE_HOME/netblock/` or `~/.local/state/netblock/` |
| macOS | `~/Library/Application Support/NetBlock/` |
| Windows | `%APPDATA%\NetBlock\` |

`NETBLOCK_HOME` overrides all of them, which is how the tests and portable
installs work.

## Transport

One implementation, two deployment modes — the second comes free because it is
the same TCP client pointed at a forwarded local port.

**LAN (default).** The phone listens; the controller connects by IP. Simplest
setup, no cable. The link dies when the lockdown disables Wi-Fi, which is
expected: the durable timer restores.

```
controller ──TCP──▶ phone:8731
```

**USB (optional, Android).** If you have `adb` installed, forward a local port
and point the controller at `127.0.0.1`. This channel survives a full lockdown,
so an explicit RESTORE actually works instead of only the timer.

```bash
adb forward tcp:8731 tcp:8731
netblock pair --host 127.0.0.1 --device <id>
```

`adb` is the only optional external tool in the whole project, and nothing
depends on it: without it you lose the surviving channel, not the lockdown and
not the restore.

## Firewall note

The phone's listener binds `0.0.0.0:8731` by default so the controller can reach
it across the LAN. Bind it to a specific interface with `--host` if you want it
narrower. Authentication does not depend on network position — an unpaired peer
is dropped after its first frame fails to authenticate — but a smaller listening
surface is still worth having.
