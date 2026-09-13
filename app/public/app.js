// Minimal JARVIS web UI: text-mode chat (always available) + voice mode
// (OpenAI Realtime over WebRTC, requires OPENAI_API_KEY configured
// server-side). See JARVIS/ARCHITECTURE.md for the overall data flow.
//
// Speech output: when ElevenLabs is configured server-side, the Realtime
// session is created text-only (see voice/realtimeClient.ts) and this
// file fetches synthesized audio from /api/tts for each finished response
// instead of playing OpenAI's own voice.

let speechSynthesisConfigured = false;

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

const ttsAudioEl = new Audio();

/** Fetches ElevenLabs-synthesized speech for text and plays it. No-op if not configured. */
async function speak(text) {
  if (!speechSynthesisConfigured || !text) return;
  try {
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
    speak(data.reply);
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
      // Only fires when OpenAI itself is generating audio (ElevenLabs not configured).
      if (event.transcript) addTurn("assistant", event.transcript);
      break;
    case "response.text.done":
      // Fires instead of the above when the session is text-only (ElevenLabs speaks it).
      if (event.text) {
        addTurn("assistant", event.text);
        speak(event.text);
      }
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
    // Only fires when the session is audio+text (ElevenLabs not configured) —
    // OpenAI won't send an audio track at all for a text-only session.
    peerConnection.ontrack = (e) => {
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.srcObject = e.streams[0];
      document.body.appendChild(audioEl);
    };
    for (const track of micStream.getTracks()) {
      peerConnection.addTrack(track, micStream);
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
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (peerConnection) peerConnection.close();
  micStream = null;
  peerConnection = null;
  dataChannel = null;
  setPill(micStatusEl, "mic: idle");
  setPill(assistantStatusEl, "assistant: idle");
}

micButton.addEventListener("click", () => {
  if (voiceActive) stopVoice();
  else startVoice();
});

refreshStatus();
setInterval(refreshStatus, 15000);
