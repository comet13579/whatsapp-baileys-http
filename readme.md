# WhatsApp Web — Baileys Setup Guide

## Why Baileys?

Baileys is a pure JavaScript library that connects to WhatsApp via WebSocket — no browser, no Selenium. It's the most reliable free/unofficial option (9k+ GitHub stars, actively maintained).

- **Repo:** https://github.com/WhiskeySockets/Baileys
- **Docs:** https://baileys.wiki
- **License:** MIT (free)

---

## Step-by-Step Setup

### 1. Install Node.js (if not already)

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version   # Should be 18+
npm --version
```

### 2. Create Project

```bash
mkdir ~/whatsapp-bot
cd ~/whatsapp-bot
npm init -y
npm install @whiskeysockets/baileys qrcode-terminal
```

**⚠️ You MUST install `qrcode-terminal`** — it's NOT a Baileys dependency. Without it, the QR code won't display.

### 3. Create `bot.js`

```javascript
const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, 'auth');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function startBot() {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web v${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false  // We handle QR manually below
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Scan QR with: WhatsApp → Linked Devices → Link a Device\n');
            QRCode.generate(qr, { small: true });
            console.log('\n⏳ Waiting for scan...\n');
        }

        if (connection === 'open') {
            console.log(`✅ Connected! Logged in as: ${sock.user?.id?.user}`);
        }

        if (connection === 'close') {
            const status = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode : 401;

            if (status === DisconnectReason.loggedOut) {
                console.log('❌ Logged out. Delete auth/ and restart.');
                process.exit(0);
            } else {
                console.log(`⚠️ Disconnected (${status}). Reconnecting in 5s...`);
                setTimeout(startBot, 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const text = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || '[media/other]';

            console.log(`\n[${msg.key.remoteJid}]: ${text}`);
        }
    });
}

process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
console.log('🚀 Starting WhatsApp Bot...\n');
startBot().catch(console.error);
```

### 4. Authenticate (One-Time Setup)

```bash
node bot.js
```

You should see a QR code. Scan it with your phone. Once connected, press `Ctrl+C` to stop. The session is saved in `auth/` — you don't need `bot.js` running to send messages.

**⚠️ IMPORTANT: Do NOT run `bot.js` and `send.js` at the same time!** They share the same `auth/` folder and WhatsApp will kick one off with a `conflict: replaced` error.

**Two workflows — pick one:**

| Workflow | When to Use |
|----------|------------|
| **A. Persistent bot** | Run `bot.js` in tmux forever. It receives messages and you send via stdin/HTTP. |
| **B. On-demand sender** | Auth once with `bot.js` → stop it. Then only run `send.js` when you need to send. |

**⚠️ Phone number format:** digits only, with country code, NO `+` or spaces.
- ✅ `"85252758251"` — correct
- ❌ `"+852 5275 8251"` — will fail
- ❌ `"852-5275-8251"` — will fail

---

## Pairing Code Method (No QR Needed)

If QR code doesn't show or you're on a headless server, use **pairing code** instead:

Create `bot-pair.js`:

```javascript
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, 'auth');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Request pairing code if not registered
    if (!sock.authState.creds.registered) {
        const phoneNumber = 'YOUR_NUMBER_HERE';  // e.g. '1234567890' — with country code, no +
        const code = await sock.requestPairingCode(phoneNumber);

        console.log('\n========================================');
        console.log('📱 PAIRING CODE (Enter in WhatsApp):');
        console.log('========================================');
        console.log(`   ${code}`);
        console.log('========================================');
        console.log('\nPhone: WhatsApp → Linked Devices → Link a Device');
        console.log('→ Instead of scanning QR, type the code above\n');
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('✅ Connected!');
        }

        if (connection === 'close') {
            const status = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode : 401;

            if (status !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 5000);
            } else {
                console.log('❌ Logged out. Delete auth/ and restart.');
                process.exit(0);
            }
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[media]';
            console.log(`[${msg.key.remoteJid}]: ${text}`);
        }
    });
}

