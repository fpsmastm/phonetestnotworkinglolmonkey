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
  messages: $('screen-messages'),
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
let dataConnections = new Map();
let currentChatId = '';

const ACCOUNT_KEY = 'linkup.account.v2';
const DIRECTORY_KEY = 'linkup.directory.v2';
const FRIENDS_KEY = 'linkup.friends.v2';
const MESSAGES_KEY = 'linkup.messages.v2';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const loadJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
const saveJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

let savedAccount = loadJson(ACCOUNT_KEY, null);
let directory = loadJson(DIRECTORY_KEY, []);
let friends = loadJson(FRIENDS_KEY, []);
let messages = loadJson(MESSAGES_KEY, {});
const PEER_ID_RETRY_LIMIT = 8;
const PEER_ID_RETRY_DELAY = 1200;

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
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'user';
  const rand = Math.random().toString(36).slice(2, 8);
  return `${clean}-${rand}`;
}

function getOrCreateAccount(name) {
  if (savedAccount?.id) {
    savedAccount.name = name || savedAccount.name;
  } else {
    savedAccount = { id: friendlyId(name), name, createdAt: Date.now() };
  }
  saveJson(ACCOUNT_KEY, savedAccount);
  rememberAccount(savedAccount);
  return savedAccount;
}

// ── STEP 1: Join / Create ID ─────────────────────────────────
$('btn-start').addEventListener('click', startSession);
$('input-name').addEventListener('keydown', e => { if (e.key === 'Enter') startSession(); });

function startSession() {
  const name = $('input-name').value.trim();
  if (!name) { toast('Enter your name first!'); $('input-name').focus(); return; }
  const account = getOrCreateAccount(name);
  myName = account.name;

  const peerId = account.id;

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
    toast(`Welcome back, ${myName}! 🎉`);
  });

  peer.on('error', err => {
    console.error('PeerJS error:', err);
    // If the saved ID is briefly busy, keep retrying it instead of changing accounts
    if (err.type === 'unavailable-id') {
      retrySavedPeerId(myName, peerId, 1);
      return;
    }
    toast('Connection error: ' + err.message);
    $('btn-start').textContent = 'Create my Call ID →';
    $('btn-start').disabled = false;
    showScreen('join');
  });

  // Incoming call and message handlers
  peer.on('call', handleIncomingCall);
  peer.on('connection', setupDataConnection);
}

function createPeer(id) {
  return new Peer(id, {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    }
  });
}

function retrySavedPeerId(name, id, attempt) {
  peer?.destroy();
  if (attempt > PEER_ID_RETRY_LIMIT) {
    toast('That saved Call ID is still active in another tab. Close the other tab, then try again.', 6000);
    $('btn-start').textContent = 'Reconnect saved account →';
    $('btn-start').disabled = false;
    showScreen('join');
    return;
  }

  toast(`Reconnecting saved Call ID… (${attempt}/${PEER_ID_RETRY_LIMIT})`, 1600);
  setTimeout(() => startWithId(name, id, attempt), PEER_ID_RETRY_DELAY);
}

function startWithId(name, id, attempt = 0) {
  peer = createPeer(id);
  peer.on('open', newId => {
    $('my-peer-id').textContent = newId;
    showScreen('lobby');
    $('btn-start').textContent = 'Reconnect saved account →';
    $('btn-start').disabled = false;
    toast(`Welcome back, ${name}! 🎉`);
  });
  peer.on('call', handleIncomingCall);
  peer.on('connection', setupDataConnection);
  peer.on('error', err => toast('Error: ' + err.message));
}
renderPeople();


// ── Saved account, directory, friends and messaging ───────────
function rememberAccount(account) {
  if (!account?.id) return;
  const existing = directory.find(item => item.id === account.id);
  const next = { id: account.id, name: account.name || account.id, lastSeen: Date.now() };
  if (existing) Object.assign(existing, next);
  else directory.unshift(next);
  directory.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  saveJson(DIRECTORY_KEY, directory);
  renderPeople();
}

function isFriend(id) { return friends.includes(id); }
function addFriend(account) {
  rememberAccount(account);
  if (!isFriend(account.id)) {
    friends.push(account.id);
    saveJson(FRIENDS_KEY, friends);
  }
  renderPeople();
}

