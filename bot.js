const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');

const AUTH_DIR = path.join(__dirname, 'auth');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

const OUTBOX_DIR = path.join(__dirname, 'outbox');
if (!fs.existsSync(OUTBOX_DIR)) {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
}

let sock = null;
let connected = false;

// ─── In-Memory Message Queue (24h TTL) ─────────────────────────
const messageQueue = [];
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function pruneQueue() {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    while (messageQueue.length && messageQueue[0].ts < cutoff) {
        messageQueue.shift();
    }
}

// ─── Rate Limiter (anti-ban) ───────────────────────────────────
// Max 5 sends per 1-second sliding window + random 1-2s jitter
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 5;
const sendTimestamps = [];

function waitForRateLimit() {
    const now = Date.now();
    // Remove timestamps outside the sliding window
    while (sendTimestamps.length && sendTimestamps[0] <= now - RATE_WINDOW_MS) {
        sendTimestamps.shift();
    }
    // If at limit, wait until the oldest entry expires
    if (sendTimestamps.length >= RATE_MAX) {
        const waitTime = sendTimestamps[0] + RATE_WINDOW_MS - now;
        if (waitTime > 0) {
            console.log(`[RATE] Throttled — waiting ${waitTime}ms`);
            return new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    return Promise.resolve();
}

function addSendTimestamp() {
    sendTimestamps.push(Date.now());
}

function randomDelay(minMs, maxMs) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}

// ─── MIME Type Detection ────────────────────────────────────────
const MIME_MAP = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
};

function detectMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_MAP[ext] || 'application/octet-stream';
}

// ─── HTTP Server ────────────────────────────────────────────────
// File uploads arrive via multipart/form-data (field: "file").
// In-memory storage — the buffer lands in req.file.buffer and goes
// straight to Baileys; nothing is written to disk.
// 16MB cap ≈ WhatsApp Web media limit.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 16 * 1024 * 1024, files: 1 }
});

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

