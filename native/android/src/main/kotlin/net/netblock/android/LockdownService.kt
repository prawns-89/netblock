package net.netblock.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * The on-device service.
 *
 * Single-writer discipline is enforced the same way as in the reference engine,
 * by construction rather than by convention: every state-changing operation is
 * submitted to ONE single-threaded executor. Network callbacks, the alarm
 * receiver, the boot receiver and the settings screen all submit here, and none
 * of them touches `NetBlockPolicy` directly.
 *
 * Silence: no countdown, no progress, no sound, no vibration, no banner beyond
 * what the OS itself requires. Android requires a notification for a foreground
 * service, so we use the minimum permitted form — IMPORTANCE_MIN, silent, no
 * badge, no vibration, no timestamp — rather than attempting to hide it, which
 * would be both futile and a policy violation.
 */
class LockdownService : Service() {

    /** The single writer. Serial by construction. */
    private val writer = Executors.newSingleThreadExecutor { r ->
        Thread(r, "netblock-writer").apply { isDaemon = false }
    }

    private lateinit var policy: NetBlockPolicy

    override fun onCreate() {
        super.onCreate()
        policy = NetBlockPolicy(this)
        startForeground(NOTIFICATION_ID, buildMinimalNotification())

        // Never assume "started means fine": reconcile durable state first.
        submit("startup-recovery") { Failsafe.run(this, "startup", null) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_RESTORE -> {
                val fence = intent.getStringExtra(EXTRA_LOCKDOWN_ID)
                val reason = intent.getStringExtra(EXTRA_REASON) ?: "unknown"
                submit("restore:$reason") { performRestore(fence, reason) }
            }

            ACTION_RELEASE -> submit("release") {
                RestoreAlarm.cancel(this)
                policy.clearAllAuthoredRestrictions()
            }
        }
        // START_STICKY: if the OS kills us, it should bring us back, because the
        // engine's recovery runs in onCreate.
        return START_STICKY
    }

    /** Queue work on the single writer. Returns a handle for tests. */
    private fun submit(label: String, work: () -> Unit): Future<*> = writer.submit {
        runCatching(work).onFailure { Log.w(TAG, "[$label] failed", it) }
    }

    /**
     * Restore from the persisted snapshot: explicit recorded values only, never
     * a toggle, and never a capability this transaction did not modify.
     */
    private fun performRestore(fence: String?, reason: String) {
        val record = TransactionFile.readNewestValid(this)
        if (record == null) {
            policy.clearAllAuthoredRestrictions()
            return
        }

        val activeId = record.optString("activeLockdownId").takeIf { it.isNotEmpty() && it != "null" }
        if (fence != null && activeId != null && fence != activeId) {
            Log.i(TAG, "[$reason] stale fence; ignoring")
            return
        }

        val snapshot = record.optJSONObject("snapshot")
        if (snapshot == null) {
            policy.clearAllAuthoredRestrictions()
            return
        }

        val modified = snapshot.optJSONArray("successfullyModifiedCapabilities")
        if (modified == null || modified.length() == 0) {
            policy.clearAllAuthoredRestrictions()
            return
        }

        for (i in 0 until modified.length()) {
            val name = modified.optString(i)
            val capability = toCapability(name) ?: continue
            val field = snapshotField(name)
            val prior = snapshot.optJSONObject(field) ?: continue
            when (prior.optString("enabled")) {
                // Explicit target taken from the snapshot. A capability that was
                // already off beforehand is not in this list at all, so this can
                // never switch something on that the owner had off.
                "ON" -> policy.apply(capability, enabled = true)
                "OFF" -> policy.apply(capability, enabled = false)
                else -> Log.i(TAG, "no trustworthy prior value for $name; leaving it alone")
            }
        }

        RestoreAlarm.cancel(this)
    }

    private fun toCapability(name: String): NetBlockPolicy.Capability? = when (name) {
        "wifi" -> NetBlockPolicy.Capability.WIFI
        "cellular" -> NetBlockPolicy.Capability.CELLULAR
        "bluetooth" -> NetBlockPolicy.Capability.BLUETOOTH
        "nfc" -> NetBlockPolicy.Capability.NFC
        "nearbySharing" -> NetBlockPolicy.Capability.NEARBY_SHARING
        "hotspot" -> NetBlockPolicy.Capability.HOTSPOT
        else -> null
    }

    private fun snapshotField(name: String): String = when (name) {
        "nearbySharing" -> "nearbySharingState"
        else -> name + "State"
    }

    /**
     * The minimum notification Android permits for a foreground service.
     * No countdown, no progress bar, no sound, no vibration, no badge, no
     * timestamp, and lowest importance so it does not appear on the lock screen
     * or as a heads-up alert.
     */
    private fun buildMinimalNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                setShowBadge(false)
                enableVibration(false)
                enableLights(false)
                setSound(null, null)
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setSmallIcon(R.drawable.ic_netblock_status)
            .setContentTitle(getString(R.string.service_running))
            .setOngoing(true)
            .setShowWhen(false)
            .setSilent(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_SECRET)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        // Do not leave queued work unfinished: a half-applied transaction must
        // not outlive the process that was managing it.
        writer.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "NetBlockService"
        private const val CHANNEL_ID = "netblock.status"
        private const val NOTIFICATION_ID = 0x4E42
        const val ACTION_RESTORE = "net.netblock.android.SERVICE_RESTORE"
        const val ACTION_RELEASE = "net.netblock.android.SERVICE_RELEASE"
        const val EXTRA_LOCKDOWN_ID = "lockdownId"
        const val EXTRA_REASON = "reason"

        /** Called from the receivers. Throws if the service cannot be started. */
        fun requestRestore(context: Context, lockdownId: String?, reason: String) {
            val intent = Intent(context, LockdownService::class.java).apply {
                action = ACTION_RESTORE
                putExtra(EXTRA_LOCKDOWN_ID, lockdownId)
                putExtra(EXTRA_REASON, reason)
            }
            context.startForegroundService(intent)
        }
    }
}
