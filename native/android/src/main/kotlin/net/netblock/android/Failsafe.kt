package net.netblock.android

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.io.File
import org.json.JSONObject

/**
 * The fail-safe.
 *
 * The requirement driving this file: no dependency may be able to leave the
 * owner locked out. So restoration must not depend on the app's own service
 * being alive, on a JS runtime, on a network, on a working UI, or even on the
 * engine's state file being readable.
 *
 * Four independent layers, in descending order of precision:
 *
 *  1. The in-process timer in the state machine (fastest, least durable).
 *  2. This AlarmManager alarm, held by the OS. It fires even if the app's
 *     process has been killed, and is armed BEFORE the restrictions are applied.
 *  3. BOOT_COMPLETED, so a reboot inside the hold window still restores.
 *  4. An explicit release broadcast, triggerable over USB with no network, no
 *     listener and no working UI.
 *
 * Layers 2-4 all converge on the same action, and that action degrades safely:
 * it tries a snapshot-accurate restore, and if the snapshot cannot be read it
 * falls back to clearing every restriction this app authored. The fallback uses
 * only `DevicePolicyManager` and `org.json`, both part of the platform, so there
 * is nothing left that can fail to load.
 */
class FailsafeReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val reason = when (action) {
            ACTION_RESTORE_ALARM -> "alarm"
            ACTION_RELEASE -> "release"
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_LOCKED_BOOT_COMPLETED -> "boot"
            else -> return
        }

        // A fenced alarm must prove it belongs to the live transaction, exactly
        // like the TIMEOUT command in the state machine.
        val fence = intent.getStringExtra(EXTRA_LOCKDOWN_ID)

        try {
            Failsafe.run(context, reason, fence)
        } catch (t: Throwable) {
            // Absolute last resort: if anything at all went wrong above, clear
            // our restrictions unconditionally. Being un-restricted is always
            // recoverable; being stuck restricted is not.
            Log.w(TAG, "failsafe path threw; clearing authored restrictions", t)
            runCatching { NetBlockPolicy(context).clearAllAuthoredRestrictions() }
        }
    }

    companion object {
        const val TAG = "NetBlockFailsafe"
        const val ACTION_RESTORE_ALARM = "net.netblock.android.RESTORE_ALARM"

        /**
         * Owner escape hatch, usable with no network and no UI:
         *   adb shell am broadcast -a net.netblock.android.RELEASE \
         *       -n net.netblock.android/.FailsafeReceiver
         */
        const val ACTION_RELEASE = "net.netblock.android.RELEASE"
        const val EXTRA_LOCKDOWN_ID = "lockdownId"
    }
}

object Failsafe {

    /**
     * Decide from durable state alone whether restoration is required, and do
     * it. Never assumes that being invoked means everything is fine.
     */
    fun run(context: Context, reason: String, fence: String?) {
        val policy = NetBlockPolicy(context)
        val record = TransactionFile.readNewestValid(context)

        if (record == null) {
            // Unreadable state: clear what we authored, change no radio's power.
            Log.w(FailsafeReceiver.TAG, "[$reason] no valid transaction record; clearing restrictions")
            policy.clearAllAuthoredRestrictions()
            return
        }

        val state = record.optString("state")
        val activeId = record.optString("activeLockdownId").takeIf { it.isNotEmpty() && it != "null" }

        if (fence != null && activeId != null && fence != activeId) {
            // Lockdown A -> Lockdown B -> Alarm A. Must not restore B.
            Log.i(FailsafeReceiver.TAG, "[$reason] stale fence $fence (active $activeId); ignoring")
            return
        }

        if (state == "IDLE") {
            Log.i(FailsafeReceiver.TAG, "[$reason] already IDLE; nothing to do")
            return
        }

        val deadline = record.optLong("restoreDeadline", 0L)
        if (reason == "alarm" && deadline > 0L && System.currentTimeMillis() < deadline) {
            // Fired early (coalesced or clock-adjusted). Re-arm, change nothing.
            RestoreAlarm.schedule(context, deadline, activeId)
            return
        }

        // Hand the work to the service, which owns the single-writer lock, so
        // this receiver can never race the engine.
        val started = runCatching {
            LockdownService.requestRestore(context, activeId, reason)
        }.isSuccess

        if (!started) {
            // The service could not be started (process restricted, low memory,
            // app crashing on startup). Do the safe subset inline rather than
            // leaving the phone restricted.
            Log.w(FailsafeReceiver.TAG, "[$reason] service unavailable; clearing restrictions inline")
            policy.clearAllAuthoredRestrictions()
        }
    }
}

