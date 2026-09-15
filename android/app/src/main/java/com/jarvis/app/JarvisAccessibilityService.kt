package com.jarvis.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Lets JARVIS simulate a real touch on screen ("toca X", "aprieta X") by
 * searching the current window's accessibility tree for a node whose
 * visible text/content description matches what was asked, then
 * dispatching a tap gesture at its center — a genuine touch event, not
 * [AccessibilityNodeInfo.ACTION_CLICK], so it also works on custom-drawn
 * views that don't expose a click action at all (needed for the planned
 * next step: reading a chess board and tapping specific squares — see
 * JARVIS/ARCHITECTURE.md § Decisions).
 *
 * Entirely optional and off by default: Android does not let an app turn
 * on its own accessibility service — the user must do it manually in
 * Ajustes > Accesibilidad (MainActivity's "Detalles" panel links straight
 * there). See JARVIS/SECURITY.md § Android app actions (tap-on-screen).
 */
class JarvisAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "JarvisAccessibility"

        /** Non-null only while the user has actually enabled the service —
         * read by JarvisListenerService to decide whether "toca X" is available. */
        @Volatile
        var instance: JarvisAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
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
