package net.netblock.android

import android.app.admin.DevicePolicyManager
import android.bluetooth.BluetoothManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.UserManager
import android.telephony.TelephonyManager

/**
 * The ONLY class in the Android app that touches connectivity.
 *
 * Every operation here maps onto one documented public platform API. There is no
 * reflection, no hidden API, no shell invocation and no root path. If the
 * platform does not expose an operation to this app, it is reported
 * UNSUPPORTED_BY_OS and never attempted.
 *
 * All state changes are made through DevicePolicyManager user restrictions
 * wherever possible, for one reason that matters more than convenience: a user
 * restriction set by this admin can be read back with
 * `DevicePolicyManager.getUserRestrictions(admin)`. That makes "which
 * restrictions did WE create?" a fact we can query rather than a guess, which is
 * what lets the release valve clear exactly our own changes and nothing else.
 *
 * It never deletes a saved network, a Wi-Fi key, a Bluetooth pairing, a hotspot
 * configuration or a SIM/eSIM profile. It has no code path that could.
 */
class NetBlockPolicy(private val context: Context) {

    enum class Capability { WIFI, CELLULAR, BLUETOOTH, NFC, NEARBY_SHARING, HOTSPOT }

    enum class Support { SUPPORTED, UNSUPPORTED_BY_OS, REQUIRES_PRIVILEGE }

    data class CapabilityReport(
        val capability: Capability,
        val support: Support,
        val mechanism: String,
        val note: String,
    )

    data class ApplyResult(
        val ok: Boolean,
        val changed: Boolean,
        val unsupported: Boolean = false,
        val error: String? = null,
    )

    private val admin: ComponentName = ComponentName(context, NetBlockDeviceAdmin::class.java)
    private val dpm = context.getSystemService(DevicePolicyManager::class.java)
    private val userManager = context.getSystemService(UserManager::class.java)
    private val wifiManager = context.applicationContext.getSystemService(WifiManager::class.java)
    private val telephony = context.getSystemService(TelephonyManager::class.java)
    private val bluetooth = context.getSystemService(BluetoothManager::class.java)

    val isDeviceOwner: Boolean
        get() = runCatching { dpm?.isDeviceOwnerApp(context.packageName) == true }.getOrDefault(false)

    val isProfileOwner: Boolean
        get() = runCatching { dpm?.isProfileOwnerApp(context.packageName) == true }.getOrDefault(false)

    // ---------------------------------------------------------------------
    // Restriction keys we are willing to author. Nothing outside this set is
    // ever set or cleared, so the app cannot alter unrelated device policy.
    // ---------------------------------------------------------------------

