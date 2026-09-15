package com.jarvis.app

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaPlayer
import android.media.audiofx.Visualizer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream
import kotlin.math.sqrt

/** Shared with JarvisListenerService's own default for the same "jarvis_volume" pref key. */
private const val DEFAULT_VOLUME_PERCENT = 80

/**
 * Milestone 1 (login + chat) plus milestone 2 (toggling the "oye jarvis"
 * background listener, JarvisListenerService) — see JARVIS/ARCHITECTURE.md
 * § Decisions. The screen is a native port of the web UI's look (topbar
 * with status pills, the purple particle orb, a scrolling conversation,
 * a pill-shaped input row) via [OrbView] and the drawables under
 * res/drawable — same visual language, not a WebView embedding it, per
 * the user's choice.
 */
class MainActivity : AppCompatActivity() {

    private val prefs by lazy { getSharedPreferences("jarvis", MODE_PRIVATE) }
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var api: JarvisApiClient
    private var mediaPlayer: MediaPlayer? = null
    private var visualizer: Visualizer? = null

    private lateinit var orbView: OrbView
    private lateinit var connStatusPill: TextView
    private lateinit var listenStatusPill: TextView
    private lateinit var listenerStatus: TextView
    private lateinit var toggleListenerButton: Button
    private lateinit var conversationScroll: ScrollView
    private lateinit var conversationContainer: LinearLayout
    private lateinit var conversationHint: TextView
    private lateinit var audioStatus: TextView
    private lateinit var detailsPanel: LinearLayout
    private lateinit var detailsToggle: TextView
    private lateinit var splashScreen: View
    private lateinit var loginScreen: View
    private lateinit var mainScreenRoot: View

    companion object {
        /**
         * Kept here as plain user-facing text, not generated from the regexes
         * in JarvisListenerService.kt — update both together when a command
         * changes. See JARVIS/ARCHITECTURE.md § Decisions for the full list.
         */
        private const val COMMANDS_HELP_TEXT = """No hace falta decir estas frases exactamente como están escritas — JARVIS entiende variantes razonables, y si dices algo que no calza con ninguna, intenta entender igual qué quieres hacer antes de solo contestarte por chat.

“Oye JARVIS” + tu pregunta o mensaje
Habla con JARVIS normalmente — memoria, tareas, agenda, o charla general.

“Oye JARVIS, envíale un mensaje a [nombre] que diga [mensaje]”
Prepara un mensaje de WhatsApp. Pide confirmación antes de abrir WhatsApp.

“Oye JARVIS, llama a [nombre]”
Hace una llamada real. Pide confirmación antes de marcar.

“Oye JARVIS, abre [app]”
Abre cualquier app instalada por su nombre.

“Oye JARVIS, abre [app] y reproduce [algo]”
Abre la app y busca dentro (solo funciona de verdad en YouTube y Spotify).

“Oye JARVIS, reproduce/busca [algo] en YouTube”
Abre los resultados de esa búsqueda en YouTube.

“Oye JARVIS, cómo llego a [lugar]”
Abre la ruta en Google Maps desde tu ubicación actual.

“Oye JARVIS, cómo llego de [lugar] a [lugar]”
Abre la ruta entre esos dos puntos en Google Maps.

“Oye JARVIS, busca [algo] cerca”
Abre una búsqueda cercana a ti en Google Maps.

“Oye JARVIS, toca [algo]” / “aprieta [algo]”
Toca ese botón o elemento en la pantalla actual (requiere activar el permiso de accesibilidad en Detalles). Si no lo encuentra por su nombre, intenta ver la pantalla para ubicarlo igual.

“Oye JARVIS, qué dice esto” / “quién me escribió” / preguntas sobre la pantalla
JARVIS mira la pantalla actual y responde (mismo permiso de accesibilidad).

“Oye JARVIS, recuérdame que…”
Guarda ese dato en la memoria permanente de JARVIS.

“Oye JARVIS, olvida que…”
Busca ese dato guardado y pide confirmación antes de borrarlo.

“Jarvis, apágate”
Detiene la escucha en segundo plano y cierra la app por completo."""
    }

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

