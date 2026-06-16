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
let isCameraOn    = false;
let cameraStream  = null;
let callStartTime = null;
let timerInterval = null;
let volInterval   = null;
let audioCtx      = null;
let analyser      = null;
let dataConnections = new Map();
let currentChatId = '';
let isConnecting  = false;
let groupCallParticipants = []; // Array of participant IDs for group calls

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

      // If we're already in the lobby (resolved = true), handle errors gracefully
      // without kicking the user back to the join screen
      if (resolved) {
        if (err.type === 'peer-unavailable') {
          // Called someone who is offline - stay in lobby, don't log out
          toast('That person is offline or unreachable.');
          // If we're on the call screen, go back to lobby
          if (screens.call.classList.contains('active') || screens.incoming.classList.contains('active')) {
            endCall();
          }
        } else if (err.type === 'network' || err.type === 'disconnected') {
          toast('Connection lost. Reconnecting...');
          // Try to reconnect silently
          setTimeout(() => {
            if (peer && peer.disconnected) {
              try { peer.reconnect(); } catch(e) { /* ignore */ }
            }
          }, 2000);
        }
        // All other post-login errors: just log, don't disrupt
        return;
      }

      if (err.type === 'unavailable-id') {
        // Generate a new ID if the saved one is taken (e.g. another tab open)
        toast('Creating a new Call ID...');
        savedAccount = { id: friendlyId(myName), name: myName, createdAt: Date.now() };
        saveJson(ACCOUNT_KEY, savedAccount);
        connectPeer(savedAccount.id).then(resolve).catch(reject);
        return;
      }

      resolved = true;
      isConnecting = false;
      // Show a friendly message instead of raw error
      if (err.type === 'network' || err.type === 'server-error') {
        toast('Could not connect to server. Check your internet and try again.');
      } else {
        toast('Connection error. Please try again.');
      }
      const btnStart = $('btn-start');
      if (btnStart) {
        btnStart.textContent = 'Create my Call ID →';
        btnStart.disabled = false;
      }
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

function removeFriend(id) {
  friends = friends.filter(f => f !== id);
  saveJson(FRIENDS_KEY, friends);
  // Also remove from directory
  directory = directory.filter(d => d.id !== id);
  saveJson(DIRECTORY_KEY, directory);
  // Close chat if viewing this friend
  if (currentChatId === id) {
    closeChat();
  }
  renderPeople();
  toast('Friend removed');
}

