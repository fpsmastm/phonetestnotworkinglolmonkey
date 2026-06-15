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
let dataConnections = new Map();
let currentChatId = '';
let isConnecting  = false;

const ACCOUNT_KEY = 'linkup.account.v3';
const DIRECTORY_KEY = 'linkup.directory.v3';
const FRIENDS_KEY = 'linkup.friends.v3';
const MESSAGES_KEY = 'linkup.messages.v3';

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

// ── Screen helper ────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s && s.classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
}

// ── Toast ────────────────────────────────────────────────────
let toastTimeout;
function toast(msg, duration = 3000) {
  const el = $('toast');
  if (!el) return;
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
function initJoinScreen() {
  const btnStart = $('btn-start');
  const inputName = $('input-name');

  if (!btnStart || !inputName) return;

  btnStart.addEventListener('click', startSession);
  inputName.addEventListener('keydown', e => { if (e.key === 'Enter') startSession(); });

  if (savedAccount?.name) {
    inputName.value = savedAccount.name;
    btnStart.textContent = 'Continue as ' + savedAccount.name + ' →';
  }
}

async function startSession() {
  if (isConnecting) return;

  const inputName = $('input-name');
  const btnStart = $('btn-start');

  const name = inputName?.value.trim() || '';
  if (!name) { toast('Enter your name first!'); inputName?.focus(); return; }

  const account = getOrCreateAccount(name);
  myName = account.name;
  const peerId = account.id;

  isConnecting = true;
  btnStart.textContent = 'Connecting...';
  btnStart.disabled = true;

  await connectPeer(peerId);
}

async function connectPeer(peerId) {
  return new Promise((resolve, reject) => {
    // Destroy existing peer if any
    if (peer) {
      peer.destroy();
      peer = null;
    }

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

    let resolved = false;

    peer.on('open', id => {
      if (!resolved) {
        resolved = true;
        $('my-peer-id').textContent = id;
        showScreen('lobby');
        toast(`Welcome, ${myName}!`);
        isConnecting = false;
        $('btn-start').textContent = 'Continue as ' + myName + ' →';
        $('btn-start').disabled = false;
        resolve();
      }
    });

    peer.on('error', err => {
      console.error('PeerJS error:', err);
      if (resolved) return;

      if (err.type === 'unavailable-id') {
        // Generate a new ID if the saved one is taken
        toast('Your ID was busy, creating a new one...');
        savedAccount = { id: friendlyId(myName), name: myName, createdAt: Date.now() };
        saveJson(ACCOUNT_KEY, savedAccount);
        connectPeer(savedAccount.id);
        return;
      }

      resolved = true;
      isConnecting = false;
      toast('Connection error: ' + err.message);
      $('btn-start').textContent = 'Create my Call ID →';
      $('btn-start').disabled = false;
      reject(err);
    });

    peer.on('call', handleIncomingCall);
    peer.on('connection', setupDataConnection);
  });
}

// ── Directory, friends and messaging ───────────────────────────
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
    </button>
  `).join('') : '<p class="empty-state">No friends yet. Add someone by their Call ID above.</p>';
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
  $('active-chat-card').style.display = 'block';
  renderMessages(peerId);
  $('input-message')?.focus();
}

function closeChat() {
  currentChatId = '';
  $('active-chat-card').style.display = 'none';
  $('chat-title').textContent = 'Select a friend';
  $('chat-subtitle').textContent = 'Click a friend to start messaging';
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
      if (currentChatId === conn.peer) {
        // Already viewing this chat
      } else {
        toast(`Message from ${data.account?.name || conn.peer}`);
        setActiveChat(conn.peer);
      }
    }
  });
  conn.on('close', () => dataConnections.delete(conn.peer));
}

function connectToPeer(peerId) {
  if (!peer) return null;
  if (dataConnections.has(peerId)) return dataConnections.get(peerId);
  const conn = peer.connect(peerId, { metadata: { account: savedAccount } });
  setupDataConnection(conn);
  return conn;
}

function initMessaging() {
  const btnAddFriend = $('btn-add-friend');
  const inputFriendId = $('input-friend-id');
  const peopleList = $('people-list');
  const btnCloseChat = $('btn-close-chat');
  const btnSend = $('btn-send');
  const inputMessage = $('input-message');

  if (btnAddFriend && inputFriendId) {
    btnAddFriend.addEventListener('click', () => {
      const id = inputFriendId.value.trim();
      if (!id) { toast('Enter their Call ID'); return; }
      if (id === savedAccount?.id) { toast("That's your own ID"); return; }
      addFriend({ id, name: id });
      connectToPeer(id);
      setActiveChat(id);
      inputFriendId.value = '';
    });
  }

  if (peopleList) {
    peopleList.addEventListener('click', e => {
      const card = e.target.closest('.person-card');
      if (!card) return;
      const id = card.dataset.id;
      addFriend({ id, name: id });
      connectToPeer(id);
      setActiveChat(id);
    });
  }

  if (btnCloseChat) {
    btnCloseChat.addEventListener('click', closeChat);
  }

  if (btnSend && inputMessage) {
    btnSend.addEventListener('click', sendMessage);
    inputMessage.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
  }
}

function sendMessage() {
  const inputMessage = $('input-message');
  const text = inputMessage?.value.trim() || '';
  if (!currentChatId || !text) return;
  const conn = connectToPeer(currentChatId);
  const payload = { type: 'message', text, account: savedAccount };
  if (conn?.open) conn.send(payload);
  else conn?.once?.('open', () => conn.send(payload));
  addMessage(currentChatId, text, 'me');
  inputMessage.value = '';
}

// ── Copy ID ──────────────────────────────────────────────────
function initCopyId() {
  const btnCopy = $('btn-copy');
  if (!btnCopy) return;
  btnCopy.addEventListener('click', () => {
    const id = $('my-peer-id')?.textContent || '';
    navigator.clipboard.writeText(id)
      .then(() => toast('Call ID copied!'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = id;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('Call ID copied!');
      });
  });
}

// ── STEP 2: Make a call ──────────────────────────────────────
function initCallButton() {
  const btnCall = $('btn-call');
  const inputCalleeId = $('input-callee-id');

  if (!btnCall || !inputCalleeId) return;

  btnCall.addEventListener('click', makeCall);
  inputCalleeId.addEventListener('keydown', e => { if (e.key === 'Enter') makeCall(); });
}

async function makeCall() {
  const inputCalleeId = $('input-callee-id');
  const targetId = inputCalleeId?.value.trim() || '';
  if (!targetId) { toast('Enter their Call ID first'); return; }
  if (targetId === $('my-peer-id')?.textContent) { toast("That's your own ID!"); return; }
  if (!peer) { toast('Not connected yet'); return; }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    handleMicError(err);
    return;
  }

  const call = peer.call(targetId, localStream, {
    metadata: { name: myName, account: savedAccount }
  });

  if (!call) { toast('Could not reach that ID'); return; }

  currentCall = call;
  showActiveCallScreen('Calling...', targetId);
  $('call-status-badge').textContent = 'Calling...';

  call.on('stream', remoteStream => {
    $('remote-audio').srcObject = remoteStream;
    $('call-status-badge').textContent = 'Connected';
    startCallTimer();
    setupVolumeMonitor(remoteStream);
    toast('Connected!');
  });

  call.on('close', endCall);
  call.on('error', err => { toast('Call error: ' + err.message); endCall(); });
}

// ── STEP 3: Handle incoming call ─────────────────────────────
let pendingCall = null;

function handleIncomingCall(call) {
  if (currentCall) {
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

function initIncomingCallButtons() {
  const btnAccept = $('btn-accept');
  const btnReject = $('btn-reject');

  if (btnAccept) {
    btnAccept.addEventListener('click', async () => {
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
  }

  if (btnReject) {
    btnReject.addEventListener('click', () => {
      if (pendingCall) { pendingCall.close(); pendingCall = null; }
      showScreen('lobby');
      resetStatusPill();
      toast('Call declined');
    });
  }
}

// ── Active call UI ───────────────────────────────────────────
function showActiveCallScreen(name, peerId) {
  const displayName = name === peerId ? peerId : name;
  $('active-name').textContent = displayName;
  $('active-avatar').textContent = avatarLetter(displayName);
  $('call-status-badge').textContent = 'Connecting...';
  $('call-timer').textContent = '0:00';
  showScreen('call');
  $('status-pill').textContent = '● In a call';
  $('status-pill').className = 'pill pill-busy';
}

// ── Hang up ──────────────────────────────────────────────────
function initHangupButton() {
  const btnHangup = $('btn-hangup');
  if (btnHangup) {
    btnHangup.addEventListener('click', () => {
      if (currentCall) currentCall.close();
      endCall();
    });
  }
}

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
        if (!bar) return;
        const h = 6 + i * 4;
        bar.style.height = (i < level ? h + 8 : h) + 'px';
        bar.classList.toggle('active', i < level);
      });
    }, 100);
  } catch (e) {
    // AudioContext not available
  }
}

function resetVolBars() {
  ['v1','v2','v3','v4','v5'].forEach(id => {
    const b = $(id);
    if (b) {
      b.style.height = '6px';
      b.classList.remove('active');
    }
  });
}

// ── Mute ─────────────────────────────────────────────────────
function initMuteButton() {
  const btnMute = $('btn-mute');
  if (!btnMute) return;
  btnMute.addEventListener('click', () => {
    isMuted = !isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
    }
    updateMuteUI();
    toast(isMuted ? 'Muted' : 'Unmuted');
  });
}

function updateMuteUI() {
  const btn = $('btn-mute');
  const iconOn = $('mute-icon-on');
  const iconOff = $('mute-icon-off');
  if (!btn) return;
  if (iconOn) iconOn.style.display = isMuted ? 'none' : 'block';
  if (iconOff) iconOff.style.display = isMuted ? 'block' : 'none';
  btn.classList.toggle('active', isMuted);
  const span = btn.querySelector('span');
  if (span) span.textContent = isMuted ? 'Unmute' : 'Mute';
}

// ── Speaker ─────────────────────────────────────────────────────
let speakerOn = true;
function initSpeakerButton() {
  const btnSpeaker = $('btn-speaker');
  if (!btnSpeaker) return;
  btnSpeaker.addEventListener('click', () => {
    speakerOn = !speakerOn;
    const audio = $('remote-audio');
    if (audio) audio.volume = speakerOn ? 1 : 0;
    btnSpeaker.classList.toggle('active', !speakerOn);
    toast(speakerOn ? 'Speaker on' : 'Speaker off');
  });
}

// ── Mic error helper ─────────────────────────────────────────
function handleMicError(err) {
  console.error('Mic error:', err);
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    toast('Microphone access denied. Allow it in site settings.');
  } else if (err.name === 'NotFoundError') {
    toast('No microphone found on this device.');
  } else {
    toast('Could not access microphone: ' + err.message);
  }
}

// ── Status pill reset ─────────────────────────────────────────
function resetStatusPill() {
  const pill = $('status-pill');
  if (pill) {
    pill.textContent = '● Online';
    pill.className = 'pill pill-online';
  }
}

// ── Initialize ─────────────────────────────────────────────
showScreen('join');
initJoinScreen();
initMessaging();
initCopyId();
initCallButton();
initIncomingCallButtons();
initHangupButton();
initMuteButton();
initSpeakerButton();
renderPeople();
