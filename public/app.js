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
let screenStream  = null;
let isScreenOn    = false;
let callStartTime = null;
let timerInterval = null;
let volInterval   = null;
let audioCtx      = null;
let analyser      = null;
let dataConnections = new Map();
let currentChatId = '';
let isConnecting  = false;
let groupCallParticipants = []; // Array of participant IDs for group calls
let ringtoneOscillator = null;
let ringtoneGain = null;
let soundboardAudioContext = null;
let soundboardVolume = 0.7;
let customSounds = [];
let isAdminMode = false;
let adminKeyBuffer = '';
const ADMIN_KEY = 'admin';

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

// ── Notifications ────────────────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    console.log('Notifications not supported');
    return false;
  }
  
  if (Notification.permission === 'granted') {
    return true;
  }
  
  if (Notification.permission !== 'denied') {
    try {
      const permission = await Notification.requestPermission();
      return permission === 'granted';
    } catch (err) {
      console.error('Notification permission error:', err);
      return false;
    }
  }
  
  return false;
}

function showNotification(title, body, onClick) {
  if (!('Notification' in window)) return;
  
  // Request permission if needed
  if (Notification.permission !== 'granted') {
    requestNotificationPermission().then(granted => {
      if (granted) {
        createNotification(title, body, onClick);
      }
    });
    return;
  }
  
  createNotification(title, body, onClick);
}

function createNotification(title, body, onClick) {
  try {
    const notification = new Notification(title, {
      body: body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📞</text></svg>',
      badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📞</text></svg>',
      requireInteraction: true,
      tag: 'linkup-notification',
      renotify: true
    });
    
    if (onClick) {
      notification.onclick = (e) => {
        e.preventDefault();
        window.focus();
        onClick();
        notification.close();
      };
    }
    
    // Auto-close after 10 seconds
    setTimeout(() => notification.close(), 10000);
  } catch (err) {
    console.error('Failed to create notification:', err);
  }
}

function playRingtone() {
  stopRingtone();
  
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    ringtoneGain = audioCtx.createGain();
    ringtoneGain.connect(audioCtx.destination);
    ringtoneGain.gain.value = 0.3;
    
    ringtoneOscillator = audioCtx.createOscillator();
    ringtoneOscillator.type = 'sine';
    ringtoneOscillator.frequency.setValueAtTime(440, audioCtx.currentTime);
    ringtoneOscillator.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.5);
    
    ringtoneOscillator.connect(ringtoneGain);
    ringtoneOscillator.start();
    
    // Create a pulsing pattern
    const pulseInterval = setInterval(() => {
      if (ringtoneGain && audioCtx) {
        const time = audioCtx.currentTime;
        ringtoneGain.gain.cancelScheduledValues(time);
        ringtoneGain.gain.setValueAtTime(0.3, time);
        ringtoneGain.gain.exponentialRampToValueAtTime(0.01, time + 0.3);
        ringtoneGain.gain.exponentialRampToValueAtTime(0.3, time + 0.6);
      } else {
        clearInterval(pulseInterval);
      }
    }, 600);
    
    // Store interval for cleanup
    ringtoneOscillator.pulseInterval = pulseInterval;
  } catch (err) {
    console.error('Failed to play ringtone:', err);
  }
}

