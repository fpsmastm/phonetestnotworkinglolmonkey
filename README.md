# 📡 LinkUp — School Voice Calling

A browser-based voice calling app for Chromebooks. No app installs, no accounts, no backend server needed. Works on **Cloudflare Pages** and **GitHub Pages**.

## How it works

- Uses **WebRTC** (built into all modern browsers) for peer-to-peer audio
- Uses **PeerJS** (free CDN) to handle peer discovery and signaling
- Each user gets a **Call ID** they share with others to receive calls
- All audio goes directly between browsers — no calls stored anywhere

## Deploying

### GitHub Pages
1. Upload all files to a GitHub repo
2. Go to Settings → Pages → Deploy from branch (`main`, `/root`)
3. Your site will be at `https://yourusername.github.io/repo-name`

### Cloudflare Pages (recommended — faster, better on school networks)
1. Connect your GitHub repo to [Cloudflare Pages](https://pages.cloudflare.com)
2. Build command: *(leave blank — static site)*
3. Output directory: `/` or `.`
4. Deploy!

## Files
```
index.html   — Main app UI (all 4 screens)
style.css    — Styles
app.js       — WebRTC logic via PeerJS
README.md    — This file
```

## Using it in class
1. Open the site on your Chromebook
2. Enter your name → get a Call ID
3. Copy your Call ID and share it with a classmate (Google Chat, etc.)
4. They paste your ID and press **Call**
5. Accept the call — you're connected!

## Notes for school networks
- Requires microphone permission in Chrome (click **Allow** when prompted)
- If calls fail, the school network may be blocking WebRTC — ask your IT admin to allow it
- For best results, both Chromebooks should be on the same network
- The PeerJS free tier is for demos; for production use, deploy your own PeerServer

## Tech stack
- Plain HTML/CSS/JS — no build tools needed
- [PeerJS](https://peerjs.com/) for WebRTC signaling
- Google STUN servers for NAT traversal