const PORT = parseInt(process.env.WHATSAPP_BOT_PORT || '3100', 10);
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // GET /status
    if (req.method === 'GET' && req.url.startsWith('/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connected, user: sock?.user?.id?.user || 'connected', uptime: process.uptime() }));
        return;
    }

    // GET /messages?since=<unix_timestamp_ms>
    if (req.method === 'GET' && req.url.startsWith('/messages')) {
        pruneQueue();
        const url = new URL(req.url, 'http://localhost:3000');
        const since = parseFloat(url.searchParams.get('since') || '0');
        const messages = messageQueue.filter(m => m.ts > since);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            messages,
            queued: messageQueue.length,
            since: since
        }));
        return;
    }

    // POST /send — JSON text, JSON legacy filePath, or multipart file upload
    if (req.method === 'POST' && req.url === '/send') {
        const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
        // JSON path: no-op middleware — must match multer's (req, res, cb) signature
        const handle = isMultipart ? upload.single('file') : (req, res, cb) => cb();
        handle(req, res, (err) => {
            if (err) {
                sendJson(res, 400, { error: `Upload error: ${err.message}` });
                return;
            }
            if (isMultipart) {
                // All other fields (phone, mediaType, caption, ...) arrive as form fields
                const parsed = Object.assign({}, req.body, { type: 'file' });
                processSend(parsed, req, res);
            } else {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', async () => {
                    try {
                        const parsed = JSON.parse(body);
                        await processSend(parsed, req, res);
                    } catch (e) {
                        sendJson(res, 400, { error: 'Invalid JSON body' });
                    }
                });
            }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

// Shared /send logic — runs after the payload is parsed (JSON or multipart)
async function processSend(parsed, req, res) {
    try {
        const { phone } = parsed;
        if (!phone) {
            sendJson(res, 400, { error: 'Missing phone' });
            return;
        }
        if (!sock) {
            sendJson(res, 503, { error: 'Bot not connected' });
            return;
        }
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;

        // Build message content based on type
        let content;
        if (parsed.type === 'file') {
            // Media arrives two ways:
            //  1. multipart/form-data upload  → req.file (preferred, no shared dir)
            //  2. JSON { filePath }           → read from disk (legacy, backward compat)
            const { mediaType, caption, mimetype, fileName, ptt } = parsed;

            let buffer;
            let resolvedName = fileName || 'file';
            let resolvedMime = mimetype;

            if (req.file) {
                // Uploaded over HTTP — use the original filename for display
                buffer = req.file.buffer;
                if (!fileName) resolvedName = req.file.originalname || 'file';
                if (!mimetype) resolvedMime = req.file.mimetype;
            } else {
                // Legacy: file lives on disk (absolute path or relative to outbox/)
                const { filePath } = parsed;
                if (!filePath) {
                    sendJson(res, 400, { error: 'Missing file — upload a "file" field or pass filePath' });
                    return;
                }
                const fullPath = path.isAbsolute(filePath)
                    ? filePath
                    : path.join(OUTBOX_DIR, filePath);
                if (!fs.existsSync(fullPath)) {
                    sendJson(res, 404, { error: `File not found: ${fullPath}` });
                    return;
                }
                buffer = fs.readFileSync(fullPath);
                if (!fileName) resolvedName = path.basename(fullPath);
                if (!mimetype) resolvedMime = detectMimeType(fullPath);
            }

            if (mediaType === 'image') {
                content = { image: buffer, caption: caption || '' };
            } else if (mediaType === 'video') {
                content = { video: buffer, caption: caption || '', gifPlayback: false };
            } else if (mediaType === 'audio') {
                content = { audio: buffer, ptt: !!ptt };
            } else {
                // document (default for file type)
                content = {
                    document: buffer,
                    mimetype: resolvedMime || 'application/octet-stream',
                    fileName: resolvedName,
                    caption: caption || ''
                };
            }
        } else {
            // Text message (backward compatible)
            const { message } = parsed;
            if (!message) {
                sendJson(res, 400, { error: 'Missing message' });
                return;
            }
            content = { text: message };
        }

        // Random 1-2s delay before sending (anti-ban)
        await randomDelay(1000, 2000);

        // Rate limit: max 5 sends/second (sliding window)
        await waitForRateLimit();
        addSendTimestamp();

        await sock.sendMessage(jid, content);
        sendJson(res, 200, { success: true, phone: cleanPhone });
        console.log(`[HTTP] Sent ${parsed.type || 'text'} to ${cleanPhone}`);
    } catch (err) {
        console.error('[HTTP] Send error:', err.message);
        sendJson(res, 500, { error: err.message });
    }
}

server.listen(PORT, () => {
    console.log(`🌐 HTTP server: port ${PORT}`);
    console.log('   POST /send  - text (JSON), file (multipart "file" field), or legacy filePath (JSON)');
    console.log('   GET  /status - check status');
    console.log('   GET  /messages?since=<ms> - fetch queued messages');
});

// ─── WhatsApp Bot ─────────────────────────────────────────────
async function startBot() {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web v${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({ version, auth: state, printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Scan QR: WhatsApp → Linked Devices → Link a Device\n');
            QRCode.generate(qr, { small: true });
            console.log('\n⏳ Waiting for scan...\n');
        }

        if (connection === 'open') {
            connected = true;
            console.log(`✅ Connected!`);
            console.log(`   Bot ready — HTTP API on port ${PORT} is live\n`);
        }

        if (connection === 'close') {
            connected = false;
            const status = lastDisconnect?.error instanceof Boom
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
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[media]';
            const phone = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const msgObj = {
                id: msg.key.id,
                from: msg.key.remoteJid,
                phone,
                text,
                type: msg.message?.conversation ? 'text' : msg.message?.imageMessage ? 'image' : msg.message?.videoMessage ? 'video' : msg.message?.audioMessage ? 'audio' : msg.message?.documentMessage ? 'document' : 'other',
                ts: Date.now(),
                timestamp: msg.messageTimestamp
            };
            messageQueue.push(msgObj);
            console.log(`\n[INCOMING ${phone}]: ${text}`);
        }
    });
}

process.on('SIGINT', () => { console.log('\nShutting down...'); server.close(); process.exit(0); });
console.log('🚀 Starting WhatsApp Bot...\n');
startBot().catch(console.error);