function stopRingtone() {
  if (ringtoneOscillator) {
    if (ringtoneOscillator.pulseInterval) {
      clearInterval(ringtoneOscillator.pulseInterval);
    }
    try {
      ringtoneOscillator.stop();
      ringtoneOscillator.disconnect();
    } catch (e) { /* ignore */ }
    ringtoneOscillator = null;
  }
  
  if (ringtoneGain) {
    try {
      ringtoneGain.disconnect();
    } catch (e) { /* ignore */ }
    ringtoneGain = null;
  }
  
  if (audioCtx && !localStream && !currentCall) {
    try {
      audioCtx.close();
      audioCtx = null;
    } catch (e) { /* ignore */ }
  }
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
  if (savedAccount?.id && savedAccount?.name) {
    // Account already exists - use the SAVED name and ID, ignore new name input
    myName = savedAccount.name;
    return savedAccount;
  } else {
    // First time - create new account
    savedAccount = { id: friendlyId(name), name, createdAt: Date.now() };
    myName = name;
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

  // Check if we have a saved account - if so, ALWAYS use it regardless of name input
  if (savedAccount?.id && savedAccount?.name) {
    // User already has an account - use the saved one
    myName = savedAccount.name;
    const peerId = savedAccount.id;
    
    isConnecting = true;
    btnStart.textContent = 'Connecting...';
    btnStart.disabled = true;
    
    await connectPeer(peerId);
    return;
  }
  
  // First time user - create new account
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

// Clear saved account function (for testing/debugging)
window.clearSavedAccount = function() {
  localStorage.removeItem(ACCOUNT_KEY);
  savedAccount = null;
  location.reload();
};

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
        // ID is taken - this should NOT happen for existing accounts
        // Keep the saved account and retry connection after a delay
        toast('Call ID in use, retrying...');
        setTimeout(() => {
          connectPeer(savedAccount.id).then(resolve).catch(reject);
        }, 1000);
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
  list.innerHTML = people.length ? people.map(person => {
    const isConnected = dataConnections.has(person.id) && dataConnections.get(person.id).open;
    const statusDot = isConnected ? '<span class="status-dot online" title="Online"></span>' : '<span class="status-dot offline" title="Offline"></span>';
    return `
    <div class="person-card" data-id="${escapeHtml(person.id)}">
      <div class="person-avatar-wrapper">
        <span class="mini-avatar">${escapeHtml(avatarLetter(person.name))}</span>
        ${statusDot}
      </div>
      <div class="person-main">
        <strong>${escapeHtml(person.name)}</strong>
        <small>${escapeHtml(person.id)}</small>
      </div>
      <div class="person-actions">
        <button class="person-action-btn btn-call-friend" data-id="${escapeHtml(person.id)}" title="Call">
          <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
        </button>
        <button class="person-action-btn btn-message-friend" data-id="${escapeHtml(person.id)}" title="Message">
          <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
        </button>
        <button class="btn-unfriend" data-id="${escapeHtml(person.id)}" title="Remove friend">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
  `}).join('') : '<p class="empty-state">No friends yet. Add someone by their Call ID above.</p>';
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

function showMessageNotification(senderName, text, peerId) {
  showNotification(
    `💬 ${senderName}`,
    text.slice(0, 100) + (text.length > 100 ? '…' : ''),
    () => {
      window.focus();
      setActiveChat(peerId);
    }
  );
}

function setupDataConnection(conn) {
  dataConnections.set(conn.peer, conn);
  console.log('Data connection established with:', conn.peer);
  // Re-render people list to update online status
  renderPeople();
  
  conn.on('open', () => {
    console.log('Data connection opened with:', conn.peer);
    conn.send({ type: 'profile', account: savedAccount });
  });
  conn.on('data', data => {
    console.log('Received data from', conn.peer, ':', data?.type);
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
        // Show notification for new message when tab is in background
        showMessageNotification(senderName, data.text, conn.peer);
        // Don't forcibly open chat — let user tap the toast or friend card
      }
    }
    // Handle sound events from soundboard
    if (data?.type === 'sound') {
      console.log('Sound event received from', conn.peer);
      handleIncomingSound(data);
    }
    // Handle admin messages
    if (data?.type === 'admin_message') {
      handleIncomingAdminMessage(data);
    }
    // Handle admin commands
    if (data?.type === 'admin_command') {
      handleIncomingAdminCommand(data);
    }
  });
  conn.on('close', () => {
    console.log('Data connection closed with:', conn.peer);
    dataConnections.delete(conn.peer);
    // Re-render people list to update online status
    renderPeople();
  });
  conn.on('error', err => {
    console.error('Data connection error with', conn.peer, ':', err);
    // Don't remove from map on transient errors, only on close
  });
}

function connectToPeer(peerId) {
  if (!peer) return null;
  if (dataConnections.has(peerId)) {
    console.log('Already connected to peer:', peerId);
    return dataConnections.get(peerId);
  }

  console.log('Connecting to peer:', peerId);
  const conn = peer.connect(peerId, {
    metadata: { account: savedAccount },
    reliable: true
  });

  // Handle connection errors silently - don't kick user out
  conn.on('error', err => {
    console.error('Connection to peer failed (they may be offline):', peerId, err);
    // Don't show error toast - just log it
  });

  conn.on('close', () => {
    console.log('Connection to peer closed:', peerId);
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
      // Check if clicking the call button
      const callBtn = e.target.closest('.btn-call-friend');
      if (callBtn) {
        e.stopPropagation();
        const id = callBtn.dataset.id;
        startCall(id);
        return;
      }
      // Check if clicking the message button
      const msgBtn = e.target.closest('.btn-message-friend');
      if (msgBtn) {
        e.stopPropagation();
        const id = msgBtn.dataset.id;
        setActiveChat(id);
        connectToPeer(id);
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
    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
      video: true 
    });
  } catch (err) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
        video: false 
      });
    } catch (audioErr) {
      handleMicError(audioErr);
      return;
    }
  }
  
  localStream.getVideoTracks().forEach(t => { t.enabled = false; });
  isCameraOn = false;
  attachLocalVideo(localStream);
  
  // FIRST: Establish data connections to all participants BEFORE making calls
  // This ensures soundboard, chat, and screen sharing work from the start
  for (const targetId of groupCallParticipants) {
    connectToPeer(targetId);
  }
  
  // Wait a moment for data connections to establish
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Call all participants
  const calls = [];
  for (const targetId of groupCallParticipants) {
    // Tell each callee who ELSE is in this call so they can connect directly
    // to one another (full mesh) instead of only to us. Without this, sounds
    // and messages sent by a callee would only ever reach the host.
    const otherParticipants = groupCallParticipants.filter(id => id !== targetId);
    const call = peer.call(targetId, localStream, {
      metadata: { name: myName, account: savedAccount, groupCall: true, participants: otherParticipants }
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

// Start a 1-on-1 call with a specific user
async function startCall(targetId) {
  if (!targetId) { 
    toast('Select a friend to call'); 
    return; 
  }
  if (targetId === $('my-peer-id')?.textContent) { 
    toast("That's your own ID!"); 
    return; 
  }
  if (!peer) { 
    toast('Not connected yet'); 
    return; 
  }

  // Request audio + video upfront so the WebRTC channel is negotiated for both.
  // Camera starts MUTED (track.enabled = false) — user taps Camera to turn it on.
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
      video: true 
    });
  } catch (err) {
    // Camera denied — try audio only (video button will be hidden)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
        video: false 
      });
    } catch (audioErr) {
      handleMicError(audioErr);
      return;
    }
  }

  // Disable video track by default — camera is "off" until user taps the button
  localStream.getVideoTracks().forEach(t => { t.enabled = false; });
  isCameraOn = false;
  attachLocalVideo(localStream);

  // FIRST: Establish data connection BEFORE making the call
  // This ensures soundboard, chat, and screen sharing work from the start
  connectToPeer(targetId);
  
  // Wait a moment for data connection to establish
  await new Promise(resolve => setTimeout(resolve, 300));

  const call = peer.call(targetId, localStream, {
    metadata: { name: myName, account: savedAccount }
  });

  if (!call) {
    toast('Could not initiate call');
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    return;
  }

  call.on('stream', remoteStream => {
    attachRemoteStream(remoteStream);
    $('call-status-badge').textContent = 'Connected';
    startCallTimer();
    setupVolumeMonitor(remoteStream);
  });

  call.on('close', () => {
    console.log('Call ended');
    endCall();
  });

  call.on('error', err => {
    console.error('Call error:', err);
    if (err.type === 'peer-unavailable') {
      toast(`${targetId} is offline or unreachable`);
    } else {
      toast('Call failed');
    }
    endCall();
  });

  currentCall = call;
  const person = directory.find(p => p.id === targetId) || { id: targetId, name: targetId };
  showActiveCallScreen('Calling...', person.name);
  updateCameraUI();
  toast(`Calling ${person.name}...`);
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
    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
      video: true 
    });
  } catch (err) {
    // Camera denied — try audio only (video button will be hidden)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
        video: false 
      });
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

  // FIRST: Establish data connection BEFORE making the call
  // This ensures soundboard, chat, and screen sharing work from the start
  connectToPeer(targetId);
  
  // Wait a moment for data connection to establish
  await new Promise(resolve => setTimeout(resolve, 300));

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
  
  // Play ringtone and show notification for incoming call
  playRingtone();
  showNotification(
    `📞 Incoming call from ${callerName}`,
    'Click to accept the call',
    () => {
      window.focus();
      showScreen('incoming');
    }
  );
  
  // Send push notification via service worker (works when tab is closed)
  sendPushNotification(callerName, call.peer);
}

