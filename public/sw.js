// sw.js - Service Worker for Push Notifications

const CACHE_NAME = 'linkup-cache-v1';

// Install event - cache assets if needed
self.addEventListener('install', (event) => {
  self.skipWaiting(); // Force activation immediately
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Take control of all pages immediately
});

// Push event - Handle incoming push messages from server
self.addEventListener('push', (event) => {
  let data = {};
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'LinkUp', body: event.data.text() };
    }
  }

  const title = data.title || 'LinkUp Call';
  const options = {
    body: data.body || 'You have a new activity',
    icon: undefined, // Using emoji in title instead
    badge: undefined,
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/', // URL to open when clicked
      callId: data.callId,
      type: data.type // 'call' or 'message'
    },
    actions: data.type === 'call' ? [
      { action: 'answer', title: '✓ Answer' },
      { action: 'decline', title: '✕ Decline' }
    ] : [],
    requireInteraction: true, // Keep notification until user acts
    tag: data.callId || 'linkup-notification', // Replace existing notification with same tag
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Handle notification clicks and actions
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  const urlToOpen = event.notification.data.url || '/';
  const callId = event.notification.data.callId;
  
  // Handle action buttons (Answer/Decline)
  if (event.action === 'answer') {
    console.log('User clicked Answer for call:', callId);
    // Open app with call parameter
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ('focus' in client) {
            client.postMessage({ type: 'answer-call', callId: callId });
            return client.focus();
          }
        }
        return clients.openWindow(urlToOpen + '?action=answer&call=' + callId);
      })
    );
    return;
  } else if (event.action === 'decline') {
    console.log('User clicked Decline for call:', callId);
    // Send message to any open client to decline the call
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ('focus' in client) {
            client.postMessage({ type: 'decline-call', callId: callId });
            return client.focus();
          }
        }
        return clients.openWindow(urlToOpen);
      })
    );
    return;
  }
  
  // Default click behavior - focus or open window
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Check if there is already a window open
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url.includes(urlToOpen) && 'focus' in client) {
          return client.focus();
        }
      }
      // If no window open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// Handle messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
