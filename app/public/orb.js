// Audio-reactive particle sphere (purple "JARVIS core" visual). Pure
// Canvas 2D, no dependencies — see JARVIS/ARCHITECTURE.md for why. Energy
// (0..1, driven from real microphone/speech audio in app.js) controls
// rotation speed and scale; at energy 0 it still breathes gently so it
// never looks frozen.

function createJarvisOrb(canvas) {
  const ctx = canvas.getContext("2d");
  let width = 0;
  let height = 0;
  let cx = 0;
  let cy = 0;
  let baseRadius = 0;
  let targetEnergy = 0;
  let smoothEnergy = 0;
  let t = 0;
  let raf = null;

  // Drag-to-spin: horizontal drag adds extra spin on top of the automatic
  // rotation, vertical drag tilts it. Releasing keeps it spinning with
  // decaying velocity (inertia) instead of stopping dead.
  let manualRotY = 0;
  let manualRotX = 0;
  let velY = 0;
  let velX = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const DRAG_SENSITIVITY = 0.012;
  const MAX_TILT = 1.3;
  const INERTIA_DAMPING = 0.94;

  const RINGS = [
    { radius: 0.5, tiltX: 0.95, tiltZ: 0.2, count: 60, speed: 0.55, dir: 1 },
    { radius: 0.68, tiltX: 0.3, tiltZ: -0.55, count: 75, speed: 0.4, dir: -1 },
    { radius: 0.84, tiltX: -0.65, tiltZ: 0.8, count: 85, speed: 0.5, dir: 1 },
    { radius: 1.0, tiltX: 0.12, tiltZ: -0.9, count: 95, speed: 0.32, dir: -1 },
    { radius: 0.36, tiltX: 1.3, tiltZ: 0.45, count: 45, speed: 0.8, dir: 1 },
  ];

  const particles = [];
  for (const ring of RINGS) {
    for (let i = 0; i < ring.count; i++) {
      particles.push({
        ring,
        baseAngle: (i / ring.count) * Math.PI * 2 + Math.random() * 0.06,
        radiusJitter: 0.9 + Math.random() * 0.18,
      });
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width || 1;
    height = rect.height || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = width / 2;
    cy = height / 2;
    baseRadius = Math.min(width, height) * 0.34;
  }

  function rotateX(p, a) {
    const s = Math.sin(a);
    const c = Math.cos(a);
    return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
  }
  function rotateZ(p, a) {
    const s = Math.sin(a);
    const c = Math.cos(a);
    return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z };
  }
  function rotateY(p, a) {
    const s = Math.sin(a);
    const c = Math.cos(a);
    return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
  }

  function onPointerDown(e) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    velY = 0;
    velX = 0;
    canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    velY = dx * DRAG_SENSITIVITY;
    velX = -dy * DRAG_SENSITIVITY;
    manualRotY += velY;
    manualRotX = Math.max(-MAX_TILT, Math.min(MAX_TILT, manualRotX + velX));
  }

  function onPointerUp(e) {
    dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // already released — harmless
    }
  }

  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  function frame() {
    smoothEnergy += (targetEnergy - smoothEnergy) * 0.12;
    const e = smoothEnergy;
    t += 0.006 + e * 0.012;

    if (!dragging) {
      // Inertia: keep coasting on the last drag velocity, decaying to a stop.
      manualRotY += velY;
      manualRotX = Math.max(-MAX_TILT, Math.min(MAX_TILT, manualRotX + velX));
      velY *= INERTIA_DAMPING;
      velX *= INERTIA_DAMPING;
      if (Math.abs(velY) < 0.00005) velY = 0;
      if (Math.abs(velX) < 0.00005) velX = 0;
      // Gently settle the tilt back toward level so it doesn't stay stuck sideways.
      manualRotX *= 0.985;
    }

    // Low-alpha fill instead of a hard clear leaves faint motion trails.
    ctx.fillStyle = `rgba(4, 2, 12, ${0.32 - e * 0.08})`;
    ctx.fillRect(0, 0, width, height);

    const globalRot = t * 0.3;
    const scale = 1 + e * 0.3 + Math.sin(t * 1.2) * 0.02;
    const focal = 260;

    ctx.globalCompositeOperation = "lighter";

    const rayCount = 10;
    for (let i = 0; i < rayCount; i++) {
      const a = (i / rayCount) * Math.PI * 2 + t * 0.15 + manualRotY;
      const len = baseRadius * (1.4 + e * 1.3);
      const grad = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      grad.addColorStop(0, `rgba(216,180,254,${0.16 + e * 0.28})`);
      grad.addColorStop(1, "rgba(139,92,246,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.stroke();
    }

    for (const p of particles) {
      const ring = p.ring;
      const angle = p.baseAngle + t * ring.speed * ring.dir;
      const r = baseRadius * ring.radius * p.radiusJitter * scale;
      let pos = { x: Math.cos(angle) * r, y: Math.sin(angle) * r, z: 0 };
      pos = rotateX(pos, ring.tiltX);
      pos = rotateZ(pos, ring.tiltZ);
      pos = rotateX(pos, manualRotX);
      pos = rotateY(pos, globalRot + manualRotY);

      const perspective = focal / (focal + pos.z);
      const sx = cx + pos.x * perspective;
      const sy = cy + pos.y * perspective;
      const depth = Math.max(0.15, Math.min(1, perspective));
      const size = Math.max(0.6, (1.1 + e * 1.4) * depth);

      const lightness = 55 + depth * 20 + e * 10;
      const hue = 268 + depth * 18;
      ctx.fillStyle = `hsla(${hue}, 90%, ${lightness}%, ${0.35 + depth * 0.5})`;
      ctx.beginPath();
      ctx.arc(sx, sy, size, 0, Math.PI * 2);
      ctx.fill();
    }

    const coreRadius = baseRadius * (0.26 + e * 0.24) * (1 + Math.sin(t * 2) * 0.02);
    const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius);
    coreGrad.addColorStop(0, "rgba(243,232,255,0.92)");
    coreGrad.addColorStop(0.35, `rgba(216,180,254,${0.65 + e * 0.25})`);
    coreGrad.addColorStop(1, "rgba(88,28,135,0)");
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, coreRadius), 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = "source-over";

    raf = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    /** 0..1 — real-time speech/listening energy driving scale + spin speed. */
    setEnergy(v) {
      targetEnergy = Math.max(0, Math.min(1, v));
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