// Function to send push notification via backend (placeholder for real implementation)
async function sendPushNotification(callerName, callerId) {
  // In a production app, you would send a request to your backend server here
  // The backend would then use the stored push subscription to send a real push notification
  // This is just a placeholder showing where the API call would go
  
  // Example: 
  // try {
  //   await fetch('/api/send-push-notification', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({
  //       toUserId: callerId, // In real app, this would be the recipient's ID
  //       type: 'call',
  //       title: `📞 Incoming call from ${myName}`,
  //       body: `${myName} is calling you`,
  //       data: { callId: pendingCall?.peer, url: '/' }
  //     })
  //   });
  // } catch (err) {
  //   console.error('Failed to send push notification:', err);
  // }
  
  console.log('Push notification would be sent to:', callerName);
  // For now, the browser notification above will work when tab is open but in background
}

function initIncomingCallButtons() {
  const btnAccept = $('btn-accept');
  const btnReject = $('btn-reject');

  if (btnAccept) {
    btnAccept.addEventListener('click', async () => {
      if (!pendingCall) return;

      // Stop ringtone when accepting
      stopRingtone();

      // Same as makeCall: get audio+video upfront, start with camera disabled
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
          video: true 
        });
      } catch (err) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
            video: false 
          });
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

      // FIRST: Establish data connection for soundboard and messaging BEFORE anything else
      connectToPeer(currentCall.peer);

      // If this is a group call, the host tells us who else is on the call.
      // Connect to each of them directly too, so soundboard sounds and
      // messages reach EVERYONE on the call, not just the host.
      if (currentCall.metadata?.groupCall && Array.isArray(currentCall.metadata?.participants)) {
        currentCall.metadata.participants.forEach(otherId => {
          if (otherId && otherId !== savedAccount?.id) {
            connectToPeer(otherId);
          }
        });
      }

      currentCall.on('close', endCall);
      currentCall.on('error', err => { toast('Call error'); endCall(); });
    });
  }

  if (btnReject) {
    btnReject.addEventListener('click', () => {
      if (pendingCall) { pendingCall.close(); pendingCall = null; }
      stopRingtone();
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
  // Stop ringtone if playing
  stopRingtone();
  
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
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
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
  isScreenOn = false;
  updateMuteUI();
  updateCameraUI();
  updateScreenUI();
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

// ── Screen Sharing ────────────────────────────────────────────
async function toggleScreenShare() {
  if (!currentCall && !Array.isArray(currentCall)) return;
  
  if (isScreenOn) {
    // Stop screen sharing
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
    }
    isScreenOn = false;
    
    // Re-enable camera if it was on before
    if (cameraStream && localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = true;
      }
      attachLocalVideo(localStream);
    }
    
    toast('Screen sharing stopped');
  } else {
    // Start screen sharing
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ 
        video: { cursor: "always" },
        audio: false 
      });
      
      isScreenOn = true;
      
      // Replace the video track in the call with screen share track
      const screenTrack = screenStream.getVideoTracks()[0];
      
      if (localStream) {
        // Disable camera track but keep it
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = false;
        }
        
        // Add screen track to local stream for preview
        localStream.addTrack(screenTrack.clone());
      }
      
      // Send screen track to all participants
      if (Array.isArray(currentCall)) {
        currentCall.forEach(call => {
          if (call && call.peerConnection) {
            const sender = call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
              sender.replaceTrack(screenTrack.clone());
            }
          }
        });
      } else if (currentCall && currentCall.peerConnection) {
        const sender = currentCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(screenTrack.clone());
        }
      }
      
      // Show screen in local preview
      if (localStream) {
        attachLocalVideo(screenStream);
      }
      showVideoArea();
      
      // Listen for user stopping via browser UI
      screenTrack.onended = () => {
        toggleScreenShare();
      };
      
      toast('Screen sharing started');
    } catch (err) {
      console.error('Screen share error:', err);
      toast('Could not start screen sharing');
      isScreenOn = false;
    }
  }
  
  updateScreenUI();
}