/** Schedules and cancels the OS-held restore alarm. */
object RestoreAlarm {

    private fun intent(context: Context, lockdownId: String?): PendingIntent {
        val i = Intent(context, FailsafeReceiver::class.java).apply {
            action = FailsafeReceiver.ACTION_RESTORE_ALARM
            putExtra(FailsafeReceiver.EXTRA_LOCKDOWN_ID, lockdownId)
        }
        return PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Armed BEFORE the restrictions are applied, so a crash between arming and
     * applying can only ever result in an extra harmless no-op alarm, never in
     * a lockdown with no scheduled end.
     */
    fun schedule(context: Context, atEpochMs: Long, lockdownId: String?) {
        val am = context.getSystemService(AlarmManager::class.java) ?: return
        val pi = intent(context, lockdownId)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                // Survives Doze, which a plain setExact does not.
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atEpochMs, pi)
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, atEpochMs, pi)
            }
        }.onFailure {
            // Exact alarms can be denied. An inexact alarm is late, not absent,
            // and late is still bounded; falling back is better than no alarm.
            runCatching { am.set(AlarmManager.RTC_WAKEUP, atEpochMs, pi) }
        }

        // A second, later alarm as a backstop. Fenced by the same lockdownId, so
        // if the first already restored, this one is ignored as stale.
        runCatching {
            val backstop = Intent(context, FailsafeReceiver::class.java).apply {
                action = FailsafeReceiver.ACTION_RESTORE_ALARM
                putExtra(FailsafeReceiver.EXTRA_LOCKDOWN_ID, lockdownId)
            }
            val bpi = PendingIntent.getBroadcast(
                context,
                REQUEST_CODE + 1,
                backstop,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            am.set(AlarmManager.RTC_WAKEUP, atEpochMs + BACKSTOP_MS, bpi)
        }
    }

    fun cancel(context: Context) {
        val am = context.getSystemService(AlarmManager::class.java) ?: return
        runCatching { am.cancel(intent(context, null)) }
    }

    private const val REQUEST_CODE = 0x4E42
    private const val BACKSTOP_MS = 5_000L
}

/**
 * Minimal reader for the engine's A/B transaction slots.
 *
 * Intentionally duplicates a little of the engine's logic instead of reusing it:
 * this code runs on the failure paths, so it must not depend on the engine
 * loading. It uses only java.io and org.json, both part of the platform.
 */
object TransactionFile {

    fun readNewestValid(context: Context): JSONObject? {
        val dir = File(context.filesDir, "netblock")
        val candidates = listOf("txn.a.json", "txn.b.json").mapNotNull { name ->
            runCatching {
                val file = File(dir, name)
                if (!file.isFile) return@runCatching null
                val envelope = JSONObject(file.readText())
                val payload = envelope.getString("payload")
                if (Crc32.hex(payload) != envelope.getString("crc")) return@runCatching null
                JSONObject(payload)
            }.getOrNull()
        }
        return candidates.maxByOrNull { it.optLong("seq", -1L) }
    }
}

/** CRC-32, matching the engine's envelope checksum byte for byte. */
object Crc32 {
    fun hex(input: String): String {
        val crc = java.util.zip.CRC32()
        crc.update(input.toByteArray(Charsets.UTF_8))
        return crc.value.toString(16).padStart(8, '0')
    }
}
