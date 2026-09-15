package com.jarvis.app

import java.text.Normalizer
import java.util.Locale

/**
 * Accent/case-insensitive fuzzy text matching, shared by on-screen element
 * matching (JarvisAccessibilityService — "toca X" against whatever label
 * text is actually on screen). Bidirectional substring match with a
 * minimum-length guard, so two short, unrelated strings ("no"/"lo") don't
 * spuriously match.
 */
object TextMatch {
    fun normalize(text: String): String {
        val stripped = Normalizer.normalize(text, Normalizer.Form.NFD)
            .replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
        return stripped.lowercase(Locale("es")).trim()
    }

    fun fuzzyContains(a: String, b: String): Boolean {
        if (a.isEmpty() || b.isEmpty()) return false
        val minMatchLength = 3
        if (a.length < minMatchLength || b.length < minMatchLength) return a == b
        return a.contains(b) || b.contains(a)
    }
}