function updateScreenUI() {
  const btn = $('btn-screen');
  const iconOn = $('screen-icon-on');
  const iconOff = $('screen-icon-off');
  if (!btn) return;
  
  if (iconOn) iconOn.style.display = isScreenOn ? 'block' : 'none';
  if (iconOff) iconOff.style.display = isScreenOn ? 'none' : 'block';
  btn.classList.toggle('active', isScreenOn);
  const span = btn.querySelector('span');
  if (span) span.textContent = isScreenOn ? 'Stop Share' : 'Screen';
}

function initScreenButton() {
  const btnScreen = $('btn-screen');
  if (!btnScreen) return;
  btnScreen.addEventListener('click', toggleScreenShare);
}

// ── Full Screen on Hover ─────────────────────────────────────
function initFullScreenHover() {
  const videoArea = $('video-area');
  const remoteVideo = $('remote-video');
  const localVideo = $('local-video');
  
  if (!videoArea || !remoteVideo) return;
  
  // Helper function to toggle fullscreen
  const toggleFullScreen = async (element) => {
    try {
      if (!document.fullscreenElement) {
        if (element.requestFullscreen) {
          await element.requestFullscreen();
        } else if (element.webkitRequestFullscreen) {
          await element.webkitRequestFullscreen();
        } else if (element.msRequestFullscreen) {
          await element.msRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          await document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
          await document.msExitFullscreen();
        }
      }
    } catch (err) {
      console.error('Fullscreen error:', err);
    }
  };
  
  // Click on remote video to enter fullscreen
  remoteVideo.addEventListener('click', () => {
    if (remoteVideo.srcObject && remoteVideo.srcObject.getVideoTracks().length > 0) {
      toggleFullScreen(remoteVideo);
    }
  });
  
  // Also allow click on local video for screen share
  if (localVideo) {
    localVideo.addEventListener('click', () => {
      if (isScreenOn && localVideo.srcObject && localVideo.srcObject.getVideoTracks().length > 0) {
        toggleFullScreen(videoArea);
      }
    });
  }
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
async function initializeApp() {
  // Register service worker for push notifications
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      console.log('Service Worker registered:', registration.scope);
      
      // Request notification permission
      await requestNotificationPermission();
      
      // Subscribe to push notifications (for production, you'd send this subscription to your server)
      if (registration.pushManager) {
        try {
          const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array('YOUR_VAPID_PUBLIC_KEY_HERE') // Replace with your VAPID key
          });
          console.log('Push subscription:', JSON.stringify(subscription));
          // In a real app, send this subscription to your backend server
          // savePushSubscription(subscription);
        } catch (subErr) {
          console.log('Push subscription failed (expected in dev without VAPID):', subErr.message);
        }
      }
    } catch (err) {
      console.error('Service Worker registration failed:', err);
    }
  }
  
  showScreen('join');
  initJoinScreen();
  initMessaging();
  initCopyId();
  initCallButton();
  initIncomingCallButtons();
  initHangupButton();
  initMuteButton();
  initCameraButton();
  initScreenButton();
  initSpeakerButton();
  initFullScreenHover();
  initSoundboard();
  initAdminEasterEgg();
  initSettingsModal();
  renderPeople();
}

// Helper to convert VAPID key
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ── Soundboard ────────────────────────────────────────────────
const defaultSounds = [
  { name: 'Air Horn', icon: '📢', url: 'https://www.myinstants.com/media/sounds/air-horn-club-sample_1.mp3' },
  { name: 'Vine Boom', icon: '💥', url: 'https://www.myinstants.com/media/sounds/vine-boom.mp3' },
  { name: 'Oof', icon: '😵', url: 'https://www.myinstants.com/media/sounds/oof.mp3' },
  { name: 'Bruh', icon: '😂', url: 'https://www.myinstants.com/media/sounds/bruh.mp3' },
  { name: 'Tada', icon: '🎉', url: 'https://www.myinstants.com/media/sounds/tada.mp3' },
  { name: 'Crickets', icon: '🦗', url: 'https://www.myinstants.com/media/sounds/crickets.mp3' },
  { name: 'Dramatic', icon: '🎭', url: 'https://www.myinstants.com/media/sounds/dramatic-chipmunk.mp3' },
  { name: 'Wow', icon: '😮', url: 'https://www.myinstants.com/media/sounds/wow.mp3' },
  { name: 'Clown', icon: '🤡', url: 'https://www.myinstants.com/media/sounds/clown-music.mp3' },
];