startBot().catch(console.error);
```

**How to use pairing code:**
1. Replace `YOUR_NUMBER_HERE` with your WhatsApp number (country code, no `+`)
2. Run `node bot-pair.js`
3. A code like `123-456` prints to terminal
4. On phone: WhatsApp → Linked Devices → Link a Device → enter the code

---

## Send Messages (Standalone)

Create `send.js`:

```javascript
const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth');

async function sendMessage(phone, message) {
    const { version } = await fetchLatestBaileysVersion();
    const { state } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({ version, auth: state });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') {
                clearTimeout(timeout);
                resolve();
            } else if (update.qr) {
                clearTimeout(timeout);
                reject(new Error('Not authenticated — run bot.js first'));
            } else if (update.connection === 'close') {
                clearTimeout(timeout);
                reject(new Error('Connection failed'));
            }
        });
    });

    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Sent to ${phone}`);

    sock.end('Done');
    process.exit(0);
}

const phone = process.argv[2];
const message = process.argv[3];

if (!phone || !message) {
    console.log('Usage: node send.js <PHONE> "<MESSAGE>"');
    console.log('Example: node send.js "85252758251" "Hello!"');
    process.exit(1);
}

// Strip +, spaces, dashes — digits only
const cleanPhone = phone.replace(/[^0-9]/g, '');

sendMessage(cleanPhone, message).catch(console.error);
```

**Run:**
```bash
node send.js "85252758251" "Hello from Python!"
# Note: digits only, no + or spaces
```

**⚠️ Do NOT have `bot.js` running when you run `send.js`** — they share `auth/` and WhatsApp will kick one off with `conflict: replaced`.

---

## Call from Python

```python
import subprocess
import re

def send_whatsapp(phone, message):
    # Clean phone number — strip +, spaces, dashes
    clean_phone = re.sub(r'[^0-9]', '', phone)

    cmd = ['node', '/path/to/whatsapp-bot/send.js', clean_phone, message]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        print(f"✅ {result.stdout.strip()}")
        return True
    print(f"❌ {result.stderr.strip()}")
    return False

# Works with any format:
send_whatsapp("+852 5275 8251", "Hello from Python!")
send_whatsapp("85252758251", "Hello from Python!")
```

---

## Running on Headless Linux Server

### tmux (recommended)

```bash
tmux new -s whatsapp
cd ~/whatsapp-bot
node bot.js
# Detach: Ctrl+B then D
# Re-attach: tmux attach -t whatsapp
```

### PM2 (auto-restart)

```bash
npm install -g pm2
pm2 start bot.js --name whatsapp-bot
pm2 logs whatsapp-bot
pm2 save && pm2 startup
```

---

## Session Persistence

| Event | What Happens |
|-------|-------------|
| **First run** | QR or pairing code required → session saved to `auth/` |
| **Subsequent runs** | Auto-login from `auth/` — no QR needed |
| **After ~7 days** | WhatsApp may require re-scan |
| **Logged out** | Delete `auth/` folder, restart to re-authenticate |

```bash
# Force re-auth
rm -rf auth/
node bot.js
```

---

## Troubleshooting

### "conflict: replaced" / Stream Errored

```
Error: Stream Errored (conflict)
reasonNode: { tag: "conflict", attrs: { type: "replaced" } }
```

**Cause:** Two Baileys instances running with the same `auth/` folder. WhatsApp allows only one active connection per session.

**Fix:** Close `bot.js` before running `send.js`. Or vice versa. Never run both at the same time.

### QR code not showing?

```bash
# 1. Verify qrcode-terminal is installed
npm ls qrcode-terminal

# 2. If missing, install it
npm install qrcode-terminal

# 3. Use pairing code method instead (bot-pair.js above)
```

### "Invalid session" / "Logged out"

```bash
rm -rf auth/
node bot.js
# Re-authenticate
```

### Common Error Codes

| Code | Meaning | Fix |
|------|---------|-----|
| 401 | Logged out | Delete `auth/`, restart |
| 403 | Banned | Use different number |
| 429 | Rate limited | Slow down sending |
| 463 | Restricted | Wait 24h |

---

## References

- Baileys: https://github.com/WhiskeySockets/Baileys
- Baileys Wiki: https://baileys.wiki
- whatsapp-web-reveng: https://github.com/sigalor/whatsapp-web-reveng