    private fun restrictionsFor(capability: Capability): List<String> = when (capability) {
        Capability.WIFI -> buildList {
            add(UserManager.DISALLOW_CONFIG_WIFI)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(UserManager.DISALLOW_CHANGE_WIFI_STATE)
            }
        }
        Capability.BLUETOOTH -> listOf(UserManager.DISALLOW_BLUETOOTH)
        Capability.HOTSPOT -> buildList {
            add(UserManager.DISALLOW_CONFIG_TETHERING)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(UserManager.DISALLOW_WIFI_TETHERING)
            }
        }
        // No public restriction or API disables these. Deliberately empty.
        Capability.CELLULAR, Capability.NFC, Capability.NEARBY_SHARING -> emptyList()
    }

    /** Every restriction key this app is capable of authoring. */
    private val authorableKeys: Set<String> =
        Capability.entries.flatMap { restrictionsFor(it) }.toSet()

    // ---------------------------------------------------------------------
    // Capability detection
    // ---------------------------------------------------------------------

    /**
     * What this build may actually do on this device. Determined from the real
     * management role, API level and present hardware. The authoritative answer
     * for any individual operation is still the result the OS returns when it is
     * attempted, which is why every apply() reports its own outcome.
     */
    fun capabilities(): List<CapabilityReport> = Capability.entries.map { capability ->
        when (capability) {
            Capability.NFC -> CapabilityReport(
                capability,
                Support.UNSUPPORTED_BY_OS,
                "none",
                "Android exposes no public API, for apps or Device Owners, that powers the NFC radio off",
            )

            Capability.NEARBY_SHARING -> CapabilityReport(
                capability,
                Support.UNSUPPORTED_BY_OS,
                "none",
                "Nearby Share exposes no public toggle; suspending its provider package would be destructive and is not attempted",
            )

            Capability.CELLULAR -> when {
                !hasFeature(PackageManager.FEATURE_TELEPHONY) -> CapabilityReport(
                    capability, Support.UNSUPPORTED_BY_OS, "none", "no cellular hardware",
                )
                hasCarrierPrivileges() -> CapabilityReport(
                    capability,
                    Support.SUPPORTED,
                    "android.TelephonyManager",
                    "TelephonyManager.setDataEnabled via UICC carrier privileges; SIM/eSIM profiles untouched",
                )
                else -> CapabilityReport(
                    capability,
                    Support.REQUIRES_PRIVILEGE,
                    "none",
                    "disabling cellular data needs UICC carrier privileges or a platform-signed build; Device Owner alone is not sufficient",
                )
            }

            Capability.WIFI -> requireOwner(
                capability,
                "android.DevicePolicyManager",
                "WifiManager.setWifiEnabled plus DISALLOW_CONFIG_WIFI; saved networks and keys untouched",
                "Wi-Fi control requires Device Owner or Profile Owner; an ordinary install cannot toggle Wi-Fi on API 29+",
                allowProfileOwner = true,
            )

            Capability.BLUETOOTH -> when {
                !hasFeature(PackageManager.FEATURE_BLUETOOTH) -> CapabilityReport(
                    capability, Support.UNSUPPORTED_BY_OS, "none", "no Bluetooth hardware",
                )
                else -> requireOwner(
                    capability,
                    "android.DevicePolicyManager",
                    "UserManager.DISALLOW_BLUETOOTH via Device Owner; pairings are preserved",
                    "Bluetooth control requires Device Owner; apps targeting API 33+ cannot call BluetoothAdapter.disable()",
                    allowProfileOwner = false,
                )
            }

            Capability.HOTSPOT -> requireOwner(
                capability,
                "android.DevicePolicyManager",
                "DISALLOW_CONFIG_TETHERING, plus DISALLOW_WIFI_TETHERING on API 33+; hotspot SSID and password untouched",
                "tethering restrictions require Device Owner",
                allowProfileOwner = false,
            )
        }
    }

    private fun requireOwner(
        capability: Capability,
        mechanism: String,
        note: String,
        privilegeNote: String,
        allowProfileOwner: Boolean,
    ): CapabilityReport {
        val ok = isDeviceOwner || (allowProfileOwner && isProfileOwner)
        return if (ok) {
            CapabilityReport(capability, Support.SUPPORTED, mechanism, note)
        } else {
            CapabilityReport(capability, Support.REQUIRES_PRIVILEGE, "none", privilegeNote)
        }
    }

    private fun hasFeature(feature: String): Boolean =
        runCatching { context.packageManager.hasSystemFeature(feature) }.getOrDefault(false)

    private fun hasCarrierPrivileges(): Boolean =
        runCatching { telephony?.hasCarrierPrivileges() == true }.getOrDefault(false)

    // ---------------------------------------------------------------------
    // State capture. Returns only ON/OFF/UNKNOWN plus policy booleans: there is
    // no field here that could carry an SSID, a key or a SIM identifier.
    // ---------------------------------------------------------------------

    data class Reading(val enabled: String, val autoJoinAllowed: Boolean? = null, val discoverable: Boolean? = null)

    fun readState(): Map<Capability, Reading> {
        val out = mutableMapOf<Capability, Reading>()

        out[Capability.WIFI] = runCatching {
            Reading(
                enabled = if (wifiManager?.isWifiEnabled == true) "ON" else "OFF",
                autoJoinAllowed = !hasRestriction(UserManager.DISALLOW_CONFIG_WIFI),
            )
        }.getOrDefault(Reading("UNKNOWN"))

        out[Capability.BLUETOOTH] = runCatching {
            val adapter = bluetooth?.adapter
            Reading(enabled = if (adapter?.isEnabled == true) "ON" else "OFF")
        }.getOrDefault(Reading("UNKNOWN"))

        out[Capability.CELLULAR] = runCatching {
            // isDataEnabled requires carrier privileges or a privileged build;
            // without them we report UNKNOWN rather than inventing a value.
            if (hasCarrierPrivileges()) {
                Reading(enabled = if (telephony?.isDataEnabled == true) "ON" else "OFF")
            } else {
                Reading("UNKNOWN")
            }
        }.getOrDefault(Reading("UNKNOWN"))

        out[Capability.HOTSPOT] = Reading(
            enabled = if (hasRestriction(UserManager.DISALLOW_CONFIG_TETHERING)) "OFF" else "ON",
        )

        // Honestly unknown: we cannot read these, so we never claim to.
        out[Capability.NFC] = Reading("UNKNOWN")
        out[Capability.NEARBY_SHARING] = Reading("UNKNOWN")
        return out
    }

    private fun hasRestriction(key: String): Boolean =
        runCatching { userManager?.hasUserRestriction(key) == true }.getOrDefault(false)

    // ---------------------------------------------------------------------
    // Apply / restore. Always an explicit target value, never a toggle.
    // ---------------------------------------------------------------------

    fun apply(capability: Capability, enabled: Boolean): ApplyResult {
        val report = capabilities().first { it.capability == capability }
        if (report.support != Support.SUPPORTED) {
            return ApplyResult(ok = false, changed = false, unsupported = true, error = report.note)
        }
        val dpmLocal = dpm ?: return ApplyResult(false, false, error = "no DevicePolicyManager")

        return runCatching {
            var changed = false

            // 1. Policy restrictions, which are attributable and reversible.
            for (key in restrictionsFor(capability)) {
                val had = hasRestriction(key)
                if (!enabled && !had) {
                    dpmLocal.addUserRestriction(admin, key)
                    changed = true
                } else if (enabled && had) {
                    dpmLocal.clearUserRestriction(admin, key)
                    changed = true
                }
            }

            // 2. Radio power, where an official API exists for our role.
            when (capability) {
                Capability.WIFI -> {
                    val before = wifiManager?.isWifiEnabled
                    if (before != null && before != enabled) {
                        // Permitted for Device Owner / Profile Owner even when
                        // targeting API 29+. Returns false if it was refused.
                        @Suppress("DEPRECATION")
                        val accepted = wifiManager.setWifiEnabled(enabled)
                        if (!accepted) {
                            return@runCatching ApplyResult(
                                ok = false, changed = changed,
                                error = "setWifiEnabled refused by the platform",
                            )
                        }
                        changed = true
                    }
                }

                Capability.CELLULAR -> {
                    val before = runCatching { telephony?.isDataEnabled }.getOrNull()
                    if (before != null && before != enabled) {
                        @Suppress("DEPRECATION")
                        telephony?.setDataEnabled(enabled)
                        changed = true
                    }
                }

                Capability.BLUETOOTH -> {
                    // DISALLOW_BLUETOOTH turns the radio off and holds it off.
                    // Pairings are untouched; no unpair call exists in this app.
                    // Active links drop as a consequence of the radio powering
                    // down, which is the documented behaviour.
                }

                else -> Unit
            }

            ApplyResult(ok = true, changed = changed)
        }.getOrElse { throwable ->
            ApplyResult(
                ok = false,
                changed = false,
                error = throwable.javaClass.simpleName + ": " + (throwable.message ?: "").take(120),
            )
        }
    }

    // ---------------------------------------------------------------------
    // The release valve
    // ---------------------------------------------------------------------

    /**
     * Restrictions this admin currently has in force, read back from the
     * platform. This is a fact, not an assumption, which is what makes clearing
     * them safe: they exist only because we created them.
     */
    fun authoredRestrictions(): Set<String> = runCatching {
        val bundle = dpm?.getUserRestrictions(admin) ?: return@runCatching emptySet()
        bundle.keySet().filter { it in authorableKeys && bundle.getBoolean(it) }.toSet()
    }.getOrDefault(emptySet())

    /**
     * Clear every restriction this app authored, and nothing else.
     *
     * Deliberately does NOT switch any radio on. A Wi-Fi radio that is off may
     * be off because the owner wanted it off, and this path cannot tell the
     * difference. Clearing the restriction hands control back to the owner,
     * which is both safe and sufficient.
     *
     * Kept free of every dependency it can be, because this runs on the paths
     * that execute when everything else has failed.
     */
    fun clearAllAuthoredRestrictions(): Map<String, Boolean> {
        val results = mutableMapOf<String, Boolean>()
        val dpmLocal = dpm ?: return results
        for (key in authoredRestrictions()) {
            results[key] = runCatching { dpmLocal.clearUserRestriction(admin, key) }.isSuccess
        }
        return results
    }
}