function initSoundboard() {
  const btnSoundboard = $('btn-soundboard');
  const soundboardPanel = $('soundboard-panel');
  const btnCloseSoundboard = $('btn-close-soundboard');
  const soundboardSounds = $('soundboard-sounds');
  const volumeSlider = $('soundboard-volume-slider');
  const volumeValue = $('soundboard-volume-value');
  const soundUpload = $('sound-upload');
  
  if (!btnSoundboard || !soundboardPanel) return;
  
  // Initialize audio context
  try {
    soundboardAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  } catch (err) {
    console.error('Audio context not supported:', err);
  }
  
  // Render default sounds
  renderSoundboardSounds(soundboardSounds);
  
  // Toggle soundboard panel
  btnSoundboard.addEventListener('click', () => {
    if (!currentCall && !Array.isArray(currentCall)) {
      toast('Open soundboard during a call');
      return;
    }
    const isVisible = soundboardPanel.style.display !== 'none';
    soundboardPanel.style.display = isVisible ? 'none' : 'block';
    btnSoundboard.classList.toggle('active', !isVisible);
  });
  
  // Close soundboard
  if (btnCloseSoundboard) {
    btnCloseSoundboard.addEventListener('click', () => {
      soundboardPanel.style.display = 'none';
      btnSoundboard.classList.remove('active');
    });
  }
  
  // Volume control
  if (volumeSlider && volumeValue) {
    volumeSlider.addEventListener('input', (e) => {
      soundboardVolume = e.target.value / 100;
      volumeValue.textContent = `${e.target.value}%`;
      activeUrlAudioElements.forEach(audio => { audio.volume = soundboardVolume; });
    });
  }
  
  // Upload custom sound
  if (soundUpload) {
    soundUpload.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && file.type.startsWith('audio/')) {
        const url = URL.createObjectURL(file);
        const soundName = file.name.replace('.mp3', '').replace('.wav', '').replace('.ogg', '');
        customSounds.push({ name: soundName, icon: '🎵', url: url, isCustom: true });
        renderSoundboardSounds(soundboardSounds);
        toast(`Added "${soundName}" to soundboard`);
      }
      e.target.value = ''; // Reset input
    });
  }
}

function renderSoundboardSounds(container) {
  if (!container) return;
  
  const allSounds = [...defaultSounds, ...customSounds];
  container.innerHTML = allSounds.map((sound, index) => `
    <button class="sound-btn" data-index="${index}">
      <span class="sound-icon">${escapeHtml(sound.icon)}</span>
      <span>${escapeHtml(sound.name)}</span>
    </button>
  `).join('');
  
  // Add click handlers
  container.querySelectorAll('.sound-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      const sound = allSounds[index];
      triggerSound(sound);
    });
  });
}

// Tracks currently-playing <audio> elements so we can live-update volume.
const activeUrlAudioElements = new Set();