function renderPeople() {
  const list = $('people-list');
  if (!list) return;
  const people = directory.filter(person => person.id !== savedAccount?.id);
  list.innerHTML = people.length ? people.map(person => `
    <div class="person-card" data-id="${escapeHtml(person.id)}">
      <span class="mini-avatar">${escapeHtml(avatarLetter(person.name))}</span>
      <span class="person-main"><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.id)}</small></span>
      <button class="btn-unfriend" data-id="${escapeHtml(person.id)}" title="Remove friend">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
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
        // Already viewing this chat — message already rendered by addMessage
      } else {
        const senderName = data.account?.name || conn.peer;
        toast(`💬 ${senderName}: ${data.text.slice(0, 40)}${data.text.length > 40 ? '…' : ''}`);
        // Don't forcibly open chat — let user tap the toast or friend card
      }
    }
  });
  conn.on('close', () => dataConnections.delete(conn.peer));
}

function connectToPeer(peerId) {
  if (!peer) return null;
  if (dataConnections.has(peerId)) return dataConnections.get(peerId);

  const conn = peer.connect(peerId, {
    metadata: { account: savedAccount },
    reliable: true
  });

  // Handle connection errors silently - don't kick user out
  conn.on('error', err => {
    console.log('Connection to peer failed (they may be offline):', err);
    // Don't show error toast - just log it
  });

  conn.on('close', () => {
    dataConnections.delete(peerId);
  });

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
      // Check if clicking the remove button
      const removeBtn = e.target.closest('.btn-unfriend');
      if (removeBtn) {
        e.stopPropagation();
        const id = removeBtn.dataset.id;
        if (confirm('Remove this friend?')) {
          removeFriend(id);
        }
        return;
      }
      // Otherwise, click on the card to open chat
      const card = e.target.closest('.person-card');
      if (!card) return;
      const id = card.dataset.id;
      setActiveChat(id);
      // Try to connect silently in the background - don't show error if offline
      connectToPeer(id);
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

  // Add message to local history immediately
  addMessage(currentChatId, text, 'me');
  inputMessage.value = '';
  inputMessage.focus();

  // Try to send to peer
  let conn = dataConnections.get(currentChatId);
  if (!conn || !conn.open) {
    // Try to reconnect
    conn = connectToPeer(currentChatId);
  }

  if (!conn) {
    toast('Not connected to server.');
    return;
  }

  const payload = { type: 'message', text, account: savedAccount };

  if (conn.open) {
    conn.send(payload);
  } else {
    // Queue the message for when connection opens
    conn.once('open', () => {
      conn.send(payload);
    });
    toast('Friend may be offline — message saved.');
  }
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

// ── STEP 2: Make a call / Group Call ──────────────────────────────────────
function initCallButton() {
  // Group call: add friend to call list
  const container = $('call-friends-container');
  const btnAddMore = $('btn-add-more-friends');
  const btnGroupCall = $('btn-group-call');
  
  if (btnAddMore) {
    btnAddMore.addEventListener('click', () => {
      const newRow = document.createElement('div');
      newRow.className = 'input-row call-input-row';
      newRow.innerHTML = `
        <input type="text" class="callee-id-input" placeholder="Paste their Call ID" autocomplete="off" spellcheck="false" inputmode="text" />
        <button class="btn btn-secondary btn-icon add-friend-to-call">Add</button>
      `;
      container.appendChild(newRow);
      
      // Attach event listener to the new Add button
      const addBtn = newRow.querySelector('.add-friend-to-call');
      const input = newRow.querySelector('.callee-id-input');
      
      addBtn.addEventListener('click', () => addParticipant(input, newRow));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') addParticipant(input, newRow); });
    });
  }
  
  // Initialize the first input row
  const firstInput = container?.querySelector('.callee-id-input');
  const firstBtn = container?.querySelector('.add-friend-to-call');
  
  if (firstBtn && firstInput) {
    firstBtn.addEventListener('click', () => addParticipant(firstInput, null));
    firstInput.addEventListener('keydown', e => { if (e.key === 'Enter') addParticipant(firstInput, null); });
  }
  
  if (btnGroupCall) {
    btnGroupCall.addEventListener('click', startGroupCall);
  }
}

function addParticipant(input, rowToRemove) {
  const id = input?.value.trim() || '';
  if (!id) { toast('Enter a Call ID'); return; }
  if (id === $('my-peer-id')?.textContent) { toast("That's your own ID!"); return; }
  if (groupCallParticipants.includes(id)) { toast('Already added!'); return; }
  if (!peer) { toast('Not connected yet'); return; }
  
  groupCallParticipants.push(id);
  renderParticipantsList();
  
  if (input) input.value = '';
  if (rowToRemove) rowToRemove.remove();
  
  toast(`Added ${id} to group call`);
}

function renderParticipantsList() {
  const list = $('call-participants-list');
  if (!list) return;
  
  if (groupCallParticipants.length === 0) {
    list.innerHTML = '';
    return;
  }
  
  list.innerHTML = groupCallParticipants.map(id => `
    <div class="participant-chip" data-id="${escapeHtml(id)}">
      ${escapeHtml(id)}
      <button class="remove-participant" data-id="${escapeHtml(id)}" title="Remove">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  `).join('');
  
  // Add event listeners to remove buttons
  list.querySelectorAll('.remove-participant').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      groupCallParticipants = groupCallParticipants.filter(p => p !== id);
      renderParticipantsList();
    });
  });
}

async function startGroupCall() {
  if (groupCallParticipants.length === 0) {
    toast('Add at least one friend to call');
    return;
  }
  if (!peer) { toast('Not connected yet'); return; }
  
  // For group calls, we'll call each participant individually (mesh topology)
  // Request audio + video upfront
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (err) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (audioErr) {
      handleMicError(audioErr);
      return;
    }
  }
  
  localStream.getVideoTracks().forEach(t => { t.enabled = false; });
  isCameraOn = false;
  attachLocalVideo(localStream);
  
  // Call all participants
  const calls = [];
  for (const targetId of groupCallParticipants) {
    const call = peer.call(targetId, localStream, {
      metadata: { name: myName, account: savedAccount, groupCall: true }
    });
    
    if (call) {
      calls.push(call);
      call.on('stream', remoteStream => {
        attachRemoteStream(remoteStream);
        $('call-status-badge').textContent = `Connected to ${targetId}`;
        startCallTimer();
        setupVolumeMonitor(remoteStream);
      });
      call.on('close', () => {
        console.log(`Call with ${targetId} ended`);
      });
      call.on('error', err => {
        console.error(`Call error with ${targetId}:`, err);
        toast(`Could not reach ${targetId}`);
      });
    }
  }
  
  if (calls.length === 0) {
    toast('Could not reach any participants');
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    return;
  }
  
  // Store the first call as currentCall for UI purposes
  currentCall = calls[0];
  showActiveCallScreen('Calling...', `${groupCallParticipants.length} participants`);
  updateCameraUI();
  
  toast(`Calling ${groupCallParticipants.join(', ')}...`);
}

async function makeCall() {
  const inputCalleeId = $('input-callee-id');
  const targetId = inputCalleeId?.value.trim() || '';
  if (!targetId) { toast('Enter their Call ID first'); return; }
  if (targetId === $('my-peer-id')?.textContent) { toast("That's your own ID!"); return; }
  if (!peer) { toast('Not connected yet'); return; }

  // Request audio + video upfront so the WebRTC channel is negotiated for both.
  // Camera starts MUTED (track.enabled = false) — user taps Camera to turn it on.
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (err) {
    // Camera denied — try audio only (video button will be hidden)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (audioErr) {
      handleMicError(audioErr);
      return;
    }
  }

  // Disable video track by default — camera is "off" until user taps the button
  localStream.getVideoTracks().forEach(t => { t.enabled = false; });
  isCameraOn = false;

  // Show local preview (black until enabled, but element is ready)
  attachLocalVideo(localStream);

  const call = peer.call(targetId, localStream, {
    metadata: { name: myName, account: savedAccount }
  });

  if (!call) { toast('Could not reach that ID'); return; }

  currentCall = call;
  showActiveCallScreen('Calling...', targetId);
  $('call-status-badge').textContent = 'Calling...';
  updateCameraUI();

  call.on('stream', remoteStream => {
    attachRemoteStream(remoteStream);
    $('call-status-badge').textContent = 'Connected';
    if ($('call-status-badge-video')) $('call-status-badge-video').textContent = 'Connected';
    startCallTimer();
    setupVolumeMonitor(remoteStream);
    toast('Connected! Tap Camera to share video.');
  });

  call.on('close', () => { endCall(); });
  call.on('error', err => {
    console.error('Call error:', err);
    toast('Could not reach that person. They may be offline.');
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    currentCall = null;
    showScreen('lobby');
    resetStatusPill();
  });
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

      // Same as makeCall: get audio+video upfront, start with camera disabled
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      } catch (err) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (audioErr) {
          handleMicError(audioErr);
          pendingCall.close();
          pendingCall = null;
          showScreen('lobby');
          return;
        }
      }

      // Camera off by default
      localStream.getVideoTracks().forEach(t => { t.enabled = false; });
      isCameraOn = false;

      attachLocalVideo(localStream);

      pendingCall.answer(localStream);
      currentCall = pendingCall;
      pendingCall = null;

      if (currentCall.metadata?.account) rememberAccount(currentCall.metadata.account);
      const callerName = currentCall.metadata?.name || currentCall.peer;
      showActiveCallScreen(callerName, currentCall.peer);
      updateCameraUI();

      currentCall.on('stream', remoteStream => {
        attachRemoteStream(remoteStream);
        $('call-status-badge').textContent = 'Connected';
        if ($('call-status-badge-video')) $('call-status-badge-video').textContent = 'Connected';
        startCallTimer();
        setupVolumeMonitor(remoteStream);
        toast('Connected! Tap Camera to share video.');
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
  if ($('remote-video-avatar')) $('remote-video-avatar').textContent = avatarLetter(displayName);
  $('call-status-badge').textContent = 'Connecting...';
  if ($('call-status-badge-video')) $('call-status-badge-video').textContent = 'Connecting...';
  $('call-timer').textContent = '0:00';
  // Start with no-video layout
  $('video-area').style.display = 'none';
  $('no-video-display').style.display = 'flex';
  if ($('call-status-badge-video')) $('call-status-badge-video').style.display = 'none';
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
  // Close all calls (for group calls)
  if (Array.isArray(currentCall)) {
    currentCall.forEach(call => {
      if (call && typeof call.close === 'function') call.close();
    });
  } else if (currentCall) {
    currentCall.close();
  }
  
  // Clear participant list
  groupCallParticipants = [];
  renderParticipantsList();
  
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
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
  // Clear video elements
  const remoteVideo = $('remote-video');
  const localVideo = $('local-video');
  const remoteAudio = $('remote-audio');
  if (remoteVideo) remoteVideo.srcObject = null;
  if (localVideo) localVideo.srcObject = null;
  if (remoteAudio) remoteAudio.srcObject = null;
  // Reset video UI
  if ($('video-area')) $('video-area').style.display = 'none';
  if ($('no-video-display')) $('no-video-display').style.display = 'flex';
  currentCall = null;
  isMuted = false;
  isCameraOn = false;
  updateMuteUI();
  updateCameraUI();
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

// ── Video helpers ────────────────────────────────────────────
function attachLocalVideo(stream) {
  const localVideo = $('local-video');
  if (localVideo) localVideo.srcObject = stream;
}

function attachRemoteStream(stream) {
  // Always wire audio
  $('remote-audio').srcObject = stream;

  const remoteVideo = $('remote-video');
  if (!remoteVideo) return;

  // Wire up the video element regardless — track may start disabled
  remoteVideo.srcObject = stream;

  // Show/hide video area based on whether any video track is enabled
  function checkRemoteVideo() {
    const hasActiveVideo = stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
    const placeholder = $('remote-video-placeholder');
    if (hasActiveVideo) {
      remoteVideo.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
      showVideoArea();
    } else {
      remoteVideo.style.display = 'none';
      if (placeholder) placeholder.style.display = 'flex';
      // Only show video area if our own camera is on
      if (!isCameraOn) hideVideoArea();
    }
  }

  checkRemoteVideo();

  // Watch for remote track state changes (them turning camera on/off)
  stream.getVideoTracks().forEach(track => {
    track.addEventListener('unmute', checkRemoteVideo);
    track.addEventListener('mute', checkRemoteVideo);
    track.addEventListener('ended', checkRemoteVideo);
  });

  // Also poll briefly in case events fire before stream settles
  setTimeout(checkRemoteVideo, 500);
  setTimeout(checkRemoteVideo, 1500);
}

function showVideoArea() {
  $('video-area').style.display = 'block';
  $('no-video-display').style.display = 'none';
  const badge = $('call-status-badge-video');
  if (badge) {
    badge.textContent = $('call-status-badge').textContent;
    badge.style.display = 'inline-block';
  }
}

function hideVideoArea() {
  $('video-area').style.display = 'none';
  $('no-video-display').style.display = 'flex';
  const badge = $('call-status-badge-video');
  if (badge) badge.style.display = 'none';
}

// ── Camera toggle ────────────────────────────────────────────
function initCameraButton() {
  const btnCamera = $('btn-camera');
  if (!btnCamera) return;
  btnCamera.addEventListener('click', toggleCamera);
}

function toggleCamera() {
  if (!currentCall || !localStream) return;

  const videoTracks = localStream.getVideoTracks();
  if (videoTracks.length === 0) {
    toast('No camera available on this device.');
    return;
  }

  isCameraOn = !isCameraOn;
  videoTracks.forEach(t => { t.enabled = isCameraOn; });

  if (isCameraOn) {
    // Show local preview and video area
    attachLocalVideo(localStream);
    showVideoArea();
    toast('Camera on');
  } else {
    // Hide video area, go back to avatar
    hideVideoArea();
    toast('Camera off');
  }

  updateCameraUI();
}

function updateCameraUI() {
  const btn = $('btn-camera');
  const iconOn = $('cam-icon-on');
  const iconOff = $('cam-icon-off');
  if (!btn) return;

  // Hide camera button entirely if device has no camera
  const hasCameraTrack = localStream && localStream.getVideoTracks().length > 0;
  btn.style.display = hasCameraTrack ? '' : 'none';

  if (iconOn) iconOn.style.display = isCameraOn ? 'block' : 'none';
  if (iconOff) iconOff.style.display = isCameraOn ? 'none' : 'block';
  btn.classList.toggle('active', isCameraOn);
  const span = btn.querySelector('span');
  if (span) span.textContent = isCameraOn ? 'Cam On' : 'Camera';
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
initCameraButton();
initSpeakerButton();
renderPeople();
