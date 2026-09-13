package com.jarvis.app

import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.io.FileOutputStream

/**
 * Milestone 1: just enough to prove the whole pipeline works end to end —
 * log in against the existing JARVIS server, send a text message through
 * the same /api/chat path the web UI uses, and play back the spoken reply.
 * No background listening yet (see JARVIS/ARCHITECTURE.md § Decisions) —
 * that's milestone 2, once this is confirmed working on a real phone.
 */
class MainActivity : AppCompatActivity() {

    private val prefs by lazy { getSharedPreferences("jarvis", MODE_PRIVATE) }
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var api: JarvisApiClient
    private var mediaPlayer: MediaPlayer? = null

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

            runInBackground(
                work = { api.sendMessage(message) },
                onSuccess = { chatReply ->
                    replyText.text = chatReply.reply
                    speak(chatReply.reply)
                },
                onError = { err -> replyText.text = "Error: ${err.message}" },
            )
        }
    }

    private fun speak(text: String) {
        if (text.isBlank()) return
        runInBackground(
            work = { api.synthesizeSpeech(text) },
            onSuccess = { audioBytes -> playAudio(audioBytes) },
            onError = { /* no ElevenLabs configured, or it failed — text reply still shown */ },
        )
    }

    private fun playAudio(bytes: ByteArray) {
        val file = File(cacheDir, "jarvis_reply.mp3")
        FileOutputStream(file).use { it.write(bytes) }
        mediaPlayer?.release()
        mediaPlayer = MediaPlayer().apply {
            setDataSource(file.absolutePath)
            setOnPreparedListener { start() }
            setOnCompletionListener { it.release() }
            prepareAsync()
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