// User clicked a soundboard button: play it locally and broadcast it to
// every connected peer so it's heard by everybody in the call.
async function triggerSound(sound) {
  if (dataConnections.size === 0) {
    toast('No one connected yet — sound will only play for you');
  }

  if (sound.isCustom) {
    // Custom uploads only exist as a blob: URL inside THIS browser tab, so
    // the only way another peer can hear it is if we send the actual audio
    // bytes across the data channel.
    try {
      const response = await fetch(sound.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      playArrayBufferLocally(arrayBuffer.slice(0), sound.name);
      broadcastCustomSound(arrayBuffer.slice(0), sound.name);
      toast(`Playing "${sound.name}"...`);
    } catch (err) {
      console.error('Failed to play custom sound:', err);
      toast(`Could not play "${sound.name}"`);
    }
  } else {
    // Default catalog sounds are hot-linked from a public URL. Playing them
    // via a plain <audio> element (instead of fetch + decodeAudioData) means
    // we don't need the remote server's permission (CORS) just to play the
    // file — and broadcasting just the URL means every peer can independently
    // play it the same way, with nothing heavy going over the data channel.
    playUrlSoundLocally(sound.url, sound.name);
    broadcastUrlSound(sound.url, sound.name);
    toast(`Playing "${sound.name}"...`);
  }
}

// Plays a hot-linked sound via a normal <audio> element. This works
// regardless of whether the source server sends CORS headers, since
// simple playback (unlike fetch+decode) never needed CORS permission.
function playUrlSoundLocally(url, name) {
  try {
    const audio = new Audio(url);
    audio.volume = soundboardVolume;
    activeUrlAudioElements.add(audio);
    audio.addEventListener('ended', () => activeUrlAudioElements.delete(audio));
    audio.play().catch(err => {
      console.error('Could not play sound (browser blocked playback):', err);
      toast(`Could not play "${name}"`);
    });
  } catch (err) {
    console.error('Failed to play url sound:', err);
    toast(`Could not play "${name}"`);
  }
}

// Plays raw audio bytes (used for custom uploaded sounds, both locally and
// when received from a peer) via the Web Audio API.
async function playArrayBufferLocally(arrayBuffer, name) {
  if (!soundboardAudioContext) {
    toast('Audio not supported on this device');
    return;
  }
  if (soundboardAudioContext.state === 'suspended') {
    try { await soundboardAudioContext.resume(); } catch (err) { /* ignore */ }
  }
  try {
    const audioBuffer = await soundboardAudioContext.decodeAudioData(arrayBuffer);
    const source = soundboardAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    const gainNode = soundboardAudioContext.createGain();
    gainNode.gain.value = soundboardVolume;
    source.connect(gainNode);
    gainNode.connect(soundboardAudioContext.destination);
    source.start(0);
  } catch (err) {
    console.error('Failed to decode/play sound:', err);
    toast(`Could not play "${name}"`);
  }
}

// Broadcasts a default catalog sound by URL — tiny message, no audio bytes
// needed, so it can't be choked or dropped by data-channel size limits.
function broadcastUrlSound(url, name) {
  let sentCount = 0;
  dataConnections.forEach((conn, peerId) => {
    if (conn && conn.open) {
      try {
        conn.send({ type: 'sound', name, url, isCustom: false });
        sentCount++;
      } catch (err) {
        console.error('Failed to send sound to peer:', peerId, err);
      }
    }
  });
  console.log(`Sound URL sent to ${sentCount} peer(s) of ${dataConnections.size} connection(s)`);
}

// Broadcasts a custom uploaded sound's raw bytes. Sending the Uint8Array
// directly (instead of converting it to a plain number array) keeps the
// payload as small as the original file and lets PeerJS's binary
// serializer chunk/transfer it reliably.
function broadcastCustomSound(arrayBuffer, name) {
  const bytes = new Uint8Array(arrayBuffer);
  let sentCount = 0;
  dataConnections.forEach((conn, peerId) => {
    if (conn && conn.open) {
      try {
        conn.send({ type: 'sound', name, audioData: bytes, isCustom: true });
        sentCount++;
      } catch (err) {
        console.error('Failed to send custom sound to peer:', peerId, err);
      }
    }
  });
  console.log(`Custom sound sent to ${sentCount} peer(s) of ${dataConnections.size} connection(s)`);
  if (sentCount === 0 && dataConnections.size > 0) {
    toast('⚠️ Could not reach connected peers with this sound');
  }
}

function handleIncomingSound(data) {
  if (data.isCustom && data.audioData) {
    // Normalize whatever shape the bytes arrived in (ArrayBuffer, a typed
    // array, or — for backwards compatibility — a plain number array) back
    // into an ArrayBuffer we can decode.
    let arrayBuffer = null;
    if (data.audioData instanceof ArrayBuffer) {
      arrayBuffer = data.audioData;
    } else if (ArrayBuffer.isView(data.audioData)) {
      arrayBuffer = data.audioData.buffer.slice(data.audioData.byteOffset, data.audioData.byteOffset + data.audioData.byteLength);
    } else if (Array.isArray(data.audioData)) {
      arrayBuffer = new Uint8Array(data.audioData).buffer;
    }

    if (!arrayBuffer) {
      toast(`🔊 ${data.name}`);
      return;
    }

    toast(`🔊 Playing "${data.name}"...`);
    playArrayBufferLocally(arrayBuffer, data.name);
  } else if (data.url) {
    toast(`🔊 Playing "${data.name}"...`);
    playUrlSoundLocally(data.url, data.name);
  } else {
    toast(`🔊 ${data.name}`);
  }
}

// ── Admin Easter Egg ──────────────────────────────────────────
function initAdminEasterEgg() {
  const btnAdminGlobalMsg = $('btn-admin-global-msg');
  const btnAdminToggleCameras = $('btn-admin-toggle-cameras');
  const btnAdminUserMsg = $('btn-admin-user-msg');
  const btnAdminForceCamera = $('btn-admin-force-camera');
  const btnAdminForceCameraOff = $('btn-admin-force-camera-off');
  const btnCloseAdmin = $('btn-close-admin');
  const adminPanel = $('admin-panel');
  const adminUserSelect = $('admin-user-select');
  
  // Listen for keyboard input to trigger admin mode
  document.addEventListener('keydown', (e) => {
    if (!currentCall && !Array.isArray(currentCall)) return;
    
    // Only capture letter keys
    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
      adminKeyBuffer += e.key.toLowerCase();
      
      // Keep only last 5 characters
      if (adminKeyBuffer.length > 10) {
        adminKeyBuffer = adminKeyBuffer.slice(-10);
      }
      
      // Check if "admin" was typed
      if (adminKeyBuffer.includes(ADMIN_KEY)) {
        activateAdminMode();
        adminKeyBuffer = '';
      }
    } else if (e.key === 'Escape') {
      adminKeyBuffer = '';
    }
  });
  
  // Close admin panel
  if (btnCloseAdmin && adminPanel) {
    btnCloseAdmin.addEventListener('click', () => {
      adminPanel.style.display = 'none';
    });
  }
  
  // Global message
  if (btnAdminGlobalMsg) {
    btnAdminGlobalMsg.addEventListener('click', () => {
      const msg = prompt('Enter global message:');
      if (msg) {
        broadcastAdminMessage('global', msg);
        showAdminMessageOnScreen(myName, msg, true);
        toast('Global message sent');
      }
    });
  }
  
  // Toggle all cameras
  if (btnAdminToggleCameras) {
    btnAdminToggleCameras.addEventListener('click', () => {
      broadcastAdminCommand('toggle_cameras');
      toast('Sent camera toggle command');
    });
  }
  
  // User-specific actions
  if (btnAdminUserMsg) {
    btnAdminUserMsg.addEventListener('click', () => {
      const userId = adminUserSelect?.value;
      if (!userId) {
        toast('Select a user first');
        return;
      }
      const msg = prompt(`Enter message for ${userId}:`);
      if (msg) {
        sendAdminMessageToUser(userId, msg);
        toast(`Message sent to ${userId}`);
      }
    });
  }
  
  // Force camera on
  if (btnAdminForceCamera) {
    btnAdminForceCamera.addEventListener('click', () => {
      const userId = adminUserSelect?.value;
      if (!userId) {
        toast('Select a user first');
        return;
      }
      sendAdminCommandToUser(userId, 'camera_on');
      toast(`Sent camera ON command to ${userId}`);
    });
  }
  
  // Force camera off
  if (btnAdminForceCameraOff) {
    btnAdminForceCameraOff.addEventListener('click', () => {
      const userId = adminUserSelect?.value;
      if (!userId) {
        toast('Select a user first');
        return;
      }
      sendAdminCommandToUser(userId, 'camera_off');
      toast(`Sent camera OFF command to ${userId}`);
    });
  }
}

