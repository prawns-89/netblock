# What actually works, per platform and tier

The honest matrix. Nothing here is aspirational, and the code reports these same
answers at runtime rather than trusting this table — `getCapabilities()` asks the
device, and the authoritative answer for any single operation is the result the
OS returns when it is attempted.

Legend: **YES** = official public API, works. **PRIV** = official API exists but
this build lacks the role. **NO** = the platform exposes no official API at all;
reported `UNSUPPORTED_BY_OS` and never attempted.

## Android

| Capability | Normal install | Profile Owner | **Device Owner** | Mechanism |
|---|---|---|---|---|
| Wi-Fi off | NO (API 29+) | YES | **YES** | `WifiManager.setWifiEnabled` + `DISALLOW_CONFIG_WIFI` |
| Wi-Fi auto-join block | NO | YES | **YES** | `DISALLOW_CONFIG_WIFI`, `DISALLOW_CHANGE_WIFI_STATE` (API 33+) |
| Cellular data off | NO | NO | PRIV | `TelephonyManager.setDataEnabled` — needs UICC carrier privileges or a platform-signed build |
| Bluetooth off | NO (API 33+) | PRIV | **YES** | `UserManager.DISALLOW_BLUETOOTH` |
| Bluetooth disconnect links | — | — | **YES** (consequence) | the radio powering down drops links; no unpair call exists in the app |
| NFC off | **NO** | **NO** | **NO** | no public API exists for apps *or* Device Owners |
| Nearby Share off | **NO** | **NO** | **NO** | no public toggle; suspending the provider package would be destructive and is not attempted |
| Hotspot / tethering off | NO | NO | **YES** | `DISALLOW_CONFIG_TETHERING`, `DISALLOW_WIFI_TETHERING` (API 33+) |

So on a Device Owner phone you get **Wi-Fi, Bluetooth and hotspot**, which is
the large majority of the attack surface a connectivity lockdown is about.
Cellular needs carrier privileges; NFC and Nearby Share are simply not
available to anyone outside the platform, and the code says so.

### Why Device Owner, and what it costs you

Device Owner is the documented Android mechanism for an owner to hold policy
over their own device. It is not a bypass or an exploit. The cost is a one-time
**factory reset** per phone, because Device Owner can only be provisioned on a
device with no configured accounts. See
[ANDROID-PROVISIONING.md](ANDROID-PROVISIONING.md).

Everything Device Owner authors here is a *user restriction*, chosen
specifically because restrictions can be read back with
`DevicePolicyManager.getUserRestrictions(admin)`. That makes "which changes were
ours?" a fact rather than a guess, which is what lets the release valve clear
exactly our own changes and nothing else.

### Cellular, honestly

There is a documented Device-Owner-available way to cut traffic without the
cellular API: an always-on VPN with a null route
(`setAlwaysOnVpnPackage`, with `lockdownEnabled`). It is official and not a
bypass. It is **not implemented here**, because it is a different thing from
"disable cellular data" and shipping it under that name would be exactly the
kind of pretending this project avoids. It is a reasonable extension if you
decide you want it; it would be a new capability with its own honest name.

## iOS

Skipped by decision. The adapter and its capability matrix stay in the tree so
the interface is ready, but there is no Swift code and no Xcode project.

For the record, so the decision is re-checkable:

| Capability | Sideloaded app | Supervised + MDM |
|---|---|---|
| Wi-Fi off | **NO** | **NO** — MDM cannot power the radio off |
| Wi-Fi auto-join restrict | NO | partial (`forceWiFiToAllowedNetworksOnly`, supervised, iOS 14.5+) |
| Cellular data off | **NO** | **NO** |
| Bluetooth off | **NO** | **NO** — `allowBluetoothModification` locks the toggle, it does not switch Bluetooth off |
| NFC off | **NO** | **NO** |
| AirDrop off | NO | YES (`allowAirDrop`) |
| Personal Hotspot block | NO | YES (`allowPersonalHotspotModification`) |

Two consequences worth being blunt about:

1. A user-installed iOS app can do **nothing** here. Not restricted — nothing.
2. The MDM path is **not peer-to-peer**. Pushing a restriction requires Apple's
   push service, so it needs an APNs certificate and an HTTPS endpoint, which
   contradicts the device-to-device design. That is why it is not the default.

## Controller platforms

The controller is plain Node with no dependencies and no POSIX assumptions, so
all three host OSes work identically. See [PLATFORMS.md](PLATFORMS.md).
