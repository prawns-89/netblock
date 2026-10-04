package net.netblock.android

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Device admin receiver. Required for Device Owner provisioning; it holds no
 * policy of its own.
 *
 * `onDisabled` is the important one: if admin is ever revoked, the restrictions
 * we authored would otherwise be left in force with no way for us to clear
 * them. So we clear them on the way out.
 */
class NetBlockDeviceAdmin : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        Log.i(TAG, "device admin enabled")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        // Last chance to let the owner out before we lose the ability to.
        Log.w(TAG, "device admin disabled; clearing authored restrictions")
        runCatching {
            RestoreAlarm.cancel(context)
            NetBlockPolicy(context).clearAllAuthoredRestrictions()
        }
    }

    companion object {
        private const val TAG = "NetBlockAdmin"
    }
}