function activateAdminMode() {
  // Allow reopening the admin panel by toggling
  const wasOpen = isAdminMode;
  
  const adminPanel = $('admin-panel');
  const adminUserSelect = $('admin-user-select');
  
  if (adminPanel) {
    if (wasOpen) {
      adminPanel.style.display = 'none';
      isAdminMode = false;
      return;
    } else {
      adminPanel.style.display = 'block';
      isAdminMode = true;
    }
  }
  
  // Populate user select with current participants
  if (adminUserSelect) {
    adminUserSelect.innerHTML = '<option value="">Select User...</option>';
    
    let hasUsers = false;
    
    // Add group call participants
    if (Array.isArray(currentCall) && groupCallParticipants.length > 0) {
      groupCallParticipants.forEach(participant => {
        const option = document.createElement('option');
        option.value = participant.id || participant;
        option.textContent = participant.name || participant;
        adminUserSelect.appendChild(option);
        hasUsers = true;
      });
    }
    
    // Add data connection peers
    dataConnections.forEach((conn, peerId) => {
      if (peerId !== savedAccount?.id) {
        const person = directory.find(p => p.id === peerId);
        const option = document.createElement('option');
        option.value = peerId;
        option.textContent = person?.name || peerId;
        adminUserSelect.appendChild(option);
        hasUsers = true;
      }
    });
    
    // If no users found, show message
    if (!hasUsers) {
      const option = document.createElement('option');
      option.textContent = 'No active connections';
      option.disabled = true;
      adminUserSelect.appendChild(option);
    }
  }
  
  toast('🔧 Admin Mode Activated!', 2000);
}

function broadcastAdminMessage(type, message) {
  dataConnections.forEach((conn, peerId) => {
    if (conn && conn.open) {
      try {
        conn.send({ type: 'admin_message', adminType: type, message: message, from: myName });
      } catch (err) {
        console.log('Failed to send admin message to peer:', peerId);
      }
    }
  });
}

function sendAdminMessageToUser(userId, message) {
  const conn = dataConnections.get(userId);
  if (conn && conn.open) {
    try {
      conn.send({ type: 'admin_message', adminType: 'user', message: message, from: myName });
    } catch (err) {
      console.log('Failed to send admin message to user:', userId);
    }
  }
}

function broadcastAdminCommand(command) {
  dataConnections.forEach((conn, peerId) => {
    if (conn && conn.open) {
      try {
        conn.send({ type: 'admin_command', command: command, from: myName });
      } catch (err) {
        console.log('Failed to send admin command to peer:', peerId);
      }
    }
  });
}

function sendAdminCommandToUser(userId, command) {
  const conn = dataConnections.get(userId);
  if (conn && conn.open) {
    try {
      conn.send({ type: 'admin_command', command: command, from: myName });
    } catch (err) {
      console.log('Failed to send admin command to user:', userId);
    }
  }
}

