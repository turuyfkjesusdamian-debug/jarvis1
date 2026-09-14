package com.jarvis.app

import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream

/**
 * Milestone 1 (login + a manual test message) plus milestone 2 (toggling
 * the "oye jarvis" background listener, JarvisListenerService) — see
 * JARVIS/ARCHITECTURE.md § Decisions.
 */
class MainActivity : AppCompatActivity() {

    private val prefs by lazy { getSharedPreferences("jarvis", MODE_PRIVATE) }
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var api: JarvisApiClient
    private var mediaPlayer: MediaPlayer? = null
    private lateinit var listenerStatus: TextView
    private lateinit var toggleListenerButton: Button

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { granted ->
        // READ_CONTACTS/CALL_PHONE are optional: without them the listener
        // still starts, just the "send a WhatsApp message" / "llama a X"
        // commands won't work until granted later (from the phone's own
        // app settings).
        val optional = setOf(android.Manifest.permission.READ_CONTACTS, android.Manifest.permission.CALL_PHONE)
        val coreGranted = granted.filterKeys { it !in optional }.values.all { it }
        if (coreGranted) {
            startListenerService()
        } else {
            listenerStatus.text = "Se necesita permiso de micrófono (y notificaciones) para escuchar."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val serverUrlInput = findViewById<EditText>(R.id.server_url_input)
        val passwordInput = findViewById<EditText>(R.id.password_input)
        val loginButton = findViewById<Button>(R.id.login_button)
        val loginStatus = findViewById<TextView>(R.id.login_status)
        val testMessageInput = findViewById<EditText>(R.id.test_message_input)
        val sendTestButton = findViewById<Button>(R.id.send_test_button)
        val replyText = findViewById<TextView>(R.id.reply_text)
        val audioStatus = findViewById<TextView>(R.id.audio_status)
        toggleListenerButton = findViewById(R.id.toggle_listener_button)
        listenerStatus = findViewById(R.id.listener_status)

        val savedUrl = prefs.getString("server_url", "")
        serverUrlInput.setText(savedUrl)
        api = JarvisApiClient(savedUrl ?: "")
        api.restoreSession(prefs.getString("session_cookie", null))
        if (api.hasSession()) {
            loginStatus.text = "Sesión guardada. Puedes enviar un mensaje de prueba."
        }

        loginButton.setOnClickListener {
            val url = serverUrlInput.text.toString().trim().trimEnd('/')
            val password = passwordInput.text.toString()
            if (url.isEmpty() || password.isEmpty()) {
                loginStatus.text = "Completa el servidor y la contraseña."
                return@setOnClickListener
            }
            prefs.edit().putString("server_url", url).apply()
            api.setBaseUrl(url)
            loginStatus.text = "Conectando…"

            runInBackground(
                work = { api.login(password) },
                onSuccess = {
                    prefs.edit().putString("session_cookie", api.currentSessionCookie()).apply()
                    loginStatus.text = "Sesión iniciada correctamente."
                },
                onError = { err -> loginStatus.text = "Error: ${err.message}" },
            )
        }

        sendTestButton.setOnClickListener {
            val message = testMessageInput.text.toString().trim()
            if (message.isEmpty()) return@setOnClickListener
            if (!api.hasSession()) {
                replyText.text = "Primero inicia sesión arriba."
                return@setOnClickListener
            }
            replyText.text = "Pensando…"
            audioStatus.text = ""

            runInBackground(
                work = { api.sendMessage(message) },
                onSuccess = { chatReply ->
                    replyText.text = chatReply.reply
                    speak(chatReply.reply, audioStatus)
                },
                onError = { err -> replyText.text = "Error: ${err.message}" },
            )
        }

        updateListenerButtonUi()
        toggleListenerButton.setOnClickListener {
            if (JarvisListenerService.isRunning) {
                stopListenerService()
            } else {
                if (!api.hasSession()) {
                    listenerStatus.text = "Primero inicia sesión arriba."
                    return@setOnClickListener
                }
                requestBatteryOptimizationExemption()
                ensurePermissionsThenStart()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::toggleListenerButton.isInitialized) updateListenerButtonUi()
    }

    private fun ensurePermissionsThenStart() {
        // READ_CONTACTS/CALL_PHONE are requested up front too, even though
        // only the "send a WhatsApp message" / "llama a X" commands need
        // them — a foreground Service can't itself pop a runtime
        // permission dialog, so this is the only chance to ask before
        // those commands are ever spoken.
        val needed = mutableListOf(
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.READ_CONTACTS,
            android.Manifest.permission.CALL_PHONE,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            startListenerService()
        } else {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    /** Without this, MIUI (and stock Android's Doze mode) will kill the listener within minutes. */
    private fun requestBatteryOptimizationExemption() {
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
            try {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            } catch (_: Exception) {
                // Some ROMs (MIUI included) don't support this intent directly —
                // the user then needs to grant it manually from Settings.
            }
        }
    }

    private fun startListenerService() {
        prefs.edit().putBoolean("listener_enabled", true).apply()
        val intent = Intent(this, JarvisListenerService::class.java)
        ContextCompat.startForegroundService(this, intent)
        updateListenerButtonUi(startingNow = true)
    }

    private fun stopListenerService() {
        prefs.edit().putBoolean("listener_enabled", false).apply()
        startService(Intent(this, JarvisListenerService::class.java).setAction(JarvisListenerService.ACTION_STOP))
        updateListenerButtonUi()
    }

    private fun updateListenerButtonUi(startingNow: Boolean = false) {
        val active = startingNow || JarvisListenerService.isRunning
        toggleListenerButton.text = if (active) "Detener escucha en segundo plano" else "Activar escucha en segundo plano"
        listenerStatus.text = if (active) "Escuchando “oye jarvis”…" else "Detenida."
    }

    private fun speak(text: String, audioStatus: TextView) {
        if (text.isBlank()) return
        audioStatus.text = "Generando audio…"
        runInBackground(
            work = { api.synthesizeSpeech(text) },
            onSuccess = { audioBytes -> playAudio(audioBytes, audioStatus) },
            onError = { err -> audioStatus.text = "Audio: ${err.message}" },
        )
    }

    private fun playAudio(bytes: ByteArray, audioStatus: TextView) {
        try {
            val file = File(cacheDir, "jarvis_reply.mp3")
            FileOutputStream(file).use { it.write(bytes) }
            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnPreparedListener {
                    audioStatus.text = "Reproduciendo…"
                    start()
                }
                setOnCompletionListener {
                    audioStatus.text = "Audio reproducido."
                    it.release()
                }
                setOnErrorListener { _, what, extra ->
                    audioStatus.text = "Error al reproducir audio ($what/$extra)"
                    true
                }
                prepareAsync()
            }
        } catch (e: Exception) {
            audioStatus.text = "Error al reproducir audio: ${e.message}"
        }
    }

    /** Runs [work] on a background thread, then delivers the result on the main thread. */
    private fun <T> runInBackground(work: () -> T, onSuccess: (T) -> Unit, onError: (Exception) -> Unit) {
        Thread {
            try {
                val result = work()
                mainHandler.post { onSuccess(result) }
            } catch (e: Exception) {
                mainHandler.post { onError(e) }
            }
        }.start()
    }

    override fun onDestroy() {
        mediaPlayer?.release()
        mediaPlayer = null
        super.onDestroy()
    }
}
