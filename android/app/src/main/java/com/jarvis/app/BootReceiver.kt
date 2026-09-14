package com.jarvis.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * Restarts the "oye jarvis" listener after a reboot, if the user had it
 * turned on — otherwise reopening the app and tapping the button every
 * time the phone restarts would defeat the point of a background
 * listener. See JARVIS/ARCHITECTURE.md § Decisions.
 *
 * On MIUI this still depends on the phone's separate "Inicio automático"
 * (autostart) permission being granted for JARVIS — without it, MIUI
 * won't even deliver this broadcast to the app, same restriction that
 * applies to keeping the listener alive while the phone stays on.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences("jarvis", Context.MODE_PRIVATE)
        val wasEnabled = prefs.getBoolean("listener_enabled", false)
        val hasSession = prefs.getString("session_cookie", null) != null
        if (wasEnabled && hasSession) {
            ContextCompat.startForegroundService(context, Intent(context, JarvisListenerService::class.java))
        }
    }
}
