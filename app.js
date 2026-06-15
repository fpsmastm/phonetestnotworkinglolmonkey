/* ============================================================
   LINKUP — app.js
   WebRTC voice calling via PeerJS (free public STUN/TURN)
   No backend required — works on Cloudflare Pages / GitHub Pages
   ============================================================ */

'use strict';

// ── DOM refs ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  join:     $('screen-join'),
  lobby:    $('screen-lobby'),
  incoming: $('screen-incoming'),
  call:     $('screen-call'),
};

// ── State ────────────────────────────────────────────────────
let peer          = null;
let myName        = '';
let currentCall   = null;
let localStream   = null;
let isMuted       = false;
let callStartTime = null;
let timerInterval = null;
let volInterval   = null;
let audioCtx      = null;
let analyser      = null;

// ── Screen helper ────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ── Toast ────────────────────────────────────────────────────
let toastTimeout;
function toast(msg, duration = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Avatar letter ────────────────────────────────────────────
function avatarLetter(name) {
  return (name || '?')[0].toUpperCase();
}

// ── Generate friendly ID ─────────────────────────────────────
// Short readable IDs so students can share them easily
function friendlyId(name) {
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${clean}-${rand}`;
}

// ── STEP 1: Join / Create ID ─────────────────────────────────
$('btn-start').addEventListener('click', startSession);
$('input-name').addEventListener('keydown', e => { if (e.key === 'Enter') startSession(); });

function startSession() {
  const name = $('input-name').value.trim();
  if (!name) { toast('Enter your name first!'); $('input-name').focus(); return; }
  myName = name;

  const peerId = friendlyId(name);

  $('btn-start').textContent = 'Connecting…';
  $('btn-start').disabled = true;

  // PeerJS — uses free public PeerJS cloud server
  // For production, self-host a PeerServer or use a paid TURN service
  peer = new Peer(peerId, {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ]
    }
  });

  peer.on('open', id => {
    $('my-peer-id').textContent = id;
    showScreen('lobby');
    toast(`Welcome, ${name}! 🎉`);
  });

  peer.on('error', err => {
    console.error('PeerJS error:', err);
    // If the ID is taken, retry with a new one
    if (err.type === 'unavailable-id') {
      const newId = friendlyId(name) + '-' + Math.random().toString(36).slice(2, 4);
      peer.destroy();
      startWithId(name, newId);
      return;
    }
    toast('Connection error: ' + err.message);
    $('btn-start').textContent = 'Create my Call ID →';
    $('btn-start').disabled = false;
    showScreen('join');
  });

  // Incoming call handler
  peer.on('call', handleIncomingCall);
}

function startWithId(name, id) {
  peer = new Peer(id, {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    }
  });
  peer.on('open', newId => {
    $('my-peer-id').textContent = newId;
    showScreen('lobby');
    toast(`Welcome, ${name}! 🎉`);
  });
  peer.on('call', handleIncomingCall);
  peer.on('error', err => toast('Error: ' + err.message));
}

// ── Copy ID ──────────────────────────────────────────────────
$('btn-copy').addEventListener('click', () => {
  const id = $('my-peer-id').textContent;
  navigator.clipboard.writeText(id)
    .then(() => toast('📋 Call ID copied!'))
    .catch(() => {
      // Fallback for restricted environments
      const ta = document.createElement('textarea');
      ta.value = id;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('📋 Call ID copied!');
    });
});

// ── STEP 2: Make a call ──────────────────────────────────────
$('btn-call').addEventListener('click', makeCall);
$('input-callee-id').addEventListener('keydown', e => { if (e.key === 'Enter') makeCall(); });

async function makeCall() {
  const targetId = $('input-callee-id').value.trim();
  if (!targetId) { toast('Paste their Call ID first'); return; }
  if (targetId === $('my-peer-id').textContent) { toast("That's your own ID!"); return; }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    handleMicError(err);
    return;
  }

  const call = peer.call(targetId, localStream, {
    metadata: { name: myName }
  });

  if (!call) { toast('Could not reach that ID. Check it and try again.'); return; }

  currentCall = call;
  showActiveCallScreen('Calling…', targetId);
  $('call-status-badge').textContent = 'Calling…';

  call.on('stream', remoteStream => {
    $('remote-audio').srcObject = remoteStream;
    $('call-status-badge').textContent = 'Connected';
    startCallTimer();
    setupVolumeMonitor(remoteStream);
    toast('🔊 Connected!');
  });

  call.on('close', endCall);
  call.on('error', err => { toast('Call error: ' + err.message); endCall(); });
}

// ── STEP 3: Handle incoming call ─────────────────────────────
let pendingCall = null;

function handleIncomingCall(call) {
  if (currentCall) {
    // Already in a call — reject
    call.close();
    return;
  }
  pendingCall = call;
  const callerName = call.metadata?.name || call.peer;
  $('incoming-name').textContent = callerName;
  $('incoming-avatar').textContent = avatarLetter(callerName);
  showScreen('incoming');
  $('status-pill').textContent = '● Incoming call';
  $('status-pill').className = 'pill pill-busy';
}

$('btn-accept').addEventListener('click', async () => {
  if (!pendingCall) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    handleMicError(err);
    pendingCall.close();
    pendingCall = null;
    showScreen('lobby');
    return;
  }

  pendingCall.answer(localStream);
  currentCall = pendingCall;
  pendingCall = null;

  const callerName = currentCall.metadata?.name || currentCall.peer;
  showActiveCallScreen(callerName, currentCall.peer);

  currentCall.on('stream', remoteStream => {
    $('remote-audio').srcObject = remoteStream;
    $('call-status-badge').textContent = 'Connected';
    startCallTimer();
    setupVolumeMonitor(remoteStream);
  });

  currentCall.on('close', endCall);
  currentCall.on('error', err => { toast('Call error'); endCall(); });
});

$('btn-reject').addEventListener('click', () => {
  if (pendingCall) { pendingCall.close(); pendingCall = null; }
  showScreen('lobby');
  resetStatusPill();
  toast('Call declined');
});

// ── Active call UI ───────────────────────────────────────────
function showActiveCallScreen(name, peerId) {
  const displayName = name === peerId ? peerId : name;
  $('active-name').textContent = displayName;
  $('active-avatar').textContent = avatarLetter(displayName);
  $('call-status-badge').textContent = 'Connecting…';
  $('call-timer').textContent = '0:00';
  showScreen('call');
  $('status-pill').textContent = '● In a call';
  $('status-pill').className = 'pill pill-busy';
}

// ── Hang up ──────────────────────────────────────────────────
$('btn-hangup').addEventListener('click', () => {
  if (currentCall) currentCall.close();
  endCall();
});

function endCall() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
    analyser = null;
  }
  clearInterval(timerInterval);
  clearInterval(volInterval);
  timerInterval = null;
  volInterval = null;
  $('remote-audio').srcObject = null;
  currentCall = null;
  isMuted = false;
  updateMuteUI();
  resetVolBars();
  showScreen('lobby');
  resetStatusPill();
  toast('Call ended');
}

// ── Timer ────────────────────────────────────────────────────
function startCallTimer() {
  callStartTime = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    $('call-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

// ── Volume monitor ───────────────────────────────────────────
function setupVolumeMonitor(stream) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    const bars = ['v1','v2','v3','v4','v5'].map(id => $(id));

    clearInterval(volInterval);
    volInterval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.slice(0, 64).reduce((a, b) => a + b, 0) / 64;
      const level = Math.min(5, Math.floor(avg / 12));
      bars.forEach((bar, i) => {
        const h = 6 + i * 4;
        bar.style.height = (i < level ? h + 8 : h) + 'px';
        bar.classList.toggle('active', i < level);
      });
    }, 100);
  } catch (e) {
    // AudioContext not available — that's fine
  }
}

function resetVolBars() {
  ['v1','v2','v3','v4','v5'].forEach(id => {
    const b = $(id);
    b.style.height = '6px';
    b.classList.remove('active');
  });
}

// ── Mute ─────────────────────────────────────────────────────
$('btn-mute').addEventListener('click', () => {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  }
  updateMuteUI();
  toast(isMuted ? '🔇 Muted' : '🎤 Unmuted');
});

function updateMuteUI() {
  const btn = $('btn-mute');
  $('mute-icon-on').style.display  = isMuted ? 'none' : 'block';
  $('mute-icon-off').style.display = isMuted ? 'block' : 'none';
  btn.classList.toggle('active', isMuted);
  btn.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
}

// ── Speaker (forces audio output, mostly cosmetic on Chromebooks) ──
let speakerOn = true;
$('btn-speaker').addEventListener('click', () => {
  speakerOn = !speakerOn;
  const audio = $('remote-audio');
  audio.volume = speakerOn ? 1 : 0;
  $('btn-speaker').classList.toggle('active', !speakerOn);
  toast(speakerOn ? '🔊 Speaker on' : '🔈 Speaker off');
});

// ── Mic error helper ─────────────────────────────────────────
function handleMicError(err) {
  console.error('Mic error:', err);
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    toast('⚠️ Microphone access denied. Allow it in site settings.');
  } else if (err.name === 'NotFoundError') {
    toast('⚠️ No microphone found on this device.');
  } else {
    toast('⚠️ Could not access microphone: ' + err.message);
  }
}

// ── Status pill reset ─────────────────────────────────────────
function resetStatusPill() {
  $('status-pill').textContent = '● Online';
  $('status-pill').className = 'pill pill-online';
}

// ── Init ─────────────────────────────────────────────────────
showScreen('join');
$('input-name').focus();
