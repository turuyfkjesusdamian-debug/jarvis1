package com.jarvis.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Lets JARVIS simulate a real touch on screen ("toca X", "aprieta X") by
 * searching the current window's accessibility tree for a node whose
 * visible text/content description matches what was asked, then
 * dispatching a tap gesture at its center — a genuine touch event, not
 * [AccessibilityNodeInfo.ACTION_CLICK], so it also works on custom-drawn
 * views that don't expose a click action at all. When that text search
 * finds nothing (an icon with no label, a canvas-drawn view like a game
 * board), [captureScreenshotJpegBase64] + the server's Gemini-vision
 * classification (`JarvisApiClient.locateScreenElement`,
 * JarvisListenerService) can locate it visually instead, then
 * [tapAtNormalizedPoint] taps the computed spot directly — see
 * JARVIS/ARCHITECTURE.md § Decisions.
 *
 * Entirely optional and off by default: Android does not let an app turn
 * on its own accessibility service — the user must do it manually in
 * Ajustes > Accesibilidad (MainActivity's "Detalles" panel links straight
 * there). See JARVIS/SECURITY.md § Android app actions (tap-on-screen).
 */
class JarvisAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "JarvisAccessibility"
        private const val SCREENSHOT_TIMEOUT_SECONDS = 5L
        private const val SCREENSHOT_JPEG_QUALITY = 70

        /** Non-null only while the user has actually enabled the service —
         * read by JarvisListenerService to decide whether "toca X" is available. */
        @Volatile
        var instance: JarvisAccessibilityService? = null
            private set
    }

    /** [takeScreenshot]'s callback always fires on this executor, never the
     * caller's own thread — captureScreenshotJpegBase64 blocks the calling
     * (background) thread on a latch until it does. */
    private val screenshotExecutor = Executors.newSingleThreadExecutor()

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        screenshotExecutor.shutdown()
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    /**
     * Finds the best-matching visible node in the active window whose text
     * or content description fuzzy-matches [query] and dispatches a real
     * tap gesture at its center. Returns the matched node's own label (so
     * JARVIS can read back exactly what it tapped) or null if nothing on
     * screen matched.
     */
    fun tapElementByText(query: String): String? {
        val root = rootInActiveWindow ?: return null
        val match = findBestMatch(root, query) ?: return null
        val bounds = Rect()
        match.getBoundsInScreen(bounds)
        if (bounds.width() <= 0 || bounds.height() <= 0) return null
        val label = (match.text ?: match.contentDescription ?: query).toString()
        dispatchTap(bounds.centerX().toFloat(), bounds.centerY().toFloat())
        return label
    }

    /** True only on Android 11+ (API 30), where [android.accessibilityservice.AccessibilityService.takeScreenshot]
     * exists at all — read by JarvisListenerService before attempting any
     * vision-based fallback, so an older device gets a clear "your Android
     * is too old for this" message instead of a silent failure. */
    fun canCaptureScreen(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    /**
     * Captures the current screen as a JPEG, base64-encoded (no `data:` URI
     * prefix) — used for the vision-based "toca X" fallback and for
     * "describe_screen" (see JarvisListenerService). Blocks the calling
     * thread for up to [SCREENSHOT_TIMEOUT_SECONDS] waiting for the
     * platform's own async callback — always call from a background thread,
     * never the main thread. Returns null on API < 30 ([canCaptureScreen])
     * or any failure (permission not actually active, no active window,
     * timeout, encoding error) — never throws.
     */
    fun captureScreenshotJpegBase64(): String? {
        if (!canCaptureScreen()) return null
        val latch = CountDownLatch(1)
        var captured: Bitmap? = null
        try {
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                screenshotExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(result: ScreenshotResult) {
                        try {
                            val hardwareBitmap = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                            captured = hardwareBitmap?.copy(Bitmap.Config.ARGB_8888, false)
                            hardwareBitmap?.recycle()
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to convert screenshot buffer", e)
                        } finally {
                            result.hardwareBuffer.close()
                            latch.countDown()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.w(TAG, "takeScreenshot failed with code $errorCode")
                        latch.countDown()
                    }
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "takeScreenshot threw", e)
            return null
        }
        latch.await(SCREENSHOT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val bitmap = captured ?: return null
        return try {
            val stream = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, SCREENSHOT_JPEG_QUALITY, stream)
            Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to encode screenshot as JPEG", e)
            null
        } finally {
            bitmap.recycle()
        }
    }

    /** Taps a point given in the server's normalized 0-1000 coordinate space
     * (0,0 top-left; 1000,1000 bottom-right — matches whatever
     * [captureScreenshotJpegBase64] just sent it), scaled to this device's
     * actual screen size. Used only for the vision-located tap fallback. */
    fun tapAtNormalizedPoint(nx: Int, ny: Int) {
        val metrics = resources.displayMetrics
        val x = (nx / 1000f) * metrics.widthPixels
        val y = (ny / 1000f) * metrics.heightPixels
        dispatchTap(x, y)
    }

    private fun dispatchTap(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 80))
            .build()
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCancelled(gestureDescription: GestureDescription?) {
                Log.w(TAG, "Tap gesture at ($x, $y) was cancelled")
            }
        }, null)
    }

    private fun findBestMatch(node: AccessibilityNodeInfo, query: String): AccessibilityNodeInfo? {
        val normalizedQuery = TextMatch.normalize(query)
        var best: AccessibilityNodeInfo? = null
        var bestScore = -1

        fun visit(n: AccessibilityNodeInfo) {
            val label = (n.text ?: n.contentDescription)?.toString()
            if (n.isVisibleToUser && !label.isNullOrBlank()) {
                val normalizedLabel = TextMatch.normalize(label)
                val exact = normalizedLabel == normalizedQuery
                val partial = !exact && TextMatch.fuzzyContains(normalizedLabel, normalizedQuery)
                if (exact || partial) {
                    val score = (if (exact) 100 else 50) + (if (n.isClickable) 10 else 0)
                    if (score > bestScore) {
                        bestScore = score
                        best = n
                    }
                }
            }
            for (i in 0 until n.childCount) {
                n.getChild(i)?.let(::visit)
            }
        }
        visit(node)
        return best
    }
}
