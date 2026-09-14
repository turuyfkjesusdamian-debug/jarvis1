package com.jarvis.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.io.FileOutputStream
import java.text.Normalizer
import java.util.Locale

/**
 * Foreground service: listens continuously for "oye jarvis" and sends
 * whatever follows straight to the same /api/chat + /api/tts pipeline the
 * web UI and MainActivity's test button use — see
 * JARVIS/ARCHITECTURE.md § Decisions ("milestone 2"). Runs independently
 * of MainActivity's lifecycle: it reads the server URL/session straight
 * from SharedPreferences rather than holding a reference to the activity.
 *
 * Known risk (flagged to the user up front, not yet worked around): MIUI
 * aggressively kills background services unless the user manually
 * disables battery optimization and enables "autostart" for this app. If
 * the wake word stops responding after a while with no error, that's the
 * most likely cause, not a bug in this listener.
 */
class JarvisListenerService : Service(), RecognitionListener {

    companion object {
        const val ACTION_STOP = "com.jarvis.app.action.STOP"
        const val CHANNEL_ID = "jarvis_listening"
        const val NOTIFICATION_ID = 1
        private const val WAKE_WORD = "oye jarvis"
        private const val FOLLOW_UP_WINDOW_MS = 8_000L
        private const val RESTART_DELAY_MS = 300L
        private const val TAG = "JarvisListener"

        /** Read by MainActivity to reflect the real service state in the UI. */
        @Volatile
        var isRunning: Boolean = false
            private set
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var api: JarvisApiClient
    private var recognizer: SpeechRecognizer? = null
    private var localTts: TextToSpeech? = null
    private var mediaPlayer: android.media.MediaPlayer? = null
    private var awaitingFollowUp = false
    private var running = false

    private val clearFollowUp = Runnable { awaitingFollowUp = false }

    override fun onCreate() {
        super.onCreate()
        val prefs = getSharedPreferences("jarvis", MODE_PRIVATE)
        api = JarvisApiClient(prefs.getString("server_url", "") ?: "")
        api.restoreSession(prefs.getString("session_cookie", null))
        localTts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                localTts?.language = Locale("es", "ES")
            }
        }
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Also stopped via the notification's own "Detener" action, not
            // just MainActivity's toggle — keep the persisted flag in sync
            // either way, so a later reboot doesn't restart a listener the
            // user explicitly turned off.
            getSharedPreferences("jarvis", MODE_PRIVATE).edit().putBoolean("listener_enabled", false).apply()
            stopListening()
            stopSelf()
            return START_NOT_STICKY
        }
        if (!running) {
            startForeground(NOTIFICATION_ID, buildNotification("Escuchando “oye jarvis”…"))
            startListening()
            isRunning = true
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopListening()
        localTts?.shutdown()
        mediaPlayer?.release()
        isRunning = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // --- Speech recognition loop ---

    private fun startListening() {
        running = true
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            Log.e(TAG, "No speech recognition available on this device.")
            stopSelf()
            return
        }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
                setRecognitionListener(this@JarvisListenerService)
            }
        }
        val recognizerIntent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-ES")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        }
        recognizer?.startListening(recognizerIntent)
    }

    private fun stopListening() {
        running = false
        recognizer?.destroy()
        recognizer = null
    }

    private fun restartListening() {
        if (!running) return
        mainHandler.postDelayed({ if (running) startListening() }, RESTART_DELAY_MS)
    }

    override fun onResults(results: android.os.Bundle?) {
        val transcript = results
            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.trim()
        handleTranscript(transcript)
        restartListening()
    }

    override fun onError(error: Int) {
        // ERROR_NO_MATCH / ERROR_SPEECH_TIMEOUT fire constantly during
        // normal silence — that's expected, just listen again.
        restartListening()
    }

    private fun handleTranscript(transcript: String?) {
        if (transcript.isNullOrBlank()) return
        Log.d(TAG, "Heard: $transcript")

        val normalized = stripAccents(transcript.lowercase(Locale("es")))
        val wakeIndex = normalized.indexOf(WAKE_WORD)

        val command: String = when {
            wakeIndex >= 0 -> transcript.substring(wakeIndex + WAKE_WORD.length).trim(' ', ',', '.', ':')
            awaitingFollowUp -> transcript
            else -> return // no wake word, not in a follow-up window — ignore, never send to the server
        }

        mainHandler.removeCallbacks(clearFollowUp)
        awaitingFollowUp = false

        if (command.isEmpty()) {
            // Wake word alone, e.g. "oye jarvis" with a pause — acknowledge
            // locally (no network round-trip needed for a filler phrase)
            // and listen for the actual command as the very next utterance.
            speakLocally("Sí, señor, dígame.")
            awaitingFollowUp = true
            mainHandler.postDelayed(clearFollowUp, FOLLOW_UP_WINDOW_MS)
            return
        }

        sendCommand(command)
    }

    // --- Talking to the JARVIS backend ---

    private fun sendCommand(command: String) {
        updateNotification("Pensando: “$command”")
        Thread {
            try {
                val reply = api.sendMessage(command)
                mainHandler.post { updateNotification("Escuchando “oye jarvis”…") }
                speakReply(reply.reply)
            } catch (e: Exception) {
                Log.e(TAG, "sendMessage failed", e)
                mainHandler.post { updateNotification("Escuchando “oye jarvis”…") }
                speakLocally("No pude conectar con el servidor, señor.")
            }
        }.start()
    }

    /** Speaks a JARVIS reply through ElevenLabs (same voice as the web UI and MainActivity). */
    private fun speakReply(text: String) {
        if (text.isBlank()) return
        Thread {
            try {
                val bytes = api.synthesizeSpeech(text)
                mainHandler.post { playAudio(bytes) }
            } catch (e: Exception) {
                Log.e(TAG, "synthesizeSpeech failed, falling back to on-device voice", e)
                speakLocally(text)
            }
        }.start()
    }

    private fun playAudio(bytes: ByteArray) {
        try {
            val file = File(cacheDir, "jarvis_wake_reply.mp3")
            FileOutputStream(file).use { it.write(bytes) }
            mediaPlayer?.release()
            mediaPlayer = android.media.MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnPreparedListener { start() }
                setOnCompletionListener { it.release() }
                prepareAsync()
            }
        } catch (e: Exception) {
            Log.e(TAG, "playAudio failed", e)
        }
    }

    /** On-device TTS (no network) for short filler phrases and network-failure fallbacks. */
    private fun speakLocally(text: String) {
        localTts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "jarvis-local")
    }

    private fun stripAccents(text: String): String {
        val normalized = Normalizer.normalize(text, Normalizer.Form.NFD)
        return normalized.replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
    }

    // --- Notification (required for a foreground service) ---

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "JARVIS escuchando", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val stopIntent = Intent(this, JarvisListenerService::class.java).setAction(ACTION_STOP)
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("JARVIS")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .addAction(0, "Detener", stopPendingIntent)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(text))
    }

    // --- Unused RecognitionListener callbacks ---
    override fun onReadyForSpeech(params: android.os.Bundle?) {}
    override fun onBeginningOfSpeech() {}
    override fun onRmsChanged(rmsdB: Float) {}
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onPartialResults(partialResults: android.os.Bundle?) {}
    override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
}