function showAdminMessageOnScreen(sender, message, isGlobal = false) {
  // Create a temporary overlay message
  const overlay = document.createElement('div');
  overlay.className = 'admin-message-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(99, 102, 241, 0.95);
    color: white;
    padding: 20px 40px;
    border-radius: 16px;
    font-family: 'Space Grotesk', sans-serif;
    font-size: 1.2rem;
    font-weight: 600;
    z-index: 1000;
    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    text-align: center;
    animation: fadeIn 0.3s ease;
  `;
  overlay.innerHTML = `
    <div style="font-size: 0.85rem; opacity: 0.8; margin-bottom: 8px;">
      ${isGlobal ? '📢 Global Message' : '💬 Message'} from ${escapeHtml(sender)}
    </div>
    <div>${escapeHtml(message)}</div>
  `;
  
  document.body.appendChild(overlay);
  
  setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    setTimeout(() => overlay.remove(), 300);
  }, 4000);
}

function handleIncomingAdminMessage(data) {
  const { adminType, message, from } = data;
  showAdminMessageOnScreen(from, message, adminType === 'global');
}

function handleIncomingAdminCommand(data) {
  const { command, from } = data;
  
  if (command === 'toggle_cameras') {
    // Toggle local camera
    if (localStream && isCameraOn) {
      toggleCamera();
    }
    toast(`📷 Camera toggle requested by ${from}`);
  } else if (command === 'camera_on') {
    // Force camera on
    if (localStream && !isCameraOn) {
      toggleCamera();
    }
    toast(`📷 Camera ON requested by ${from}`);
  } else if (command === 'camera_off') {
    // Force camera off
    if (localStream && isCameraOn) {
      toggleCamera();
    }
    toast(`📷 Camera OFF requested by ${from}`);
  }
}
initializeApp();

// ── SETTINGS MODAL ────────────────────────────────────────────
function initSettingsModal() {
  const btnSettings = $('btn-settings');
  const screenSettings = $('screen-settings');
  const btnCloseSettings = $('btn-close-settings');
  const themeCards = document.querySelectorAll('.theme-card');
  const btnResetDefaults = $('btn-reset-defaults');
  
  // Open settings
  if (btnSettings) {
    btnSettings.addEventListener('click', () => {
      screenSettings?.classList.add('active');
    });
  }
  
  // Close settings
  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', () => {
      screenSettings?.classList.remove('active');
    });
  }
  
  // Close on overlay click
  if (screenSettings) {
    screenSettings.addEventListener('click', (e) => {
      if (e.target === screenSettings || e.target.classList.contains('settings-overlay')) {
        screenSettings.classList.remove('active');
      }
    });
  }
  
  // Theme selection
  themeCards.forEach(card => {
    card.addEventListener('click', () => {
      // Remove active from all
      themeCards.forEach(c => c.classList.remove('theme-active'));
      // Add active to clicked
      card.classList.add('theme-active');
      
      const theme = card.dataset.theme;
      applyTheme(theme);
      toast(`🎨 Theme changed to ${card.querySelector('.theme-name')?.textContent || theme}`);
    });
  });
  
  // Reset defaults
  if (btnResetDefaults) {
    btnResetDefaults.addEventListener('click', () => {
      applyTheme('neon-cyber');
      themeCards.forEach(c => c.classList.remove('theme-active'));
      document.querySelector('[data-theme="neon-cyber"]')?.classList.add('theme-active');
      toast('✨ Reset to default theme');
    });
  }
}

function applyTheme(themeName) {
  const root = document.documentElement;
  
  // Theme color schemes
  const themes = {
    'neon-cyber': {
      '--bg': '#0d0f1a',
      '--surface': '#151829',
      '--surface2': '#1e2238',
      '--border': '#2a2f50',
      '--accent': '#6366f1',
      '--accent-h': '#818cf8',
      '--accent-g': 'linear-gradient(135deg, #6366f1, #8b5cf6)'
    },
    'sunset-vaporwave': {
      '--bg': '#2d1b4e',
      '--surface': '#3d255e',
      '--surface2': '#4d2f6e',
      '--border': '#5d397e',
      '--accent': '#ff6b6b',
      '--accent-h': '#feca57',
      '--accent-g': 'linear-gradient(135deg, #ff6b6b, #feca57, #ff9ff3)'
    },
    'matrix-digital': {
      '--bg': '#000000',
      '--surface': '#0a0a0a',
      '--surface2': '#111111',
      '--border': '#1a1a1a',
      '--accent': '#00ff41',
      '--accent-h': '#00cc33',
      '--accent-g': 'linear-gradient(135deg, #00ff41, #00cc33)'
    },
    'aurora-borealis': {
      '--bg': '#0f2027',
      '--surface': '#1a3a4a',
      '--surface2': '#203a43',
      '--border': '#2c5364',
      '--accent': '#22c55e',
      '--accent-h': '#34d399',
      '--accent-g': 'linear-gradient(135deg, #22c55e, #34d399, #6366f1)'
    },
    'deep-space': {
      '--bg': '#090a0f',
      '--surface': '#13151f',
      '--surface2': '#1b1e2e',
      '--border': '#2a2f45',
      '--accent': '#8b5cf6',
      '--accent-h': '#a78bfa',
      '--accent-g': 'linear-gradient(135deg, #8b5cf6, #a78bfa)'
    },
    'fire-ember': {
      '--bg': '#1a0000',
      '--surface': '#2a0000',
      '--surface2': '#3a0000',
      '--border': '#4a0000',
      '--accent': '#ff4500',
      '--accent-h': '#ff6347',
      '--accent-g': 'linear-gradient(135deg, #ff4500, #ff6347)'
    }
  };
  
  const theme = themes[themeName] || themes['neon-cyber'];
  
  // Apply CSS variables
  Object.entries(theme).forEach(([prop, value]) => {
    root.style.setProperty(prop, value);
  });
  
  // Store in localStorage
  localStorage.setItem('linkup-theme', themeName);
}

// Load saved theme on startup
(function loadSavedTheme() {
  const savedTheme = localStorage.getItem('linkup-theme') || 'neon-cyber';
  setTimeout(() => applyTheme(savedTheme), 100);
})();
