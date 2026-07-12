# Spindle

The Vercel backend for Diskette. 

It does two things:
1. **Push Relay:** Bounces Discuit notifications to Firebase (FCM).
2. **Chat Gateway:** Checks Discuit session cookies and writes chat messages straight to Firestore.

### Privacy
This server is strictly stateless. It does not log, save, or store:
- Session cookies (`sid`)
- CSRF tokens
- Chat message text
- FCM push tokens

State management (rate limits, bans, message history) is handled entirely in Firestore. The Vercel runtime forgets everything the second the request ends.

### Setup & Deploy

Set `FIREBASE_SERVICE_ACCOUNT` in your Vercel project environment variables.

```bash
npm install
npm i -g vercel
vercel deploy --prod

```

### Local Dev

```bash
npx vercel dev
```