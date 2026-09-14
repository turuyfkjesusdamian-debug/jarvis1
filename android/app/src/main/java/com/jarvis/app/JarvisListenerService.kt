package com.jarvis.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.provider.ContactsContract
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.app.NotificationCompat
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
 * All of the above launch via a tap-to-open notification
 * ([launchViaNotification]) rather than directly — Android silently
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
        // "mándale mensaje a Juan diciendo hola" against the accent/case
        // -stripped transcript — see JARVIS/SECURITY.md § Actions requiring
        // confirmation. Deliberately simple pattern matching, not sent
        // through Gemini: the contact name and message never need to leave
        // the phone for this to work.
        private val SEND_MESSAGE_REGEX = Regex(
            "(?:envia(?:le)?|manda(?:le)?)\\s+(?:un\\s+)?mensaje\\s+a\\s+(.+?)\\s+" +
                "(?:que diga|diciendo|con el mensaje|diciendole)\\s+(.+)"
        )
        // Matches e.g. "llama a mamá" / "márcale a Juan" / "haz una llamada a mi hermano".
        private val CALL_REGEX = Regex("(?:llama(?:le)?|marca(?:le)?|haz una llamada)\\s+a\\s+(.+)")
        // Compared against the accent-stripped transcript, so "señor" here is "senor".
        private val AFFIRMATIVE_ANSWERS = setOf("si", "si senor", "confirmo", "correcto", "dale", "adelante", "afirmativo")
        // "jarvis apágate" also matches inside "oye jarvis apágate" as a substring,
        // so both phrasings work without a separate wake-word check.
        private val SHUTDOWN_PHRASES = listOf("jarvis apagate", "jarvis apagar")
        // Matches e.g. "reproduce despacito en youtube" / "busca gatos en youtube".
        // Opens search results, not a specific video — see class doc comment.
        private val YOUTUBE_REGEX = Regex("(?:reproduce|busca|pon)\\s+(.+?)\\s+en\\s+youtube")
        // Matches e.g. "abre spotify" / "ábreme la app de whatsapp".
        private val OPEN_APP_REGEX = Regex(
            "abre(?:me)?\\s+(?:la\\s+app\\s+de\\s+|la\\s+aplicacion\\s+de\\s+|la\\s+app\\s+|la\\s+aplicacion\\s+)?(.+)"
        )
        // Matches e.g. "abre disney reproduce deadpool" / "abre spotify y busca queen".
        // Tried before OPEN_APP_REGEX, which would otherwise swallow the whole
        // thing as one (nonexistent) app name.
        private val OPEN_AND_PLAY_REGEX = Regex("abre(?:me)?\\s+(.+?)\\s+(?:y\\s+)?(?:reproduce|busca|pon)\\s+(.+)")
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
        /** No confirmation needed — opening an app or a YouTube search has no
         * effect on anyone but the user, unlike WhatsApp/calls. */
        data class LaunchNow(val intent: Intent, val tapText: String, val spokenText: String) : CommandParseResult()
    }

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
            ?: tryParseOpenAppCommand(command)

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
                launchViaNotification(parsed.intent, parsed.tapText)
                speakLocally(parsed.spokenText)
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
            CommandParseResult.NotAMatch ->
                sendCommand(command)
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

        val encodedQuery = URLEncoder.encode(query, "UTF-8").replace("+", "%20")
        val uri = Uri.parse("https://www.youtube.com/results?search_query=$encodedQuery")
        val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return CommandParseResult.LaunchNow(
            intent,
            "Toque para ver \"$query\" en YouTube",
            "Listo, señor. Toque la notificación para ver los resultados de $query en YouTube."
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
                "Listo, señor. Toque la notificación para buscar $query en $appName."
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
                    "Toque la notificación para abrir $label, señor — no puedo buscar $query ahí automáticamente, tendrá que hacerlo desde la app."
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

        val matches = findLaunchableApps(appName)
        return when {
            matches.isEmpty() -> CommandParseResult.AppNotFound(appName)
            matches.size > 1 -> CommandParseResult.MultipleApps(appName, matches.size)
            else -> {
                val (label, intent) = matches[0]
                CommandParseResult.LaunchNow(intent, "Toque para abrir $label", "Listo, señor. Toque la notificación para abrir $label.")
            }
        }
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

    /** Returns (displayName, number) pairs whose name contains [name], accent/case-insensitive. */
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
                    if (stripAccents(displayName.lowercase(Locale("es"))).contains(target)) {
                        results.add(displayName to number)
                    }
                }
            }
        return results.distinctBy { it.second }
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
            launchViaNotification(intent, "Toque para abrir WhatsApp con el mensaje para ${pending.contactName}")
            speakLocally("Listo, señor. Toque la notificación para abrir WhatsApp con el mensaje para ${pending.contactName}.")
        } catch (e: Exception) {
            Log.e(TAG, "openWhatsApp failed", e)
            speakLocally("No pude preparar WhatsApp, señor.")
        }
    }

    private fun placeCall(pending: PendingConfirmation.PhoneCall) {
        try {
            val uri = Uri.parse("tel:${pending.phone}")
            val intent = Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            launchViaNotification(intent, "Toque para llamar a ${pending.contactName}")
            speakLocally("Listo, señor. Toque la notificación para llamar a ${pending.contactName}.")
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
                setOnPreparedListener { start() }
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
        localTts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "jarvis-local")
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

    /** Posts a tap-to-launch notification for [intent] — the only reliable way to
     * open another app (WhatsApp, the dialer) from a background Service; a direct
     * startActivity() call here is silently dropped by Android's background
     * activity-launch restrictions (API 29+), with no exception to catch. */
    private fun launchViaNotification(intent: Intent, tapText: String) {
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
        getSystemService(NotificationManager::class.java).notify(ACTION_NOTIFICATION_ID, notification)
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
