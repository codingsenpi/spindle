const express = require('express');
const cors = require('cors');
const webpush = require('web-push');

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();

app.use((req, res, next) => {
  req.url = new URL(req.url, 'http://localhost').pathname;
  next();
});

app.use(express.json());
app.use(cors());

if (getApps().length === 0) {
  try {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  } catch (e) {
    console.error('Firebase init failed:', e.message);
  }
}

// Validates session and returns { username, isDiscuitAdmin } or throws.
async function validateSession(sid, csrfToken) {
  const res = await fetch('https://discuit.net/api/_initial', {
    headers: { 'Cookie': sid, 'X-Csrf-Token': csrfToken || '' },
  });
  if (!res.ok) throw Object.assign(new Error('Invalid session'), { status: 401 });
  const data = await res.json();
  const username = data.user?.username;
  if (!username) throw Object.assign(new Error('Not logged in'), { status: 401 });
  return { username, isDiscuitAdmin: data.user?.isAdmin === true };
}

app.post('/api/getVapidKeys', async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ error: 'Missing FCM token' });

    const vapidKeys = webpush.generateVAPIDKeys();
    const base = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;

    return res.json({
      publicKey: vapidKeys.publicKey,
      auth: 'diskette-auth-secret',
      endpoint: `${base}/api/relayPush?fcm=${fcmToken}`,
      subject: 'mailto:admin@diskette.app',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/relayPush', async (req, res) => {
  const fcmToken = req.query.fcm;
  if (!fcmToken) return res.status(400).send('Missing FCM token');

  try {
    await getMessaging().send({
      data: { notificationId: req.headers['topic'] || '', action: 'WAKE_AND_FETCH' },
      token: fcmToken,
    });
    return res.status(201).send('Relayed');
  } catch (e) {
    if (e.code === 'messaging/registration-token-not-registered') {
      return res.status(410).send('Gone');
    }
    return res.status(500).send('Internal Error');
  }
});

app.post('/api/chat/registerToken', async (req, res) => {
  try {
    const { sid, csrfToken, fcmToken, optIn } = req.body;
    if (!sid || !fcmToken) return res.status(400).json({ error: 'Missing sid or fcmToken' });

    const { username } = await validateSession(sid, csrfToken);

    await getFirestore().collection('user_fcm_tokens').doc(username).set({
      token: fcmToken,
      optInToGlobalChat: optIn === true,
      updatedAt: new Date(),
    });

    return res.json({ success: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/chat/flag', async (req, res) => {
  try {
    const { messageId, sid, csrfToken } = req.body;
    if (!messageId || !sid) return res.status(400).json({ error: 'Missing messageId or sid' });

    const { username } = await validateSession(sid, csrfToken);

    const db = getFirestore();
    const msgRef = db.collection('general_chat_messages').doc(messageId);
    const msgDoc = await msgRef.get();

    if (!msgDoc.exists) return res.status(404).json({ error: 'Message not found' });
    if (msgDoc.data().username === username) {
      return res.status(400).json({ error: 'Cannot flag your own message' });
    }

    let flaggedBy = msgDoc.data().flaggedBy || [];
    if (flaggedBy.includes(username)) {
      return res.json({ success: true, alreadyFlagged: true });
    }

    flaggedBy.push(username);
    const isFlagged = flaggedBy.length >= 3;
    await msgRef.update({ flaggedBy, isFlagged });

    return res.json({ success: true, isFlagged });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/chat/delete', async (req, res) => {
  try {
    const { messageId, sid, csrfToken } = req.body;
    if (!messageId || !sid) return res.status(400).json({ error: 'Missing messageId or sid' });

    const { username, isDiscuitAdmin } = await validateSession(sid, csrfToken);

    const db = getFirestore();
    const modDoc = await db.collection('config').doc('moderators').get();
    const isFirestoreMod = modDoc.exists &&
      (modDoc.data().usernames || []).includes(username);

    if (!isDiscuitAdmin && !isFirestoreMod) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await db.collection('general_chat_messages').doc(messageId).delete();
    return res.json({ success: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/chat/send', async (req, res) => {
  try {
    const { message, sid, csrfToken, replyToMessageId, clientMsgId } = req.body;

    if (!message || message.trim().length === 0 || !sid) {
      return res.status(400).json({ error: 'Missing message or sid' });
    }
    if (message.length > 500) {
      return res.status(400).json({ error: 'Message too long (max 500 chars)' });
    }

    const { username } = await validateSession(sid, csrfToken);

    const db = getFirestore();

    // Ban check
    const banDoc = await db.collection('config').doc('banned_users').get();
    if (banDoc.exists) {
      const banned = banDoc.data().usernames || [];
      if (banned.includes(username)) {
        return res.status(403).json({ error: 'banned' });
      }
    }

    // Token bucket rate limiting
    const rateLimitRef = db.collection('rate_limits').doc(username);
    const rateLimitDoc = await rateLimitRef.get();

    let tokens = 3;
    let lastUpdated = Date.now();

    if (rateLimitDoc.exists) {
      const data = rateLimitDoc.data();
      tokens = data.tokens;
      lastUpdated = data.lastUpdated?.toDate?.()?.getTime() ?? Date.now();

      const elapsed = (Date.now() - lastUpdated) / 1000;
      const regen = Math.floor(elapsed / 10);
      if (regen > 0) {
        tokens = Math.min(3, tokens + regen);
        lastUpdated += regen * 10000;
      }
    }

    if (tokens < 1) {
      return res.status(429).json({ error: 'Sending too fast.' });
    }

    tokens -= 1;
    await rateLimitRef.set({ tokens, lastUpdated: new Date(lastUpdated) });

    // Save to Firestore
    let avatarUrl = null;
    try {
      const discuitRes = await fetch('https://discuit.net/api/_initial', {
        headers: { 'Cookie': sid, 'X-Csrf-Token': csrfToken || '' },
      });
      if (discuitRes.ok) {
        const data = await discuitRes.json();
        avatarUrl = data.user?.proPic?.url || null;
        if (avatarUrl && !avatarUrl.startsWith('http')) {
          avatarUrl = 'https://discuit.net' + (avatarUrl.startsWith('/') ? '' : '/') + avatarUrl;
        }
      }
    } catch (_) {}

    const newMsg = {
      username,
      avatarUrl,
      message: message.trim(),
      createdAt: new Date(),
      isFlagged: false,
      replyToMessageId: replyToMessageId || null,
      ...(clientMsgId ? { clientMsgId } : {}),
    };

    const docRef = await db.collection('general_chat_messages').add(newMsg);

    // Push notification for replies
    if (replyToMessageId) {
      try {
        const originalDoc = await db.collection('general_chat_messages').doc(replyToMessageId).get();
        if (originalDoc.exists) {
          const originalUsername = originalDoc.data().username;
          if (originalUsername && originalUsername !== username) {
            const tokenDoc = await db.collection('user_fcm_tokens').doc(originalUsername).get();
            if (tokenDoc.exists && tokenDoc.data().optInToGlobalChat === true) {
              await getMessaging().send({
                notification: {
                  title: `${username} replied in Global Chat`,
                  body: message.length > 50 ? message.substring(0, 50) + '...' : message,
                },
                data: { type: 'GLOBAL_CHAT_REPLY', messageId: docRef.id },
                token: tokenDoc.data().token,
              });
            }
          }
        }
      } catch (_) {}
    }

    return res.json({ success: true, messageId: docRef.id });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = app;
