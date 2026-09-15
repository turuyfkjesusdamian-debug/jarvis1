package com.jarvis.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.provider.ContactsContract
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.view.View
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream
import java.net.URLEncoder
import java.text.Normalizer
import java.util.Locale

/**
 * Foreground service: listens continuously for "oye jarvis" and sends
 * whatever follows straight to the same /api/chat + /api/tts pipeline the
 * web UI and MainActivity's test button use — see
 * JARVIS/ARCHITECTURE.md § Decisions ("milestone 2"). A handful of
 * commands are special-cased and handled entirely on-device instead,
 * never touching the server:
 * - "envíale un mensaje a X que diga Y" — prepares WhatsApp with the
 *   message pre-filled (WhatsApp itself doesn't allow a third-party app
 *   to send it) and "llama a X" — a real phone call. Both **require an
 *   explicit spoken "sí"** to a full readback first — see
 *   JARVIS/SECURITY.md § Actions requiring confirmation.
 * - "reproduce/busca X en YouTube" (opens YouTube's search results for
 *   X — the user still picks the actual video), "abre X" (opens any
 *   installed app matched by name), and "abre X y reproduce/busca Y"
 *   (opens X, and searches inside it too — but only for apps in
 *   [SEARCH_DEEP_LINKS] that actually publish a search deep link, like
 *   YouTube or Spotify; any other app just opens plainly, with JARVIS
 *   saying it can't search there rather than guessing a URI and possibly
 *   opening the wrong thing). None of these need confirmation: unlike
 *   WhatsApp/calls, opening an app or a search page affects no one but
 *   the user themselves.
 * - "toca X" / "aprieta X" — simulates a real touch on whatever is
 *   currently on screen, via the optional [JarvisAccessibilityService]
 *   (searches the active window's accessibility tree for a matching
 *   label and taps its center). Also no confirmation, same reasoning; the
 *   spoken readback of exactly what got tapped is the safety net for a
 *   fuzzy-match miss. Only available once the user manually enables the
 *   accessibility service — see [JarvisAccessibilityService]. When the text
 *   search finds nothing (an icon with no label, a custom-drawn view like a
 *   game board), [handleTapElement] escalates once to vision: a screenshot
 *   ([JarvisAccessibilityService.captureScreenshotJpegBase64]) plus one
 *   Gemini-vision call server-side (`POST /api/vision-command`,
 *   [JarvisApiClient.locateScreenElement]) to compute where to tap. This is
 *   the one place a screenshot ever leaves the phone — see
 *   JARVIS/SECURITY.md § Android app actions.
 * - "¿qué dice esto?" / "¿quién me escribió?" / any question about
 *   something currently visible on screen — [handleDescribeScreen], reached
 *   only via the device-command fallback's `describe_screen` classification
 *   (no fixed phrasing to match with a regex). Sends the same screenshot +
 *   the question to `POST /api/vision-command`
 *   ([JarvisApiClient.describeScreen]) and speaks back the answer.
 * - If none of the above regexes match, [tryDeviceCommandFallback] asks the
 *   server to classify the phrase (one Gemini call, `POST /api/device-command`
 *   via [JarvisApiClient.classifyDeviceCommand]) into the same set of
 *   no-confirmation actions — e.g. "reproduce boys don't cry" (no "en
 *   YouTube" said) still opens a YouTube search, "quiero usar instagram"
 *   still opens Instagram. Falls through to ordinary chat
 *   ([sendCommand]) when the classification comes back "none" or the
 *   request fails. **Never used for WhatsApp/calls** — the server-side
 *   prompt excludes them outright, and this path can only ever produce the
 *   same [CommandParseResult.LaunchNow]/[CommandParseResult.TapElement]
 *   shapes the regexes above do, never a [PendingConfirmation]. See
 *   JARVIS/ARCHITECTURE.md § Decisions.
 * All of the above launch via [launchApp], which opens the app directly
 * when we hold the optional SYSTEM_ALERT_WINDOW permission (see
 * [addInvisibleOverlayIfPermitted]), or falls back to a tap-to-open
 * notification ([launchViaNotification]) otherwise — Android silently
 * blocks a background Service from opening another app itself (API 29+),
 * with no exception to catch, so a direct `startActivity()` call here
 * looked like it worked but nothing actually appeared. One more phrase,
 * "jarvis apágate", stops the listener and kills the app's own process
 * outright — no confirmation needed, since it only affects the person
 * saying it.
 *
 * Runs independently of MainActivity's lifecycle: it reads the server
 * URL/session straight from SharedPreferences rather than holding a
 * reference to the activity.
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
        const val ACTION_CHANNEL_ID = "jarvis_actions"
        const val NOTIFICATION_ID = 1
        const val ACTION_NOTIFICATION_ID = 2
        private const val WAKE_WORD = "oye jarvis"
        private const val FOLLOW_UP_WINDOW_MS = 8_000L
        private const val CONFIRMATION_WINDOW_MS = 10_000L
        private const val RESTART_DELAY_MS = 300L
        private const val TAG = "JarvisListener"

        // Matches e.g. "envíale un mensaje a mamá que diga que ya voy" /
        // "mándale mensaje a Juan diciendo hola" / "escríbele un whatsapp a
        // Juan donde diga que ya llegué" against the accent/case-stripped
        // transcript — see JARVIS/SECURITY.md § Actions requiring
        // confirmation. Deliberately kept as hand-written pattern matching,
        // never sent through Gemini even as a fallback (unlike most other
        // commands — see tryDeviceCommandFallback): the contact name and
        // message must never leave the phone for this to work, so its
        // phrasing coverage can only ever come from widening this regex,
        // not from the model-based fallback.
        private val SEND_MESSAGE_REGEX = Regex(
            "(?:envia(?:le)?|manda(?:le)?|escribe(?:le)?)\\s+(?:un\\s+)?(?:mensaje|whatsapp)\\s+a\\s+(.+?)\\s+" +
                "(?:que diga|diciendo|con el mensaje|diciendole|donde diga)\\s+(.+)"
        )
        // Matches e.g. "llama a mamá" / "márcale a Juan" / "haz una llamada a mi
        // hermano" / "quiero llamar a mi hermano" / "telefonéale a Juan". Same
        // never-through-Gemini reasoning as SEND_MESSAGE_REGEX above.
        private val CALL_REGEX = Regex(
            "(?:llama(?:le)?|marca(?:le)?|haz(?:le)? una llamada|quiero llamar|telefonea(?:le)?)\\s+a\\s+(.+)"
        )
        // Compared against the accent-stripped transcript, so "señor" here is "senor".
        private val AFFIRMATIVE_ANSWERS = setOf("si", "si senor", "confirmo", "correcto", "dale", "adelante", "afirmativo")
        // "jarvis apágate" also matches inside "oye jarvis apágate" as a substring,
        // so both phrasings work without a separate wake-word check.
        private val SHUTDOWN_PHRASES = listOf("jarvis apagate", "jarvis apagar")
        // Matches e.g. "reproduce despacito en youtube" / "busca gatos en youtube".
        // Opens search results, not a specific video — see class doc comment.
        // Kept literal on purpose (not "escucha X en youtube" etc.) — unlike
        // SEND_MESSAGE_REGEX/CALL_REGEX above, a phrasing this doesn't catch
        // (including "reproduce X" with no "en youtube" at all) still gets
        // handled, one step slower, by tryDeviceCommandFallback.
        private val YOUTUBE_REGEX = Regex("(?:reproduce|busca|pon)\\s+(.+?)\\s+en\\s+youtube")
        // Just "abre X" — kept literal for the same reason as YOUTUBE_REGEX
        // above: "ábreme X", "abre la app de X", "inicia X" etc. still work,
        // just via tryDeviceCommandFallback instead of matching instantly here.
        private val OPEN_APP_REGEX = Regex("abre\\s+(.+)")
        // Just "abre X y reproduce Z" — tried before OPEN_APP_REGEX, which would
        // otherwise swallow the whole thing as one (nonexistent) app name.
        private val OPEN_AND_PLAY_REGEX = Regex("abre\\s+(.+?)\\s+y\\s+reproduce\\s+(.+)")
        // "Cómo llego de X a Y" / "cómo llego a Y" (current location assumed as
        // origin) / "busca X cerca" — see tryParseMapsCommand.
        private val DIRECTIONS_FROM_TO_REGEX = Regex("como llego de\\s+(.+?)\\s+a\\s+(.+)")
        private val DIRECTIONS_TO_REGEX = Regex("como llego a\\s+(.+)")
        private val NEARBY_REGEX = Regex("busca\\s+(.+?)\\s+cerca(?:\\s+de\\s+mi)?")
        // Matches e.g. "toca enviar" / "aprieta el boton de aceptar" / "presiona
        // continuar" — see tryParseTapCommand and JarvisAccessibilityService.
        private val TAP_REGEX = Regex(
            "(?:toca|aprieta|presiona|pulsa)\\s+(?:el boton de |la opcion de |donde dice |en )?(.+)"
        )
        // Apps with a real, publicly documented search-by-title deep link —
        // deliberately small. Guessing a scheme for an app that doesn't
        // publish one (Disney+, Netflix, ...) would silently open to the
        // wrong place, which is worse than plainly saying it can't search there.
        private val SEARCH_DEEP_LINKS: Map<String, (String) -> String> = mapOf(
            "youtube" to { q -> "https://www.youtube.com/results?search_query=${URLEncoder.encode(q, "UTF-8").replace("+", "%20")}" },
            "spotify" to { q -> "https://open.spotify.com/search/${URLEncoder.encode(q, "UTF-8").replace("+", "%20")}" },
        )

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
    /** Non-null only while an invisible overlay window is actually held — see [addInvisibleOverlayIfPermitted]. */
    private var overlayView: View? = null
    private var pendingConfirmation: PendingConfirmation? = null
    // While true, the recognizer stays off — otherwise the mic picks up
    // JARVIS's own voice through the speaker as if it were the user
    // answering, which made every yes/no confirmation resolve as neither
    // and fall through to "Cancelado" regardless of what was actually said.
    private var isSpeaking = false
    private var onSpeechDone: (() -> Unit)? = null

    private val clearFollowUp = Runnable { awaitingFollowUp = false }
    private val clearPendingConfirmation = Runnable {
        if (pendingConfirmation != null) {
            pendingConfirmation = null
            speakLocally("Se agotó el tiempo, cancelado.")
        }
    }

    /** An action with a real side effect, spoken back for yes/no confirmation
     * before it happens — see JARVIS/SECURITY.md § Actions requiring confirmation. */
    private sealed class PendingConfirmation {
        data class WhatsAppMessage(val contactName: String, val phone: String, val message: String) : PendingConfirmation()
        data class PhoneCall(val contactName: String, val phone: String) : PendingConfirmation()
    }

    private sealed class CommandParseResult {
        object NotAMatch : CommandParseResult()
        data class MissingPermission(val what: String) : CommandParseResult()
        data class ContactNotFound(val name: String) : CommandParseResult()
        data class MultipleContacts(val name: String, val count: Int) : CommandParseResult()
        data class AppNotFound(val name: String) : CommandParseResult()
        data class MultipleApps(val name: String, val count: Int) : CommandParseResult()
        data class Ready(val pending: PendingConfirmation) : CommandParseResult()
        /**
         * No confirmation needed — opening an app or a YouTube search has no
         * effect on anyone but the user, unlike WhatsApp/calls.
         * [notifiedSpokenText] is used when [launchApp] had to fall back to a
         * tap-to-open notification; [directSpokenText] when it opened the app
         * immediately (SYSTEM_ALERT_WINDOW granted).
         */
        data class LaunchNow(
            val intent: Intent,
            val tapText: String,
            val notifiedSpokenText: String,
            val directSpokenText: String,
        ) : CommandParseResult()
        /** "Toca X" / "aprieta X" — see tryParseTapCommand. No confirmation:
         * same test as opening an app (JARVIS/SECURITY.md § Android app
         * actions) — this only ever acts on the user's own phone. */
        data class TapElement(val query: String) : CommandParseResult()
        /** Only ever produced by the device-command fallback (no regex for
         * this — a question doesn't have a fixed phrasing to match) — see
         * handleDescribeScreen and JARVIS/ARCHITECTURE.md § Decisions. */
        object DescribeScreen : CommandParseResult()
    }

    /** Result of [launchApp] — decides which spoken message fits what actually happened. */
    private enum class LaunchOutcome { OPENED, NOTIFIED, FAILED }

    override fun onCreate() {
        super.onCreate()
        val prefs = getSharedPreferences("jarvis", MODE_PRIVATE)
        api = JarvisApiClient(prefs.getString("server_url", "") ?: "")
        api.restoreSession(prefs.getString("session_cookie", null))
        localTts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                localTts?.language = Locale("es", "ES")
                localTts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        mainHandler.post { onLocalSpeechFinished() }
                    }
                    @Deprecated("Deprecated in Java, still the only overload some OEM TTS engines call")
                    override fun onError(utteranceId: String?) {
                        mainHandler.post { onLocalSpeechFinished() }
                    }
                })
            }
        }
        createNotificationChannel()
        addInvisibleOverlayIfPermitted()
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
        removeInvisibleOverlay()
        isRunning = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // --- "Jarvis, apágate" ---

    /** Stops the listener, clears the reboot-restart flag, and kills the app's
     * own process outright — a literal "cierra por completo la app", not just
     * "stop listening". No confirmation needed: unlike WhatsApp/calls this has
     * no effect on anyone but the user themselves saying it. */
    private fun shutdownCompletely() {
        getSharedPreferences("jarvis", MODE_PRIVATE).edit().putBoolean("listener_enabled", false).apply()
        stopListening()
        speakLocally("Hasta luego, señor.") {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            Process.killProcess(Process.myPid())
        }
    }

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
        if (!running || isSpeaking) return
        mainHandler.postDelayed({ if (running && !isSpeaking) startListening() }, RESTART_DELAY_MS)
    }

    /** Called once JARVIS's own speech (local TTS) finishes — resumes listening and
     * runs whatever was queued to happen after (see [speakLocally]'s `then` param). */
    private fun onLocalSpeechFinished() {
        isSpeaking = false
        if (running) restartListening()
        val callback = onSpeechDone
        onSpeechDone = null
        callback?.invoke()
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

        // "Jarvis, apágate" always wins, even over a pending confirmation —
        // an explicit shutdown request shouldn't get stuck behind an
        // unrelated yes/no prompt.
        val normalizedForShutdown = stripAccents(transcript.lowercase(Locale("es")))
        if (SHUTDOWN_PHRASES.any { normalizedForShutdown.contains(it) }) {
            mainHandler.removeCallbacks(clearFollowUp)
            mainHandler.removeCallbacks(clearPendingConfirmation)
            awaitingFollowUp = false
            pendingConfirmation = null
            shutdownCompletely()
            return
        }

        // A pending confirmation (WhatsApp message or phone call) takes
        // priority over everything else — the very next utterance must be
        // treated as yes/no, regardless of the wake word. See
        // JARVIS/SECURITY.md § Actions requiring confirmation: never infer
        // confirmation from anything but an explicit, current-turn answer.
        pendingConfirmation?.let { pending ->
            mainHandler.removeCallbacks(clearFollowUp)
            awaitingFollowUp = false
            handleConfirmation(transcript, pending)
            return
        }

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

        val parsed = tryParseWhatsAppCommand(command)
            .takeIf { it !is CommandParseResult.NotAMatch }
            ?: tryParseCallCommand(command).takeIf { it !is CommandParseResult.NotAMatch }
            ?: tryParseOpenAndPlayCommand(command).takeIf { it !is CommandParseResult.NotAMatch }
            ?: tryParseYouTubeCommand(command).takeIf { it !is CommandParseResult.NotAMatch }
            ?: tryParseMapsCommand(command).takeIf { it !is CommandParseResult.NotAMatch }
            ?: tryParseTapCommand(command).takeIf { it !is CommandParseResult.NotAMatch }
            ?: tryParseOpenAppCommand(command)

        handleParseResult(parsed, command)
    }

    /**
     * Acts on a [CommandParseResult], however it was produced — a hand-written
     * regex match, or (only for [CommandParseResult.NotAMatch]) the server's
     * best-effort classification of a phrasing none of the regexes anticipated
     * (see [tryDeviceCommandFallback], JARVIS/ARCHITECTURE.md § Decisions).
     */
    private fun handleParseResult(parsed: CommandParseResult, command: String) {
        when (parsed) {
            is CommandParseResult.Ready -> {
                pendingConfirmation = parsed.pending
                mainHandler.postDelayed(clearPendingConfirmation, CONFIRMATION_WINDOW_MS)
                val prompt = when (val p = parsed.pending) {
                    is PendingConfirmation.WhatsAppMessage ->
                        "¿Envío por WhatsApp a ${p.contactName}, el mensaje: ${p.message}? Diga sí o no."
                    is PendingConfirmation.PhoneCall ->
                        "¿Llamo a ${p.contactName}? Diga sí o no."
                }
                speakLocally(prompt)
            }
            is CommandParseResult.LaunchNow -> {
                when (launchApp(parsed.intent, parsed.tapText)) {
                    LaunchOutcome.OPENED -> speakLocally(parsed.directSpokenText)
                    LaunchOutcome.NOTIFIED -> speakLocally(parsed.notifiedSpokenText)
                    LaunchOutcome.FAILED -> Unit // launchViaNotification already spoke the diagnostic
                }
            }
            is CommandParseResult.ContactNotFound ->
                speakLocally("No encontré ningún contacto llamado ${parsed.name}, señor.")
            is CommandParseResult.MultipleContacts ->
                speakLocally("Encontré ${parsed.count} contactos llamados ${parsed.name}, señor. Sea más específico.")
            is CommandParseResult.AppNotFound ->
                speakLocally("No encontré ninguna aplicación llamada ${parsed.name}, señor.")
            is CommandParseResult.MultipleApps ->
                speakLocally("Encontré ${parsed.count} aplicaciones parecidas a ${parsed.name}, señor. Sea más específico.")
            is CommandParseResult.MissingPermission ->
                speakLocally("No tengo permiso de ${parsed.what}, señor. Actívelo en la app de JARVIS.")
            is CommandParseResult.TapElement -> handleTapElement(parsed.query)
            CommandParseResult.DescribeScreen -> handleDescribeScreen(command)
            CommandParseResult.NotAMatch ->
                tryDeviceCommandFallback(command)
        }
    }

    // --- "Toca X" execution: text match first, vision as a fallback ---
    // The accessibility-tree text search (tapElementByText) is instant and
    // free, so it's always tried first; only when it finds nothing — an
    // icon with no label, a custom-drawn view like a game board — does this
    // escalate to a screenshot + the server's Gemini-vision location call.
    // See JARVIS/ARCHITECTURE.md § Decisions and JARVIS/SECURITY.md §
    // Android app actions for why a screenshot leaving the device at all is
    // treated as a bigger privacy step than everything else here.

    private fun handleTapElement(query: String) {
        val accessibility = JarvisAccessibilityService.instance
        if (accessibility == null) {
            speakLocally("No tengo el permiso de accesibilidad, señor. Actívelo en Detalles.")
            return
        }
        val tappedLabel = accessibility.tapElementByText(query)
        if (tappedLabel != null) {
            speakLocally("Toco “$tappedLabel”, señor.")
            return
        }
        if (!accessibility.canCaptureScreen()) {
            speakLocally("No encontré nada en pantalla parecido a “$query”, señor.")
            return
        }
        Thread {
            val screenshot = accessibility.captureScreenshotJpegBase64()
            val point = screenshot?.let { api.locateScreenElement(query, it) }
            mainHandler.post {
                if (point != null) {
                    accessibility.tapAtNormalizedPoint(point.x, point.y)
                    speakLocally("Toco ahí, señor.")
                } else {
                    speakLocally("No encontré nada en pantalla parecido a “$query”, señor.")
                }
            }
        }.start()
    }

    // --- "¿Qué dice esto?" / "¿quién me escribió?" etc. (screen vision) ---
    // Only ever reached via the device-command fallback's describe_screen
    // classification — there's no fixed phrasing to match with a regex, by
    // design (see JARVIS/ARCHITECTURE.md § Decisions).

    private fun handleDescribeScreen(question: String) {
        val accessibility = JarvisAccessibilityService.instance
        if (accessibility == null) {
            speakLocally("No tengo el permiso de accesibilidad, señor. Actívelo en Detalles.")
            return
        }
        if (!accessibility.canCaptureScreen()) {
            speakLocally("Mi versión de Android es demasiado antigua para ver la pantalla, señor.")
            return
        }
        Thread {
            val screenshot = accessibility.captureScreenshotJpegBase64()
            val answer = screenshot?.let { api.describeScreen(question, it) }
            mainHandler.post {
                speakLocally(answer ?: "No pude ver la pantalla en este momento, señor.")
            }
        }.start()
    }

    // --- Fallback for phrasings none of the regexes above anticipated ---
    // Asks the server to classify the command (one Gemini call) into one of
    // the same no-confirmation action types above, or "none" if it's not
    // actually a command — see JarvisApiClient.classifyDeviceCommand and
    // JARVIS/ARCHITECTURE.md § Decisions. Never used for WhatsApp/calls: the
    // server-side prompt explicitly excludes them, and even if it didn't,
    // there's no code path here that could turn this result into one — only
    // into the exact same LaunchNow/TapElement shapes the deterministic
    // regexes already produce.

    private fun tryDeviceCommandFallback(command: String) {
        Thread {
            val classified = try {
                api.classifyDeviceCommand(command)
            } catch (e: Exception) {
                Log.e(TAG, "classifyDeviceCommand failed", e)
                JarvisApiClient.DeviceCommand.None
            }
            val parsed = deviceCommandToParseResult(classified)
            mainHandler.post {
                if (parsed == null) {
                    sendCommand(command) // Not a recognized command either — ordinary chat.
                } else {
                    handleParseResult(parsed, command)
                }
            }
        }.start()
    }

    private fun deviceCommandToParseResult(cmd: JarvisApiClient.DeviceCommand): CommandParseResult? {
        return when (cmd) {
            is JarvisApiClient.DeviceCommand.None -> null
            is JarvisApiClient.DeviceCommand.OpenApp -> buildOpenAppResult(cmd.name)
            is JarvisApiClient.DeviceCommand.PlayMedia -> buildYouTubeSearchLaunch(cmd.query)
            is JarvisApiClient.DeviceCommand.Directions -> launchDirections(cmd.origin, cmd.destination)
            is JarvisApiClient.DeviceCommand.Nearby -> buildNearbyLaunch(cmd.query)
            is JarvisApiClient.DeviceCommand.TapElement -> CommandParseResult.TapElement(cmd.query)
            is JarvisApiClient.DeviceCommand.DescribeScreen -> CommandParseResult.DescribeScreen
        }
    }

    // --- "Envíale un mensaje a X que diga Y" (WhatsApp) / "Llama a X" ---
    // Both fully on-device: the contact name and message never reach the
    // JARVIS server or Gemini, only the app (WhatsApp or the dialer) the
    // confirmation opens.

    private fun tryParseWhatsAppCommand(command: String): CommandParseResult {
        val normalized = stripAccents(command.lowercase(Locale("es")))
        val match = SEND_MESSAGE_REGEX.find(normalized) ?: return CommandParseResult.NotAMatch
        val nameRange = match.groups[1]?.range ?: return CommandParseResult.NotAMatch
        val messageRange = match.groups[2]?.range ?: return CommandParseResult.NotAMatch

        val contactName = command.substring(nameRange.first, minOf(nameRange.last + 1, command.length)).trim()
        val message = command.substring(messageRange.first, minOf(messageRange.last + 1, command.length))
            .trim().trimEnd('.', '!', '?')
        if (contactName.isEmpty() || message.isEmpty()) return CommandParseResult.NotAMatch

        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_CONTACTS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return CommandParseResult.MissingPermission("contactos")
        }

        val matches = lookupContactPhones(contactName)
        return when {
            matches.isEmpty() -> CommandParseResult.ContactNotFound(contactName)
            matches.size > 1 -> CommandParseResult.MultipleContacts(contactName, matches.size)
            else -> CommandParseResult.Ready(
                PendingConfirmation.WhatsAppMessage(matches[0].first, digitsOnly(matches[0].second), message)
            )
        }
    }

    private fun tryParseCallCommand(command: String): CommandParseResult {
        val normalized = stripAccents(command.lowercase(Locale("es")))
        val match = CALL_REGEX.find(normalized) ?: return CommandParseResult.NotAMatch
        val nameRange = match.groups[1]?.range ?: return CommandParseResult.NotAMatch
        val contactName = command.substring(nameRange.first, minOf(nameRange.last + 1, command.length))
            .trim().trimEnd('.', '!', '?')
        if (contactName.isEmpty()) return CommandParseResult.NotAMatch

        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_CONTACTS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return CommandParseResult.MissingPermission("contactos")
        }
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CALL_PHONE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return CommandParseResult.MissingPermission("llamadas")
        }

        val matches = lookupContactPhones(contactName)
        return when {
            matches.isEmpty() -> CommandParseResult.ContactNotFound(contactName)
            matches.size > 1 -> CommandParseResult.MultipleContacts(contactName, matches.size)
            else -> CommandParseResult.Ready(
                PendingConfirmation.PhoneCall(matches[0].first, digitsOnly(matches[0].second))
            )
        }
    }

    // --- "Reproduce/busca X en YouTube" / "Abre X" ---
    // No confirmation needed for either — opening an app or a search page
    // has no effect on anyone but the user, unlike WhatsApp/calls. Both
    // still launch via a notification tap (see launchViaNotification):
    // opening YouTube's actual search-results page shows the real title,
    // channel, and thumbnail for each result, which the user picks from —
    // this is more reliable and transparent than guessing a video ID via
    // an unofficial API and playing it blind.

    private fun tryParseYouTubeCommand(command: String): CommandParseResult {
        val normalized = stripAccents(command.lowercase(Locale("es")))
        val match = YOUTUBE_REGEX.find(normalized) ?: return CommandParseResult.NotAMatch
        val queryRange = match.groups[1]?.range ?: return CommandParseResult.NotAMatch
        val query = command.substring(queryRange.first, minOf(queryRange.last + 1, command.length)).trim()
        if (query.isEmpty()) return CommandParseResult.NotAMatch
        return buildYouTubeSearchLaunch(query)
    }

    /** Shared by the exact "X en YouTube" phrasing above and the device-command
     * fallback's play_media action (e.g. "reproduce boys don't cry", with no
     * "en YouTube" said at all) — see tryDeviceCommandFallback. */
    private fun buildYouTubeSearchLaunch(query: String): CommandParseResult.LaunchNow {
        val encodedQuery = URLEncoder.encode(query, "UTF-8").replace("+", "%20")
        val uri = Uri.parse("https://www.youtube.com/results?search_query=$encodedQuery")
        val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return CommandParseResult.LaunchNow(
            intent,
            "Toque para ver \"$query\" en YouTube",
            "Listo, señor. Toque la notificación para ver los resultados de $query en YouTube.",
            "Listo, señor. Ahí tiene los resultados de $query en YouTube.",
        )
    }

    // --- "Cómo llego a X" / "cómo llego de X a Y" / "busca X cerca" (Google Maps) ---
    // Opens Google Maps with the route or nearby search already filled in, via
    // Maps' own public "Maps URLs" scheme (no API key, no server round-trip,
    // same reasoning as the YouTube/Spotify deep links — a documented URL
    // format is reliable, guessing one isn't). No confirmation needed, same
    // as opening any app or search page. JARVIS does not read the travel time
    // or the nearest result back out loud — that needs Google's real
    // Directions/Places API (a key plus a billing account on Google's side),
    // a bigger step the user deliberately deferred — see
    // JARVIS/ARCHITECTURE.md § Decisions.

    private fun tryParseMapsCommand(command: String): CommandParseResult {
        val normalized = stripAccents(command.lowercase(Locale("es")))

        DIRECTIONS_FROM_TO_REGEX.find(normalized)?.let { match ->
            val originRange = match.groups[1]?.range
            val destRange = match.groups[2]?.range
            if (originRange != null && destRange != null) {
                val origin = command.substring(originRange.first, minOf(originRange.last + 1, command.length)).trim()
                val destination = command.substring(destRange.first, minOf(destRange.last + 1, command.length))
                    .trim().trimEnd('.', '!', '?')
                if (origin.isNotEmpty() && destination.isNotEmpty()) return launchDirections(origin, destination)
            }
        }

        DIRECTIONS_TO_REGEX.find(normalized)?.let { match ->
            val destRange = match.groups[1]?.range
            if (destRange != null) {
                val destination = command.substring(destRange.first, minOf(destRange.last + 1, command.length))
                    .trim().trimEnd('.', '!', '?')
                if (destination.isNotEmpty()) return launchDirections(null, destination)
            }
        }

        NEARBY_REGEX.find(normalized)?.let { match ->
            val queryRange = match.groups[1]?.range
            if (queryRange != null) {
                val query = command.substring(queryRange.first, minOf(queryRange.last + 1, command.length)).trim()
                if (query.isNotEmpty()) return buildNearbyLaunch(query)
            }
        }

        return CommandParseResult.NotAMatch
    }

    /** Shared by "busca X cerca" above and the device-command fallback's nearby
     * action — see tryDeviceCommandFallback. */
    private fun buildNearbyLaunch(query: String): CommandParseResult.LaunchNow {
        val encoded = URLEncoder.encode("$query cerca de mi", "UTF-8").replace("+", "%20")
        val uri = Uri.parse("https://www.google.com/maps/search/?api=1&query=$encoded")
        val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return CommandParseResult.LaunchNow(
            intent,
            "Toque para ver \"$query\" cerca de usted",
            "Listo, señor. Toque la notificación para ver $query cerca de usted en Maps.",
            "Listo, señor. Ahí tiene $query cerca de usted en Maps.",
        )
    }

    /** [origin] null means "use my current location", which Maps does automatically when omitted. */
    private fun launchDirections(origin: String?, destination: String): CommandParseResult {
        val encodedDest = URLEncoder.encode(destination, "UTF-8").replace("+", "%20")
        val originParam = origin?.let { "&origin=${URLEncoder.encode(it, "UTF-8").replace("+", "%20")}" } ?: ""
        val uri = Uri.parse("https://www.google.com/maps/dir/?api=1&destination=$encodedDest$originParam")
        val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val spokenRoute = origin?.let { "desde $it hasta $destination" } ?: "hasta $destination"
        return CommandParseResult.LaunchNow(
            intent,
            "Toque para ver la ruta $spokenRoute",
            "Listo, señor. Toque la notificación para ver la ruta $spokenRoute.",
            "Listo, señor. Ahí tiene la ruta $spokenRoute.",
        )
    }

    /** "Abre X y reproduce/busca Y" — opens X, and searches inside it too, but
     * only for the handful of apps in [SEARCH_DEEP_LINKS] that actually publish
     * a search-by-title deep link. For any other app (Disney+, Netflix, ...),
     * opens it plainly and says so, rather than silently doing nothing or
     * guessing a URI scheme that might open the wrong thing. */
    private fun tryParseOpenAndPlayCommand(command: String): CommandParseResult {
        val normalized = stripAccents(command.lowercase(Locale("es")))
        val match = OPEN_AND_PLAY_REGEX.find(normalized) ?: return CommandParseResult.NotAMatch
        val appRange = match.groups[1]?.range ?: return CommandParseResult.NotAMatch
        val queryRange = match.groups[2]?.range ?: return CommandParseResult.NotAMatch
        val appName = command.substring(appRange.first, minOf(appRange.last + 1, command.length)).trim()
        val query = command.substring(queryRange.first, minOf(queryRange.last + 1, command.length))
            .trim().trimEnd('.', '!', '?')
        if (appName.isEmpty() || query.isEmpty()) return CommandParseResult.NotAMatch

        val normalizedAppName = stripAccents(appName.lowercase(Locale("es")))
        val deepLinkKey = SEARCH_DEEP_LINKS.keys.firstOrNull { normalizedAppName.contains(it) }
        if (deepLinkKey != null) {
            val uri = Uri.parse(SEARCH_DEEP_LINKS.getValue(deepLinkKey)(query))
            val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return CommandParseResult.LaunchNow(
                intent,
                "Toque para buscar \"$query\" en $appName",
                "Listo, señor. Toque la notificación para buscar $query en $appName.",
                "Listo, señor. Ahí tiene la búsqueda de $query en $appName.",
            )
        }

        val matches = findLaunchableApps(appName)
        return when {
            matches.isEmpty() -> CommandParseResult.AppNotFound(appName)
            matches.size > 1 -> CommandParseResult.MultipleApps(appName, matches.size)
            else -> {
                val (label, intent) = matches[0]
                CommandParseResult.LaunchNow(
                    intent,
                    "Toque para abrir $label",
                    "Toque la notificación para abrir $label, señor — no puedo buscar $query ahí automáticamente, tendrá que hacerlo desde la app.",
                    "Ahí tiene $label abierto, señor — no puedo buscar $query ahí automáticamente, tendrá que hacerlo desde la app.",
                )
            }
        }
    }

    private fun tryParseOpenAppCommand(command: String): CommandParseResult {
        val normalized = stripAccents(command.lowercase(Locale("es")))
        val match = OPEN_APP_REGEX.find(normalized) ?: return CommandParseResult.NotAMatch
        val nameRange = match.groups[1]?.range ?: return CommandParseResult.NotAMatch
        val appName = command.substring(nameRange.first, minOf(nameRange.last + 1, command.length))
            .trim().trimEnd('.', '!', '?')
        if (appName.isEmpty()) return CommandParseResult.NotAMatch
        return buildOpenAppResult(appName)
    }

    /** Shared by "abre X" above and the device-command fallback's open_app
     * action — see tryDeviceCommandFallback. */
    private fun buildOpenAppResult(appName: String): CommandParseResult {
        val matches = findLaunchableApps(appName)
        return when {
            matches.isEmpty() -> CommandParseResult.AppNotFound(appName)
            matches.size > 1 -> CommandParseResult.MultipleApps(appName, matches.size)
            else -> {
                val (label, intent) = matches[0]
                CommandParseResult.LaunchNow(
                    intent,
                    "Toque para abrir $label",
                    "Listo, señor. Toque la notificación para abrir $label.",
                    "Listo, señor. Ahí tiene $label abierto.",
                )
            }
        }
    }

    // --- "Toca X" / "aprieta X" (simulated touch, JarvisAccessibilityService) ---
    // No confirmation — same test as opening an app (JARVIS/SECURITY.md § Android
    // app actions): this only ever acts on the user's own phone. Unlike opening
    // an app (matched against a curated, installed-apps list), the match here is
    // a fuzzy text search over whatever happens to be on screen, so JARVIS always
    // says exactly what it tapped right after tapping it — that spoken readback,
    // not a yes/no round-trip, is the safety net for a wrong match.

    private fun tryParseTapCommand(command: String): CommandParseResult {
        val normalized = stripAccents(command.lowercase(Locale("es")))
        val match = TAP_REGEX.find(normalized) ?: return CommandParseResult.NotAMatch
        val queryRange = match.groups[1]?.range ?: return CommandParseResult.NotAMatch
        val query = command.substring(queryRange.first, minOf(queryRange.last + 1, command.length))
            .trim().trimEnd('.', '!', '?')
        if (query.isEmpty()) return CommandParseResult.NotAMatch
        return CommandParseResult.TapElement(query)
    }

    /** Returns (label, launchIntent) pairs for installed launchable apps whose
     * name contains [name], accent/case-insensitive — requires the <queries>
     * declaration in AndroidManifest.xml (Android 11+ package visibility). */
    private fun findLaunchableApps(name: String): List<Pair<String, Intent>> {
        val target = stripAccents(name.lowercase(Locale("es")))
        val pm = packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return pm.queryIntentActivities(mainIntent, 0)
            .mapNotNull { resolveInfo ->
                val label = resolveInfo.loadLabel(pm).toString()
                if (!stripAccents(label.lowercase(Locale("es"))).contains(target)) return@mapNotNull null
                val launchIntent = pm.getLaunchIntentForPackage(resolveInfo.activityInfo.packageName)
                    ?: return@mapNotNull null
                label to launchIntent
            }
            .distinctBy { it.second.`package` }
    }

    /** Returns (displayName, number) pairs matching [name] (see [namesMatch]). */
    private fun lookupContactPhones(name: String): List<Pair<String, String>> {
        val target = stripAccents(name.lowercase(Locale("es")))
        val results = mutableListOf<Pair<String, String>>()
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
        )
        contentResolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, projection, null, null, null)
            ?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numberIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                while (cursor.moveToNext()) {
                    val displayName = cursor.getString(nameIdx) ?: continue
                    val number = cursor.getString(numberIdx) ?: continue
                    if (namesMatch(target, displayName)) {
                        results.add(displayName to number)
                    }
                }
            }
        return results.distinctBy { it.second }
    }

    /**
     * Nickname-tolerant match: [target] is already accent/case-normalized;
     * [displayName] is the raw contact name. A spoken name and a saved
     * contact name rarely match character-for-character in Spanish — e.g.
     * the user says "Juan" but the contact is saved as "Juanito" (or the
     * reverse: saved as "Juan" but the user calls him "Juanito"). Checking
     * containment in both directions, against the full name and each of
     * its words, covers the common case of a nickname formed by adding a
     * suffix (a diminutive like "-ito") on either side, without needing a
     * hardcoded list of Spanish nicknames (which are too irregular — "Pepe"
     * for "José", "Chuy" for "Jesús" — to cover generally).
     *
     * A minimum length guard avoids "Ana" matching every contact whose name
     * merely contains "an".
     */
    private fun namesMatch(target: String, displayName: String): Boolean {
        val normalizedDisplay = stripAccents(displayName.lowercase(Locale("es")))
        if (fuzzyContains(normalizedDisplay, target)) return true
        return normalizedDisplay.split(Regex("\\s+")).any { word -> fuzzyContains(word, target) }
    }

    private fun fuzzyContains(a: String, b: String): Boolean {
        if (a.isEmpty() || b.isEmpty()) return false
        val minMatchLength = 3
        if (a.length < minMatchLength || b.length < minMatchLength) return a == b
        return a.contains(b) || b.contains(a)
    }

    private fun digitsOnly(rawNumber: String): String = rawNumber.filter { it.isDigit() }

    private fun handleConfirmation(transcript: String, pending: PendingConfirmation) {
        mainHandler.removeCallbacks(clearPendingConfirmation)
        pendingConfirmation = null
        val normalized = stripAccents(transcript.lowercase(Locale("es"))).trim().trimEnd('.', '!', '?', ',')
        val isAffirmative = AFFIRMATIVE_ANSWERS.any { normalized == it || normalized.startsWith("$it ") || normalized.startsWith("$it,") }
        if (!isAffirmative) {
            // Anything that isn't a clear "yes" is treated as "no" — never
            // guess yes on an ambiguous answer for an action with a real
            // side effect.
            speakLocally("Cancelado, señor.")
            return
        }
        when (pending) {
            is PendingConfirmation.WhatsAppMessage -> openWhatsApp(pending)
            is PendingConfirmation.PhoneCall -> placeCall(pending)
        }
    }

    private fun openWhatsApp(pending: PendingConfirmation.WhatsAppMessage) {
        try {
            val encodedMessage = URLEncoder.encode(pending.message, "UTF-8").replace("+", "%20")
            val uri = Uri.parse("https://wa.me/${pending.phone}?text=$encodedMessage")
            val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            when (launchApp(intent, "Toque para abrir WhatsApp con el mensaje para ${pending.contactName}")) {
                LaunchOutcome.OPENED ->
                    speakLocally("Listo, señor. Ahí tiene WhatsApp con el mensaje para ${pending.contactName}.")
                LaunchOutcome.NOTIFIED ->
                    speakLocally("Listo, señor. Toque la notificación para abrir WhatsApp con el mensaje para ${pending.contactName}.")
                LaunchOutcome.FAILED -> Unit
            }
        } catch (e: Exception) {
            Log.e(TAG, "openWhatsApp failed", e)
            speakLocally("No pude preparar WhatsApp, señor.")
        }
    }

    private fun placeCall(pending: PendingConfirmation.PhoneCall) {
        try {
            val uri = Uri.parse("tel:${pending.phone}")
            val intent = Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            when (launchApp(intent, "Toque para llamar a ${pending.contactName}")) {
                LaunchOutcome.OPENED -> speakLocally("Listo, señor, llamando a ${pending.contactName}.")
                LaunchOutcome.NOTIFIED ->
                    speakLocally("Listo, señor. Toque la notificación para llamar a ${pending.contactName}.")
                LaunchOutcome.FAILED -> Unit
            }
        } catch (e: Exception) {
            Log.e(TAG, "placeCall failed", e)
            speakLocally("No pude realizar la llamada, señor.")
        }
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

    /** Shared with MainActivity's own default for the same "jarvis_volume" pref key (0..100, set from "Detalles"). */
    private fun voiceVolume(): Float = getSharedPreferences("jarvis", MODE_PRIVATE).getInt("jarvis_volume", 80) / 100f

    private fun playAudio(bytes: ByteArray) {
        // Same self-hearing problem as local TTS (see isSpeaking) — the mic
        // must stay off while JARVIS's own reply plays through the speaker.
        isSpeaking = true
        try {
            val file = File(cacheDir, "jarvis_wake_reply.mp3")
            FileOutputStream(file).use { it.write(bytes) }
            mediaPlayer?.release()
            mediaPlayer = android.media.MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnPreparedListener {
                    val vol = voiceVolume()
                    it.setVolume(vol, vol)
                    it.start()
                }
                setOnCompletionListener {
                    it.release()
                    isSpeaking = false
                    restartListening()
                }
                setOnErrorListener { _, _, _ ->
                    isSpeaking = false
                    restartListening()
                    true
                }
                prepareAsync()
            }
        } catch (e: Exception) {
            Log.e(TAG, "playAudio failed", e)
            isSpeaking = false
            restartListening()
        }
    }

    /** On-device TTS (no network) for short filler phrases, confirmations, and
     * network-failure fallbacks. Mutes the recognizer until speech finishes (see
     * [isSpeaking]) — optionally running [then] once it does. */
    private fun speakLocally(text: String, then: (() -> Unit)? = null) {
        isSpeaking = true
        onSpeechDone = then
        val params = android.os.Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, voiceVolume()) }
        localTts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, "jarvis-local")
    }

    private fun stripAccents(text: String): String {
        val normalized = Normalizer.normalize(text, Normalizer.Form.NFD)
        return normalized.replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
    }

    // --- Notification (required for a foreground service) ---

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "JARVIS escuchando", NotificationManager.IMPORTANCE_LOW)
            )
            // High importance so it actually pops up — Android won't let a
            // background Service open WhatsApp or the dialer directly
            // (silently blocked, no exception, since API 29), but tapping a
            // notification always counts as a direct user action and is
            // exempt from that restriction. See JARVIS/ARCHITECTURE.md § Decisions.
            nm.createNotificationChannel(
                NotificationChannel(ACTION_CHANNEL_ID, "JARVIS: acción requerida", NotificationManager.IMPORTANCE_HIGH)
            )
        }
    }

    // --- Opening apps directly, without a notification (optional) ---
    // Android exempts a background Service from its activity-launch
    // restriction (API 29+) if the app holds SYSTEM_ALERT_WINDOW *and* is
    // actually maintaining a window of type TYPE_APPLICATION_OVERLAY —
    // just holding the permission isn't enough. So this keeps one
    // permanently-invisible 1x1 window up for the service's whole
    // lifetime, purely to satisfy that check — JARVIS never draws
    // anything a user could see or tap through it (see
    // JARVIS/SECURITY.md § Android app actions). Entirely optional: if
    // the user never grants "Mostrar sobre otras apps" (or a ROM blocks
    // it), [addInvisibleOverlayIfPermitted] just no-ops and every launch
    // falls back to [launchViaNotification], exactly as before.

    private fun hasOverlayPermission(): Boolean = Settings.canDrawOverlays(this)

    private fun addInvisibleOverlayIfPermitted() {
        if (!hasOverlayPermission() || overlayView != null) return
        try {
            val windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
            val params = WindowManager.LayoutParams(
                1, 1,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT,
            )
            val view = View(this)
            windowManager.addView(view, params)
            overlayView = view
        } catch (e: Exception) {
            Log.w(TAG, "Could not add invisible overlay window — falling back to notifications", e)
            overlayView = null
        }
    }

    private fun removeInvisibleOverlay() {
        overlayView?.let {
            try {
                (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it)
            } catch (_: Exception) {
                // Already removed, or the window manager rejected it — nothing to clean up.
            }
        }
        overlayView = null
    }

    /**
     * Launches [intent] directly when the invisible overlay window is up
     * (see above), or via [launchViaNotification] otherwise. Every call
     * site already builds a real, launchable Activity intent — this just
     * decides *how* to start it, never whether it's safe to.
     */
    private fun launchApp(intent: Intent, tapText: String): LaunchOutcome {
        if (overlayView != null) {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                return LaunchOutcome.OPENED
            } catch (e: Exception) {
                Log.w(TAG, "Direct startActivity failed despite the overlay window, falling back to notification", e)
            }
        }
        return if (launchViaNotification(intent, tapText)) LaunchOutcome.NOTIFIED else LaunchOutcome.FAILED
    }

    /** Posts a tap-to-launch notification for [intent] — the fallback way to
     * open another app (WhatsApp, the dialer) from a background Service when
     * [launchApp] can't start it directly; a direct startActivity() call here
     * is silently dropped by Android's background activity-launch
     * restrictions (API 29+), with no exception to catch.
     *
     * Checks notification permission first and speaks up if it's off — this
     * would otherwise fail exactly as silently as the restriction above:
     * notify() doesn't throw when notifications are disabled, it just shows
     * nothing, so the user hears "Listo, señor" and then sees no notification
     * with no way to tell why. Returns whether the notification was actually
     * posted — callers should only speak a "toque la notificación" success
     * message when this returns true, since [speakLocally] flushes any
     * in-progress speech and would otherwise cut off the diagnostic message
     * this posts when it returns false. */
    private fun launchViaNotification(intent: Intent, tapText: String): Boolean {
        val nm = getSystemService(NotificationManager::class.java)
        val channelBlocked = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            nm.getNotificationChannel(ACTION_CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled() || channelBlocked) {
            speakLocally(
                "Señor, no puedo mostrarle una notificación — tiene las notificaciones de JARVIS " +
                    "desactivadas. Actívelas en los ajustes del sistema para usar este comando."
            )
            return false
        }
        val pendingIntent = PendingIntent.getActivity(
            this, System.currentTimeMillis().toInt(), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, ACTION_CHANNEL_ID)
            .setContentTitle("JARVIS")
            .setContentText(tapText)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        nm.notify(ACTION_NOTIFICATION_ID, notification)
        return true
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
