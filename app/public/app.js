// Minimal JARVIS web UI: text-mode chat (always available) + voice mode
// (OpenAI Realtime over WebRTC, requires OPENAI_API_KEY configured
// server-side). See JARVIS/ARCHITECTURE.md for the overall data flow.

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

// --- Orb audio reactivity: real amplitude from OpenAI's own Realtime
// voice output during a voice session, plus a lighter reaction to the
// user's own mic input while listening. The orb just renders whatever
// energy value it's given each frame — see orb.js. Text-mode chat has no
// audio output, so it doesn't drive the orb.

let audioCtx = null;
let voiceAnalyser = null;
let micAnalyser = null;

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
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
  const voiceEnergy = analyserEnergy(voiceAnalyser);
  const micEnergy = analyserEnergy(micAnalyser) * 0.45; // secondary, dampened "listening" cue
  orb.setEnergy(Math.max(voiceEnergy, micEnergy));
  requestAnimationFrame(driveOrb);
}
requestAnimationFrame(driveOrb);

async function refreshStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    configJsonEl.textContent = JSON.stringify(data, null, 2);
    setPill(connStatusEl, "connection: ok", "ok");
    setPill(
      assistantStatusEl,
      data.voiceConfigured ? "assistant: voice ready" : "assistant: text-only",
      data.voiceConfigured ? "ok" : "warn"
    );
  } catch (err) {
    setPill(connStatusEl, "connection: error", "error");
    logError(`Status check failed: ${err}`);
  }
}

// --- Text-mode chat (always available, no API key required) ---

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
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
  } catch (err) {
    logError(`Chat failed: ${err}`);
  }
});

// --- Voice mode (OpenAI Realtime over WebRTC) ---

let peerConnection = null;
let dataChannel = null;
let micStream = null;
let voiceActive = false;

async function executeToolCall(name, argsJson, callId) {
  let params = {};
  try {
    params = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    // leave params empty; the server-side schema validation will reject as needed
  }

  let confirmed = false;
  const destructiveHint = /forget|delete|remove/i.test(name);
  if (destructiveHint) {
    confirmed = window.confirm(`JARVIS wants to run "${name}". This may be irreversible. Allow it?`);
  }

  const res = await fetch(`/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params, confirmed }),
  });
  const result = await res.json();
  logTool(name, result.ok);

  dataChannel.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    })
  );
  dataChannel.send(JSON.stringify({ type: "response.create" }));
}

function handleRealtimeEvent(event) {
  switch (event.type) {
    case "response.function_call_arguments.done":
      executeToolCall(event.name, event.arguments, event.call_id).catch((err) =>
        logError(`Tool execution failed: ${err}`)
      );
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (event.transcript) addTurn("user", event.transcript);
      break;
    case "response.audio_transcript.done":
      if (event.transcript) addTurn("assistant", event.transcript);
      break;
    case "error":
      logError(event.error?.message || "Realtime error");
      break;
    default:
      break;
  }
}

async function startVoice() {
  setPill(micStatusEl, "mic: requesting…", "warn");
  try {
    const sessionRes = await fetch("/api/realtime/session", { method: "POST" });
    const session = await sessionRes.json();
    if (!sessionRes.ok) throw new Error(session.error || "Could not start voice session");

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setPill(micStatusEl, "mic: live", "ok");

    peerConnection = new RTCPeerConnection();
    peerConnection.ontrack = (e) => {
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.srcObject = e.streams[0];
      document.body.appendChild(audioEl);

      const ctx = ensureAudioContext();
      const source = ctx.createMediaStreamSource(e.streams[0]);
      voiceAnalyser = ctx.createAnalyser();
      voiceAnalyser.fftSize = 256;
      source.connect(voiceAnalyser); // analysis only — audioEl already handles playback
    };
    for (const track of micStream.getTracks()) {
      peerConnection.addTrack(track, micStream);
    }

    {
      const ctx = ensureAudioContext();
      const micSource = ctx.createMediaStreamSource(micStream);
      micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 256;
      micSource.connect(micAnalyser); // analysis only, never routed to destination
    }

    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.onmessage = (e) => handleRealtimeEvent(JSON.parse(e.data));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const sdpRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        "Content-Type": "application/sdp",
      },
    });
    const answerSdp = await sdpRes.text();
    await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });

    voiceActive = true;
    micButton.textContent = "🎤 Stop voice";
    micButton.classList.add("listening");
    setPill(assistantStatusEl, "assistant: listening", "ok");
  } catch (err) {
    setPill(micStatusEl, "mic: error", "error");
    logError(`Voice start failed: ${err}`);
    stopVoice();
  }
}

function stopVoice() {
  voiceActive = false;
  micButton.textContent = "🎤 Start voice";
  micButton.classList.remove("listening");
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (peerConnection) peerConnection.close();
  micStream = null;
  peerConnection = null;
  dataChannel = null;
  voiceAnalyser = null;
  micAnalyser = null;
  setPill(micStatusEl, "mic: idle");
  setPill(assistantStatusEl, "assistant: idle");
}

micButton.addEventListener("click", () => {
  ensureAudioContext();
  if (voiceActive) stopVoice();
  else startVoice();
});

refreshStatus();
setInterval(refreshStatus, 15000);