        splashScreen = findViewById(R.id.splash_screen)
        loginScreen = findViewById(R.id.login_screen)
        mainScreenRoot = findViewById(R.id.main_screen)
        val startButton = findViewById<Button>(R.id.start_button)
        val loginServerUrlInput = findViewById<EditText>(R.id.login_server_url_input)
        val loginPasswordInput = findViewById<EditText>(R.id.login_password_input)
        val loginScreenButton = findViewById<Button>(R.id.login_screen_button)
        val loginScreenStatus = findViewById<TextView>(R.id.login_screen_status)

        orbView = findViewById(R.id.orb_view)
        connStatusPill = findViewById(R.id.conn_status_pill)
        listenStatusPill = findViewById(R.id.listen_status_pill)
        conversationScroll = findViewById(R.id.conversation_scroll)
        conversationContainer = findViewById(R.id.conversation_container)
        conversationHint = findViewById(R.id.conversation_hint)
        val chatInput = findViewById<EditText>(R.id.chat_input)
        val sendButton = findViewById<Button>(R.id.send_button)
        audioStatus = findViewById(R.id.audio_status)
        toggleListenerButton = findViewById(R.id.toggle_listener_button)
        listenerStatus = findViewById(R.id.listener_status)
        detailsToggle = findViewById(R.id.details_toggle)
        detailsPanel = findViewById(R.id.details_panel)
        val commandsToggle = findViewById<TextView>(R.id.commands_toggle)
        val speakRepliesSwitch = findViewById<Switch>(R.id.speak_replies_switch)
        val volumeSeekBar = findViewById<SeekBar>(R.id.volume_seek_bar)
        val accessibilityButton = findViewById<Button>(R.id.accessibility_button)
        val changeServerButton = findViewById<Button>(R.id.change_server_button)

        val savedUrl = prefs.getString("server_url", "")
        loginServerUrlInput.setText(savedUrl)
        api = JarvisApiClient(savedUrl ?: "")
        api.restoreSession(prefs.getString("session_cookie", null))
        setConnected(api.hasSession())

        // Splash -> straight to the chat if already logged in from before,
        // otherwise the login screen. Never dumps the full chat UI on the
        // user immediately, per their request.
        startButton.setOnClickListener {
            if (api.hasSession()) showMainScreen() else showLoginScreen()
        }

        loginScreenButton.setOnClickListener {
            val url = loginServerUrlInput.text.toString().trim().trimEnd('/')
            val password = loginPasswordInput.text.toString()
            if (url.isEmpty() || password.isEmpty()) {
                loginScreenStatus.text = "Completa el servidor y la contraseña."
                return@setOnClickListener
            }
            prefs.edit().putString("server_url", url).apply()
            api.setBaseUrl(url)
            loginScreenStatus.text = "Conectando…"

            runInBackground(
                work = { api.login(password) },
                onSuccess = {
                    prefs.edit().putString("session_cookie", api.currentSessionCookie()).apply()
                    setConnected(true)
                    showMainScreen()
                },
                onError = { err ->
                    loginScreenStatus.text = "Error: ${err.message}"
                    setConnected(false)
                },
            )
        }

        // Lets the user come back to the login screen later (from "Detalles")
        // to change the server URL or re-enter the password, e.g. after it
        // rotates or the session expires.
        changeServerButton.setOnClickListener { showLoginScreen() }

        // Android has no in-app toggle for accessibility services (unlike
        // SYSTEM_ALERT_WINDOW's Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        // which can target this package directly) — this just deep-links to
        // the general list, where the user picks "JARVIS" and turns it on.
        accessibilityButton.setOnClickListener {
            try {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            } catch (_: Exception) {
                // Not supported on this ROM — "toca X" just keeps failing with
                // "no tengo el permiso de accesibilidad".
            }
        }

        detailsToggle.setOnClickListener {
            val opening = detailsPanel.visibility != View.VISIBLE
            detailsPanel.visibility = if (opening) View.VISIBLE else View.GONE
            detailsToggle.text = if (opening) "Detalles ▴" else "Detalles ▾"
        }

