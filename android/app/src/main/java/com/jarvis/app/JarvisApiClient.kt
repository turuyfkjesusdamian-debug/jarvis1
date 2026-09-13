package com.jarvis.app

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Talks to the existing JARVIS server (the same Express backend the web UI
 * uses) — /api/auth/login, /api/chat, /api/tts. Plain HttpURLConnection on
 * purpose: no networking library dependency to keep the very first build of
 * this app as likely as possible to compile cleanly in CI, since there's no
 * way to test it interactively before shipping an APK. See
 * JARVIS/ARCHITECTURE.md § Decisions for the Android app's overall design.
 *
 * Every method here does blocking I/O — always call from a background
 * thread, never the main thread.
 */
class JarvisApiClient(private var baseUrl: String) {

    /** Raw Set-Cookie value from a successful login, replayed on every later request. */
    private var sessionCookie: String? = null

    fun setBaseUrl(url: String) {
        baseUrl = url.trimEnd('/')
    }

    fun hasSession(): Boolean = sessionCookie != null

    fun restoreSession(cookie: String?) {
        sessionCookie = cookie
    }

    fun currentSessionCookie(): String? = sessionCookie

    class ApiException(message: String) : Exception(message)

    /** Logs in with the shared JARVIS_APP_PASSWORD and stores the resulting session cookie. */
    fun login(password: String) {
        val conn = openConnection("/api/auth/login", "POST")
        writeJsonBody(conn, JSONObject().put("password", password))

        val status = conn.responseCode
        if (status != 200) {
            throw ApiException(readError(conn, "Inicio de sesión falló ($status)"))
        }
        val cookie = conn.headerFields["Set-Cookie"]?.firstOrNull()?.split(";")?.firstOrNull()
            ?: throw ApiException("El servidor no devolvió una sesión.")
        sessionCookie = cookie
    }

    data class ChatReply(val reply: String, val debugError: String?)

    /** Sends a text message through the same pipeline as the web UI's chat box. */
    fun sendMessage(message: String): ChatReply {
        val conn = openConnection("/api/chat", "POST", withSession = true)
        writeJsonBody(conn, JSONObject().put("message", message))

        val status = conn.responseCode
        if (status == 401) throw ApiException("Sesión expirada o inválida. Inicia sesión de nuevo.")
        if (status !in 200..299) {
            throw ApiException(readError(conn, "La solicitud de chat falló ($status)"))
        }
        val body = JSONObject(readBody(conn))
        return ChatReply(
            reply = body.optString("reply", ""),
            debugError = if (body.isNull("debugError")) null else body.optString("debugError"),
        )
    }

    /** Fetches ElevenLabs-synthesized speech for a reply. Returns raw MP3 bytes. */
    fun synthesizeSpeech(text: String): ByteArray {
        val conn = openConnection("/api/tts", "POST", withSession = true)
        writeJsonBody(conn, JSONObject().put("text", text))

        val status = conn.responseCode
        if (status !in 200..299) {
            throw ApiException(readError(conn, "La síntesis de voz falló ($status)"))
        }
        return conn.inputStream.readBytes()
    }

    private fun openConnection(path: String, method: String, withSession: Boolean = false): HttpURLConnection {
        val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.connectTimeout = 15_000
        conn.readTimeout = 20_000
        if (withSession) {
            sessionCookie?.let { conn.setRequestProperty("Cookie", it) }
        }
        return conn
    }

    private fun writeJsonBody(conn: HttpURLConnection, json: JSONObject) {
        val bytes = json.toString().toByteArray(StandardCharsets.UTF_8)
        conn.setRequestProperty("Content-Length", bytes.size.toString())
        val out: OutputStream = conn.outputStream
        out.write(bytes)
        out.flush()
        out.close()
    }

    private fun readBody(conn: HttpURLConnection): String {
        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
        return BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { it.readText() }
    }

    private fun readError(conn: HttpURLConnection, fallback: String): String {
        return try {
            val body = JSONObject(readBody(conn))
            body.optString("error", fallback)
        } catch (_: Exception) {
            fallback
        }
    }
}
