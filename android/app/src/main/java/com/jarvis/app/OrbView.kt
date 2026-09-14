package com.jarvis.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.Shader
import android.util.AttributeSet
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * Native port of app/public/orb.js — the audio-reactive purple particle
 * sphere from the web UI — so the Android app's main screen looks like the
 * web one (see JARVIS/ARCHITECTURE.md § Decisions). Same particle-ring
 * math, rotation, drag-to-spin with inertia, and energy-driven
 * scale/brightness; only the rendering primitives differ (Shader-based
 * gradients and an offscreen Bitmap for the fading-trail effect, which DOM
 * Canvas gets "for free" from simply not being cleared between frames).
 */
class OrbView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private class Ring(val radius: Float, val tiltX: Float, val tiltZ: Float, val count: Int, val speed: Float, val dir: Int)
    private class Particle(val ring: Ring, val baseAngle: Float, val radiusJitter: Float)
    private class Vec3(val x: Float, val y: Float, val z: Float)

    // Denser than the web version's original counts (60/75/85/95/45) —
    // on a phone-sized view the sphere read as sparse/thin, so each ring
    // carries about 1.5x more particles here.
    private val rings = listOf(
        Ring(0.5f, 0.95f, 0.2f, 90, 0.55f, 1),
        Ring(0.68f, 0.3f, -0.55f, 112, 0.4f, -1),
        Ring(0.84f, -0.65f, 0.8f, 128, 0.5f, 1),
        Ring(1.0f, 0.12f, -0.9f, 142, 0.32f, -1),
        Ring(0.36f, 1.3f, 0.45f, 68, 0.8f, 1),
    )

    private val particles: List<Particle> = rings.flatMap { ring ->
        (0 until ring.count).map { i ->
            Particle(
                ring,
                (i.toFloat() / ring.count) * (2 * PI).toFloat() + Random.nextFloat() * 0.06f,
                0.9f + Random.nextFloat() * 0.18f,
            )
        }
    }

    private var targetEnergy = 0f
    private var smoothEnergy = 0f
    private var t = 0f

    // Drag-to-spin: free-spinning on both axes, coasting with decaying
    // velocity after release instead of stopping dead — same feel as orb.js.
    private var manualRotY = 0f
    private var manualRotX = 0f
    private var velY = 0f
    private var velX = 0f
    private var dragging = false
    private var lastX = 0f
    private var lastY = 0f
    private val dragSensitivity = 0.012f
    private val inertiaDamping = 0.94f

    private var w = 0f
    private var h = 0f
    private var cx = 0f
    private var cy = 0f
    private var baseRadius = 0f

    private var buffer: Bitmap? = null
    private var bufferCanvas: Canvas? = null

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 3.5f }
    private val addXfermode = PorterDuffXfermode(PorterDuff.Mode.ADD)

    private var running = false
    private val choreographer = Choreographer.getInstance()
    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            step()
            invalidate()
            if (running) choreographer.postFrameCallback(this)
        }
    }

    override fun onSizeChanged(newW: Int, newH: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(newW, newH, oldw, oldh)
        w = newW.toFloat()
        h = newH.toFloat()
        cx = w / 2f
        cy = h / 2f
        baseRadius = min(w, h) * 0.34f
        buffer = Bitmap.createBitmap(max(1, newW), max(1, newH), Bitmap.Config.ARGB_8888)
        bufferCanvas = Canvas(buffer!!)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        running = true
        choreographer.postFrameCallback(frameCallback)
    }

    override fun onDetachedFromWindow() {
        running = false
        choreographer.removeFrameCallback(frameCallback)
        super.onDetachedFromWindow()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragging = true
                lastX = event.x
                lastY = event.y
                velY = 0f
                velX = 0f
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging) return true
                val dx = event.x - lastX
                val dy = event.y - lastY
                lastX = event.x
                lastY = event.y
                velY = dx * dragSensitivity
                velX = -dy * dragSensitivity
                manualRotY += velY
                manualRotX += velX
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                dragging = false
                parent?.requestDisallowInterceptTouchEvent(false)
            }
        }
        return true
    }

    /** 0..1 — real-time speech/playback energy driving scale + spin speed. */
    fun setEnergy(v: Float) {
        targetEnergy = v.coerceIn(0f, 1f)
    }

    private fun rotateX(p: Vec3, a: Float): Vec3 {
        val s = sin(a); val c = cos(a)
        return Vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c)
    }

    private fun rotateZ(p: Vec3, a: Float): Vec3 {
        val s = sin(a); val c = cos(a)
        return Vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z)
    }

    private fun rotateY(p: Vec3, a: Float): Vec3 {
        val s = sin(a); val c = cos(a)
        return Vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c)
    }

    private fun step() {
        val canvas = bufferCanvas ?: return
        smoothEnergy += (targetEnergy - smoothEnergy) * 0.12f
        val e = smoothEnergy
        t += 0.006f + e * 0.012f

        if (!dragging) {
            manualRotY += velY
            manualRotX += velX
            velY *= inertiaDamping
            velX *= inertiaDamping
            if (abs(velY) < 0.00005f) velY = 0f
            if (abs(velX) < 0.00005f) velX = 0f
        }

        // Trail fade: a low-alpha dark fill instead of a hard clear leaves
        // faint motion trails, same as the web version's fillRect trick.
        // A gentler fade than the web original (0.32→0.24 base) lets the
        // glow accumulate more before it's wiped, so the sphere reads as
        // a fuller light instead of a faint one.
        fillPaint.xfermode = null
        fillPaint.shader = null
        fillPaint.color = argb(0.24f - e * 0.06f, 4, 2, 12)
        canvas.drawRect(0f, 0f, w, h, fillPaint)

        val globalRot = t * 0.3f
        val scale = 1 + e * 0.3f + sin(t * 1.2f) * 0.02f
        val focal = 260f

        val rayCount = 10
        for (i in 0 until rayCount) {
            val a = (i.toFloat() / rayCount) * (2 * PI).toFloat() + t * 0.15f + manualRotY
            val len = baseRadius * (1.4f + e * 1.3f)
            val endX = cx + cos(a) * len
            val endY = cy + sin(a) * len
            strokePaint.shader = LinearGradient(
                cx, cy, endX, endY,
                argb(0.26f + e * 0.34f, 216, 180, 254),
                argb(0f, 139, 92, 246),
                Shader.TileMode.CLAMP,
            )
            strokePaint.xfermode = addXfermode
            canvas.drawLine(cx, cy, endX, endY, strokePaint)
        }

        for (p in particles) {
            val ring = p.ring
            val angle = p.baseAngle + t * ring.speed * ring.dir
            val r = baseRadius * ring.radius * p.radiusJitter * scale
            var pos = Vec3(cos(angle) * r, sin(angle) * r, 0f)
            pos = rotateX(pos, ring.tiltX)
            pos = rotateZ(pos, ring.tiltZ)
            pos = rotateX(pos, manualRotX)
            pos = rotateY(pos, globalRot + manualRotY)

            val perspective = focal / (focal + pos.z)
            val sx = cx + pos.x * perspective
            val sy = cy + pos.y * perspective
            val depth = perspective.coerceIn(0.15f, 1f)
            // Noticeably bigger than the web original (1.1 base/0.6 floor) —
            // small dots got lost on a phone screen; this reads as clearly
            // visible particles instead of a faint dust.
            val size = max(1.1f, (1.9f + e * 2.1f) * depth)

            val lightness = 58f + depth * 20f + e * 12f
            val hue = 268f + depth * 18f
            fillPaint.shader = null
            fillPaint.xfermode = addXfermode
            fillPaint.color = hslaToColor(hue, 92f, lightness, 0.45f + depth * 0.55f)
            canvas.drawCircle(sx, sy, size, fillPaint)
        }

        val coreRadius = baseRadius * (0.26f + e * 0.24f) * (1 + sin(t * 2f) * 0.02f)
        fillPaint.xfermode = addXfermode
        fillPaint.shader = RadialGradient(
            cx, cy, max(1f, coreRadius),
            intArrayOf(
                argb(1f, 243, 232, 255),
                argb(0.78f + e * 0.22f, 216, 180, 254),
                argb(0f, 88, 28, 135),
            ),
            floatArrayOf(0f, 0.35f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawCircle(cx, cy, max(1f, coreRadius), fillPaint)

        fillPaint.xfermode = null
        strokePaint.xfermode = null
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        buffer?.let { canvas.drawBitmap(it, 0f, 0f, null) }
    }

    private fun argb(alpha01: Float, r: Int, g: Int, b: Int): Int =
        Color.argb((alpha01.coerceIn(0f, 1f) * 255).toInt(), r, g, b)

    /** Approximates CSS hsla() (HSL, not HSV) → an ARGB int. */
    private fun hslaToColor(hue: Float, saturationPct: Float, lightnessPct: Float, alpha01: Float): Int {
        val hNorm = ((hue % 360f) + 360f) % 360f / 360f
        val s = (saturationPct / 100f).coerceIn(0f, 1f)
        val l = (lightnessPct / 100f).coerceIn(0f, 1f)
        val alpha = (alpha01.coerceIn(0f, 1f) * 255).toInt()
        if (s == 0f) {
            val v = (l * 255).toInt().coerceIn(0, 255)
            return Color.argb(alpha, v, v, v)
        }
        val q = if (l < 0.5f) l * (1 + s) else l + s - l * s
        val p = 2 * l - q
        fun hueToRgb(pp: Float, qq: Float, tIn: Float): Float {
            var tc = tIn
            if (tc < 0f) tc += 1f
            if (tc > 1f) tc -= 1f
            return when {
                tc < 1f / 6f -> pp + (qq - pp) * 6f * tc
                tc < 1f / 2f -> qq
                tc < 2f / 3f -> pp + (qq - pp) * (2f / 3f - tc) * 6f
                else -> pp
            }
        }
        val r = (hueToRgb(p, q, hNorm + 1f / 3f) * 255).toInt().coerceIn(0, 255)
        val g = (hueToRgb(p, q, hNorm) * 255).toInt().coerceIn(0, 255)
        val b = (hueToRgb(p, q, hNorm - 1f / 3f) * 255).toInt().coerceIn(0, 255)
        return Color.argb(alpha, r, g, b)
    }
}