function renderPeople() {
  const list = $('people-list');
  if (!list) return;
  const people = directory.filter(person => person.id !== savedAccount?.id);
  list.innerHTML = people.length ? people.map(person => `
    <button class="person-card" data-id="${escapeHtml(person.id)}" type="button">
      <span class="mini-avatar">${escapeHtml(avatarLetter(person.name))}</span>
      <span class="person-main"><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.id)}</small></span>
      <span class="friend-chip">${isFriend(person.id) ? 'Friend' : 'Add'}</span>
    </button>
  `).join('') : '<p class="empty-state">No accounts discovered yet. Add someone by their ID to see them here.</p>';
}

function renderMessages(peerId) {
  const thread = $('message-thread');
  if (!thread) return;
  const history = messages[peerId] || [];
  thread.innerHTML = history.length ? history.map(msg => `
    <div class="message ${msg.from === 'me' ? 'me' : 'them'}">
      <span>${escapeHtml(msg.text)}</span>
    </div>
  `).join('') : '<p class="empty-state">No messages yet. Say hi!</p>';
  thread.scrollTop = thread.scrollHeight;
}

function setActiveChat(peerId) {
  currentChatId = peerId;
  const person = directory.find(item => item.id === peerId) || { id: peerId, name: peerId };
  $('chat-title').textContent = person.name;
  $('chat-subtitle').textContent = person.id;
  $('input-message').disabled = false;
  $('btn-send').disabled = false;
  renderMessages(peerId);
}

function addMessage(peerId, text, from) {
  messages[peerId] = messages[peerId] || [];
  messages[peerId].push({ text, from, at: Date.now() });
  saveJson(MESSAGES_KEY, messages);
  if (currentChatId === peerId) renderMessages(peerId);
}

function setupDataConnection(conn) {
  dataConnections.set(conn.peer, conn);
  conn.on('open', () => {
    conn.send({ type: 'profile', account: savedAccount });
  });
  conn.on('data', data => {
    if (data?.account) rememberAccount(data.account);
    if (data?.type === 'profile') rememberAccount(data.account);
    if (data?.type === 'message') {
      rememberAccount(data.account);
      addMessage(conn.peer, data.text, 'them');
      toast(`New message from ${data.account?.name || conn.peer}`);
    }
  });
  conn.on('close', () => dataConnections.delete(conn.peer));
}

function connectToPeer(peerId) {
  if (!peer || dataConnections.has(peerId)) return dataConnections.get(peerId);
  const conn = peer.connect(peerId, { metadata: { account: savedAccount } });
  setupDataConnection(conn);
  return conn;
}

$('btn-add-friend').addEventListener('click', () => {
  const id = $('input-friend-id').value.trim();
  if (!id) { toast('Enter their account ID first'); return; }
  if (id === savedAccount?.id) { toast("That's your account"); return; }
  addFriend({ id, name: id });
  connectToPeer(id);
  setActiveChat(id);
  $('input-friend-id').value = '';
  toast('Friend added');
});

$('people-list').addEventListener('click', e => {
  const card = e.target.closest('.person-card');
  if (!card) return;
  const id = card.dataset.id;
  const person = directory.find(item => item.id === id) || { id, name: id };
  addFriend(person);
  connectToPeer(id);
  setActiveChat(id);
});

$('btn-send').addEventListener('click', sendMessage);
$('input-message').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
  const text = $('input-message').value.trim();
  if (!currentChatId || !text) return;
  const conn = connectToPeer(currentChatId);
  const payload = { type: 'message', text, account: savedAccount };
  if (conn?.open) conn.send(payload);
  else conn?.once?.('open', () => conn.send(payload));
  addMessage(currentChatId, text, 'me');
  $('input-message').value = '';
}

if (savedAccount?.name) {
  $('input-name').value = savedAccount.name;
  $('btn-start').textContent = 'Continue as ' + savedAccount.name + ' →';
}
renderPeople();

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
    metadata: { name: myName, account: savedAccount }
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
  if (call.metadata?.account) rememberAccount(call.metadata.account);
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

  if (currentCall.metadata?.account) rememberAccount(currentCall.metadata.account);
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