        // Separate from "Detalles" on purpose — this is a reference for the
        // user, not something to configure, so it lives in its own dialog
        // rather than sharing the settings panel.
        commandsToggle.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("Comandos de JARVIS")
                .setMessage(COMMANDS_HELP_TEXT)
                .setPositiveButton("Cerrar", null)
                .show()
        }

        speakRepliesSwitch.isChecked = prefs.getBoolean("speak_replies_enabled", true)
        speakRepliesSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("speak_replies_enabled", checked).apply()
        }

        // Shared with JarvisListenerService (same "jarvis" SharedPreferences
        // file, same "jarvis_volume" key) so the background listener's voice
        // matches whatever the user sets here.
        volumeSeekBar.progress = prefs.getInt("jarvis_volume", DEFAULT_VOLUME_PERCENT)
        volumeSeekBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser) prefs.edit().putInt("jarvis_volume", progress).apply()
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) {}
        })

        sendButton.setOnClickListener {
            val message = chatInput.text.toString().trim()
            if (message.isEmpty()) return@setOnClickListener
            if (!api.hasSession()) {
                addChatBubble("Sesión no iniciada — ve a Detalles y toca “Cambiar servidor o contraseña”.", isUser = false)
                return@setOnClickListener
            }
            addChatBubble(message, isUser = true)
            chatInput.setText("")
            audioStatus.text = ""
            orbView.setEnergy(0.25f) // gentle pulse while JARVIS "thinks"

            runInBackground(
                work = { api.sendMessage(message) },
                onSuccess = { chatReply ->
                    addChatBubble(chatReply.reply, isUser = false)
                    // The server already sends the real reason it fell back to the
                    // templated reply (e.g. Gemini quota/key errors) — previously
                    // discarded here, which made "Entendido, señor." undiagnosable
                    // from the app. Shown as a small note in the transcript (not
                    // audioStatus, which speak() immediately overwrites below).
                    chatReply.debugError?.let { addSystemNote("Aviso del servidor: $it") }
                    if (prefs.getBoolean("speak_replies_enabled", true)) {
                        speak(chatReply.reply)
                    } else {
                        orbView.setEnergy(0f)
                    }
                },
                onError = { err ->
                    addChatBubble("Error: ${err.message}", isUser = false)
                    orbView.setEnergy(0f)
                },
            )
        }

        updateListenerButtonUi()
        toggleListenerButton.setOnClickListener {
            if (JarvisListenerService.isRunning) {
                stopListenerService()
            } else {
                if (!api.hasSession()) {
                    listenerStatus.text = "Sesión no iniciada — ve a Detalles y toca “Cambiar servidor o contraseña”."
                    return@setOnClickListener
                }
                requestBatteryOptimizationExemption()
                requestOverlayPermission()
                ensurePermissionsThenStart()
            }
        }
    }

    private fun showLoginScreen() {
        splashScreen.visibility = View.GONE
        loginScreen.visibility = View.VISIBLE
        mainScreenRoot.visibility = View.GONE
    }

    private fun showMainScreen() {
        splashScreen.visibility = View.GONE
        loginScreen.visibility = View.GONE
        mainScreenRoot.visibility = View.VISIBLE
    }

    override fun onResume() {
        super.onResume()
        if (::toggleListenerButton.isInitialized) updateListenerButtonUi()
    }

    private fun setConnected(connected: Boolean) {
        connStatusPill.text = if (connected) "conexión: activa" else "conexión: ninguna"
        connStatusPill.setBackgroundResource(if (connected) R.drawable.status_pill_bg_ok else R.drawable.status_pill_bg)
    }

    private fun addChatBubble(text: String, isUser: Boolean) {
        conversationHint.visibility = View.GONE
        val row = LinearLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(6) }
            gravity = if (isUser) Gravity.END else Gravity.START
        }
        val bubble = TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#EDE9FE"))
            textSize = 14f
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setBackgroundResource(if (isUser) R.drawable.chat_bubble_user else R.drawable.chat_bubble_assistant)
            maxWidth = (resources.displayMetrics.widthPixels * 0.78f).toInt()
        }
        row.addView(bubble)
        conversationContainer.addView(row)
        conversationScroll.post { conversationScroll.fullScroll(View.FOCUS_DOWN) }
    }

    /** A small centered status line in the transcript — matches the web UI's
     * muted ".turn.tool" style. Used for server diagnostics (debugError)
     * that shouldn't be mistaken for something JARVIS actually said. */
    private fun addSystemNote(text: String) {
        conversationHint.visibility = View.GONE
        val note = TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#9A8BC4"))
            textSize = 11f
            gravity = Gravity.CENTER
        }
        val row = LinearLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(6) }
            gravity = Gravity.CENTER
        }
        row.addView(note)
        conversationContainer.addView(row)
        conversationScroll.post { conversationScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

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

    /**
     * Optional: with "Mostrar sobre otras apps" granted, JarvisListenerService
     * can open apps/WhatsApp/the dialer directly instead of via a tap-to-open
     * notification (see JarvisListenerService.addInvisibleOverlayIfPermitted).
     * Never required — the listener falls back to the notification if this is
     * never granted or the ROM doesn't support the settings intent.
     */
    private fun requestOverlayPermission() {
        if (!Settings.canDrawOverlays(this)) {
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            } catch (_: Exception) {
                // Not supported on this ROM — commands just keep using the notification.
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
        listenStatusPill.text = if (active) "escucha: activa" else "escucha: detenida"
        listenStatusPill.setBackgroundResource(if (active) R.drawable.status_pill_bg_ok else R.drawable.status_pill_bg)
    }

    private fun speak(text: String) {
        if (text.isBlank()) {
            orbView.setEnergy(0f)
            return
        }
        audioStatus.text = "Generando audio…"
        runInBackground(
            work = { api.synthesizeSpeech(text) },
            onSuccess = { audioBytes -> playAudio(audioBytes) },
            onError = { err ->
                audioStatus.text = "Audio: ${err.message}"
                orbView.setEnergy(0f)
            },
        )
    }

    private fun playAudio(bytes: ByteArray) {
        try {
            val file = File(cacheDir, "jarvis_reply.mp3")
            FileOutputStream(file).use { it.write(bytes) }
            releaseVisualizer()
            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnPreparedListener {
                    audioStatus.text = "Reproduciendo…"
                    val vol = prefs.getInt("jarvis_volume", DEFAULT_VOLUME_PERCENT) / 100f
                    it.setVolume(vol, vol)
                    attachVisualizer(it.audioSessionId)
                    it.start()
                }
                setOnCompletionListener {
                    audioStatus.text = "Audio reproducido."
                    releaseVisualizer()
                    orbView.setEnergy(0f)
                    it.release()
                }
                setOnErrorListener { _, what, extra ->
                    audioStatus.text = "Error al reproducir audio ($what/$extra)"
                    releaseVisualizer()
                    orbView.setEnergy(0f)
                    true
                }
                prepareAsync()
            }
        } catch (e: Exception) {
            audioStatus.text = "Error al reproducir audio: ${e.message}"
            orbView.setEnergy(0f)
        }
    }

    /**
     * Drives the orb's energy from the actual TTS waveform while it plays,
     * the same real-audio-reactive behavior as the web UI's AnalyserNode
     * (see app/public/orb.js). Requires RECORD_AUDIO (already granted for
     * the background listener); if it's missing or the device restricts
     * Visualizer, this just silently no-ops and the orb keeps its baseline
     * idle animation instead of crashing.
     */
    private fun attachVisualizer(audioSessionId: Int) {
        try {
            visualizer = Visualizer(audioSessionId).apply {
                captureSize = Visualizer.getCaptureSizeRange()[0]
                setDataCaptureListener(
                    object : Visualizer.OnDataCaptureListener {
                        override fun onWaveFormDataCapture(v: Visualizer?, waveform: ByteArray?, samplingRate: Int) {
                            orbView.setEnergy(waveformEnergy(waveform))
                        }
                        override fun onFftDataCapture(v: Visualizer?, fft: ByteArray?, samplingRate: Int) {}
                    },
                    Visualizer.getMaxCaptureRate() / 2,
                    true,
                    false,
                )
                enabled = true
            }
        } catch (_: Exception) {
            // No mic permission yet, or the ROM restricts Visualizer — not fatal.
        }
    }

    private fun waveformEnergy(waveform: ByteArray?): Float {
        if (waveform == null || waveform.isEmpty()) return 0f
        var sumSquares = 0.0
        for (b in waveform) {
            val v = (b.toInt() and 0xFF) - 128 // unsigned 8-bit PCM centered at 128
            sumSquares += (v * v).toDouble()
        }
        val rms = sqrt(sumSquares / waveform.size) / 128.0
        // Scaled up so ordinary speech volume still visibly moves the orb.
        return (rms * 2.4).toFloat().coerceIn(0f, 1f)
    }

    private fun releaseVisualizer() {
        visualizer?.let {
            try {
                it.enabled = false
                it.release()
            } catch (_: Exception) {
                // Already released or invalid — nothing to clean up.
            }
        }
        visualizer = null
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
        releaseVisualizer()
        mediaPlayer?.release()
        mediaPlayer = null
        super.onDestroy()
    }
}
