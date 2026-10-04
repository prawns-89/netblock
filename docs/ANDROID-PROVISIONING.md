# Android setup — the parts you have to do by hand

One-time, per phone. Everything after this is automatic.

## What you will need

- `adb` (Android platform-tools) on your laptop — Linux, Windows or macOS.
- A phone you are willing to **factory reset**. This is unavoidable: Android
  only allows Device Owner provisioning on a device with no configured accounts.
  That restriction is the whole reason Device Owner is trustworthy.
- Both devices on the same Wi-Fi network.

## Steps

**1. Build the APK.** Standard Android Gradle project around
`native/android/`. There are no third-party dependencies to resolve.

**2. Factory reset the phone.** Settings → System → Reset. On the setup wizard,
**skip** Google sign-in and skip adding any account. Stop at the home screen.

**3. Enable developer options and USB debugging.** Settings → About phone → tap
Build number seven times, then Settings → System → Developer options → USB
debugging.

**4. Install and provision as Device Owner.**

```bash
adb install -r netblock.apk
adb shell dpm set-device-owner net.netblock.android/.NetBlockDeviceAdmin
```

Expect `Success: Device owner set to package net.netblock.android`. If you
instead get `Not allowed to set the device owner because there are already
some accounts on the device`, an account got added during setup — reset and
skip more carefully.

**5. Allow exact alarms.** Settings → Apps → NetBlock → Alarms & reminders →
allow. Without it the restore alarm becomes inexact: late rather than absent,
but exactness is what you want for a 50-second hold.

**6. Disable battery optimisation** for NetBlock, so Doze cannot defer the
service. Settings → Apps → NetBlock → Battery → Unrestricted.

**7. Pair.** Open NetBlock on the phone, tap Pair. It shows a pairing code, a
device id and a fingerprint. On your laptop:

```bash
netblock pair --host <phone-lan-ip> --device <device-id> --label "My Pixel"
```

Paste the code when prompted. **Compare the fingerprint on both screens and only
confirm if they match** — this is what rules out a man-in-the-middle, and it is
the one step you should not rush.

**8. Check what you actually got.**

```bash
netblock status
```

It prints the real capability matrix for that phone. On a Device Owner phone
expect `SUPPORTED` for wifi, bluetooth and hotspot, and `UNSUPPORTED_BY_OS` for
nfc and nearbySharing. Cellular will be `REQUIRES_PRIVILEGE` unless the app
holds UICC carrier privileges. That is the honest answer, not a misconfiguration.

## Removing it

```bash
adb shell dpm remove-active-admin net.netblock.android/.NetBlockDeviceAdmin
```

`onDisabled` clears every restriction the app authored on the way out, so this
cannot leave you locked out. Then uninstall normally.

## If you are ever locked out

With no network, no listener and no working UI:

```bash
adb shell am broadcast -a net.netblock.android.RELEASE \
    -n net.netblock.android/.FailsafeReceiver
```

See [SAFETY.md](SAFETY.md) for the full set of fail-safe layers.
