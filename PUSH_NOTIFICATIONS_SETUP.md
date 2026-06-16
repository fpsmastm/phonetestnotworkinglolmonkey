# LinkUp Push Notifications Setup Guide

## Important: Notifications When Tab is Closed

For notifications to work when the tab is **completely closed**, you need a **backend server** with push notification capabilities. Here's what you need to do:

### 1. Generate VAPID Keys

VAPID (Voluntary Application Server Identification) keys are required for web push notifications.

```bash
# Install web-push tool
npm install -g web-push

# Generate VAPID keys
web-push generate-vapid-keys
```

This will output something like:
```
Public Key: BKx... (long string)
Private Key: ... (keep this secret!)
```

### 2. Update app.js

Replace `YOUR_VAPID_PUBLIC_KEY_HERE` in `/workspace/public/app.js` with your actual public key:

```javascript
applicationServerKey: urlBase64ToUint8Array('BKx...') // Your actual public key
```

### 3. Set Up Backend Server

You need a backend server to:
- Store user push subscriptions
- Send push notifications when someone calls

Example Node.js/Express backend (`server.js`):

```javascript
const express = require('express');
const webPush = require('web-push');
const app = express();

app.use(express.json());

// Set your VAPID keys
webPush.setVapidDetails(
  'mailto:your-email@example.com',
  'YOUR_PUBLIC_KEY',
  'YOUR_PRIVATE_KEY'
);

// In-memory storage (use a database in production)
let subscriptions = new Map();

// Save subscription
app.post('/api/save-subscription', (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription) {
    return res.status(400).json({ error: 'Missing userId or subscription' });
  }
  subscriptions.set(userId, subscription);
  console.log(`Saved subscription for ${userId}`);
  res.json({ success: true });
});

// Send push notification
app.post('/api/send-push-notification', async (req, res) => {
  const { toUserId, type, title, body, data } = req.body;
  
  const subscription = subscriptions.get(toUserId);
  if (!subscription) {
    return res.status(404).json({ error: 'User not found or not subscribed' });
  }
  
  try {
    await webPush.sendNotification(subscription, JSON.stringify({
      title,
      body,
      type,
      data
    }));
    console.log(`Push notification sent to ${toUserId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send push:', err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

### 4. Update sendPushNotification in app.js

Replace the placeholder function with actual API call:

```javascript
async function sendPushNotification(callerName, callerId) {
  try {
    await fetch('https://your-backend-server.com/api/send-push-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toUserId: callerId,
        type: 'call',
        title: `📞 Incoming call from ${myName}`,
        body: `${myName} is calling you`,
        data: { callId: pendingCall?.peer, url: '/' }
      })
    });
  } catch (err) {
    console.error('Failed to send push notification:', err);
  }
}
```

### 5. Save User Subscription

Add this to save the user's push subscription when they first visit:

```javascript
async function savePushSubscription(subscription) {
  try {
    await fetch('https://your-backend-server.com/api/save-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: savedAccount.id,
        subscription: subscription
      })
    });
    console.log('Push subscription saved to server');
  } catch (err) {
    console.error('Failed to save subscription:', err);
  }
}
```

Then call it in `initializeApp()` after getting the subscription.

## Current Behavior (Without Backend)

✅ **Tab open but in background**: Browser notifications work perfectly  
✅ **Tab minimized**: Notifications work  
✅ **Different tab active**: Notifications work  
❌ **Tab completely closed**: Requires backend server (see above)

## Testing Notifications

1. Open the app in two different browser windows/tabs
2. In one tab, minimize it or switch to another tab
3. In the other tab, call the first tab's ID
4. You should see a browser notification and hear a ringtone

## PWA Installation

The app now includes a manifest.json file, allowing users to:
- Install the app on their desktop/mobile
- Run it as a standalone app
- Receive notifications even when "closed" (actually running in background)

To test PWA installation:
1. Open the app in Chrome
2. Look for the install icon in the address bar
3. Click "Install" to add to home screen/desktop
