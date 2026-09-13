// JARVIS web UI. Voice mode: the browser's own speech recognition
// transcribes what you say (free, no API key), sends it through the exact
// same pipeline as typing in the text box, and speaks the reply back with
// ElevenLabs. See JARVIS/ARCHITECTURE.md § Decisions for why this replaced
// the earlier OpenAI Realtime WebRTC approach.

let speechSynthesisConfigured = false;

const orb = createJarvisOrb(document.getElementById("orb-canvas"));

const conversationEl = document.getElementById("conversation");
const toolLogEl = document.getElementById("tool-log");
const errorSection = document.getElementById("errors");
const errorLogEl = document.getElementById("error-log");
const connStatusEl = document.getElementById("conn-status");
const micStatusEl = document.getElementById("mic-status");
const assistantStatusEl = document.getElementById("assistant-status");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const micButton = document.getElementById("mic-button");
const configJsonEl = document.getElementById("config-json");
const logoutButton = document.getElementById("logout-button");

function setPill(el, text, level) {
  el.textContent = text;
  el.className = "status-pill" + (level ? ` ${level}` : "");
}

function addTurn(role, text) {
  const div = document.createElement("div");
  div.className = `turn ${role}`;
  div.textContent = text;
  conversationEl.appendChild(div);
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

function logTool(name, ok) {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} ${name} — ${ok ? "ok" : "error"}`;
  toolLogEl.prepend(li);
}

function logError(message) {
  errorSection.hidden = false;
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  errorLogEl.prepend(li);
}

// --- Audio: ElevenLabs playback + orb reactivity ---
// Two independent analysers: one on the ElevenLabs playback element
// (JARVIS speaking), one on the raw mic stream (user speaking, lighter
// weight) — see driveOrb() below.

let audioCtx = null;
let ttsAnalyser = null;
let ttsSource = null;
let micAnalyser = null;
const ttsAudioEl = new Audio();

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/** createMediaElementSource can only be called once per <audio> element — set up lazily, once. */
function ensureTtsAnalyser() {
  const ctx = ensureAudioContext();
  if (!ttsSource) {
    ttsSource = ctx.createMediaElementSource(ttsAudioEl);
    ttsAnalyser = ctx.createAnalyser();
    ttsAnalyser.fftSize = 256;
    // Route back to the speakers — createMediaElementSource otherwise
    // silently captures the audio into the Web Audio graph instead of
    // letting it play normally.
    ttsSource.connect(ttsAnalyser);
    ttsAnalyser.connect(ctx.destination);
  }
}

function analyserEnergy(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  let sum = 0;
  for (const v of data) sum += v;
  return sum / data.length / 255;
}

function driveOrb() {
  const ttsEnergy = !ttsAudioEl.paused ? analyserEnergy(ttsAnalyser) : 0;
  const micEnergy = analyserEnergy(micAnalyser) * 0.45; // secondary, dampened "listening" cue
  orb.setEnergy(Math.max(ttsEnergy, micEnergy));
  requestAnimationFrame(driveOrb);
}
requestAnimationFrame(driveOrb);

/** Fetches ElevenLabs-synthesized speech for text and plays it. No-op if not configured. */
async function speak(text) {
  if (!speechSynthesisConfigured || !text) return;
  try {
    ensureTtsAnalyser();
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "TTS request failed");
    }
    const blob = await res.blob();
    ttsAudioEl.src = URL.createObjectURL(blob);
    await ttsAudioEl.play();
  } catch (err) {
    logError(`Speech synthesis failed: ${err}`);
  }
}

async function refreshStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    configJsonEl.textContent = JSON.stringify(data, null, 2);
    speechSynthesisConfigured = Boolean(data.speechSynthesisConfigured);
    logoutButton.hidden = !data.authEnabled;
    setPill(connStatusEl, "connection: ok", "ok");
    setPill(
      assistantStatusEl,
      data.geminiConfigured ? "assistant: brain ready" : "assistant: templates only",
      data.geminiConfigured ? "ok" : "warn"
    );
  } catch (err) {
    setPill(connStatusEl, "connection: error", "error");
    logError(`Status check failed: ${err}`);
  }
}

// --- Shared send path: used by both the text box and voice transcripts ---

async function sendMessage(message) {
  if (!message) return;
  addTurn("user", message);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    for (const call of data.toolCalls ?? []) {
      logTool(call.name, call.result?.ok);
    }
    addTurn("assistant", data.reply);
    if (data.debugError) {
      logError(`Conversational reply failed, showed the fallback instead: ${data.debugError}`);
    }
    speak(data.reply);
  } catch (err) {
    logError(`Chat failed: ${err}`);
  }
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  ensureAudioContext(); // must happen synchronously within the user gesture for autoplay to work
  const message = chatInput.value.trim();
  chatInput.value = "";
  await sendMessage(message);
});

// --- Voice mode: browser speech recognition -> sendMessage() -> ElevenLabs ---

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let micStream = null;
let voiceActive = false;

async function startVoice() {
  if (!SpeechRecognitionCtor) {
    logError("This browser doesn't support speech recognition. Try Chrome or Edge.");
    return;
  }
  setPill(micStatusEl, "mic: requesting…", "warn");
  ensureAudioContext();

  try {
    // Requested separately from SpeechRecognition (which manages its own
    // mic access internally) purely so the orb can react to your voice.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = ensureAudioContext();
    const micSource = ctx.createMediaStreamSource(micStream);
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 256;
    micSource.connect(micAnalyser); // analysis only, never routed to destination
    setPill(micStatusEl, "mic: live", "ok");
  } catch (err) {
    setPill(micStatusEl, "mic: error", "error");
    logError(`Microphone access failed: ${err}`);
    return;
  }

  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "es-ES";

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const transcript = result?.[0]?.transcript?.trim();
    if (result?.isFinal && transcript) {
      sendMessage(transcript);
    }
  };

  recognition.onerror = (event) => {
    if (event.error !== "no-speech") {
      logError(`Speech recognition error: ${event.error}`);
    }
  };

  recognition.onend = () => {
    // Browsers auto-stop recognition after a period of silence even with
    // continuous=true — restart it seamlessly while voice mode is on.
    if (voiceActive) {
      try {
        recognition.start();
      } catch {
        // already starting — harmless
      }
    }
  };

  recognition.start();
  voiceActive = true;
  micButton.textContent = "🎤 Stop voice";
  micButton.classList.add("listening");
  setPill(assistantStatusEl, "assistant: listening", "ok");
}

function stopVoice() {
  voiceActive = false;
  micButton.textContent = "🎤 Start voice";
  micButton.classList.remove("listening");
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  micAnalyser = null;
  setPill(micStatusEl, "mic: idle");
  setPill(assistantStatusEl, "assistant: idle");
}

micButton.addEventListener("click", () => {
  if (voiceActive) stopVoice();
  else startVoice();
});

logoutButton.addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
});

if ("serviceWorker" in navigator) {
  // Registered purely so the browser treats JARVIS as an installable PWA —
  // it does no offline caching (see public/sw.js).
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

refreshStatus();
setInterval(refreshStatus, 15000);
