const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const multer = require('multer');

const AUTH_DIR = path.join(__dirname, 'auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
const OUTBOX_DIR = path.join(__dirname, 'outbox');
if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });
const QUEUE_DIR = path.join(__dirname, 'queue');
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });

// ─── Anti-ban configuration (env-overridable) ──────────────────
// Every outgoing message goes through a FILE-BACKED queue (survives
// restarts). The first message in the queue is sent after a short 1-2s
// jitter; every subsequent message waits a RANDOM 1-3 minutes. This
// pacing is the primary anti-ban mechanism (it replaces the old
// 5-sends/sec sliding window, which is meaningless at this cadence).
const QUEUE_INTERVAL_MIN_MS = parseInt(process.env.WHATSAPP_QUEUE_INTERVAL_MIN_MS || '60000', 10);
const QUEUE_INTERVAL_MAX_MS = parseInt(process.env.WHATSAPP_QUEUE_INTERVAL_MAX_MS || '180000', 10);
// The WebSocket to the WhatsApp server is CLOSED after this much time with
// no message activity (send or receive) and reopened automatically on the
// next send request. Reduces the "always-online linked device" footprint
// that automation detection looks for.
const IDLE_TIMEOUT_MS = parseInt(process.env.WHATSAPP_IDLE_TIMEOUT_MS || '300000', 10);
const QUEUE_FILE = path.join(QUEUE_DIR, 'pending.jsonl');

// ─── Outgoing send queue (file-backed, JSONL) ──────────────────
function loadQueue() {
    try {
        return fs.readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}
function writeQueue(items) {
    const tmp = QUEUE_FILE + '.tmp';
    fs.writeFileSync(tmp, items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
    fs.renameSync(tmp, QUEUE_FILE);
}
let sendQueue = loadQueue();
if (sendQueue.length) console.log(`[QUEUE] Restored ${sendQueue.length} pending message(s) from disk`);

function enqueueItem(item) {
    item.id = crypto.randomBytes(6).toString('hex');
    item.ts = Date.now();
    item.attempts = 0;
    item.nextRetryAt = 0;
    sendQueue.push(item);
    writeQueue(sendQueue);
    return item;
}
function popQueueItem() {
    const item = sendQueue.shift();
    writeQueue(sendQueue);
    return item;
}

// ─── Incoming message queue (in-memory, 24h TTL) ───────────────
const messageQueue = [];
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

function pruneQueue() {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    while (messageQueue.length && messageQueue[0].ts < cutoff) {
        messageQueue.shift();
    }
}

// ─── Helpers ────────────────────────────────────────────────────
function randomDelay(minMs, maxMs) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}
function randMs(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
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
};

function detectMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_MAP[ext] || 'application/octet-stream';
}

// ─── Connection state machine ──────────────────────────────────
// state: 'disconnected' | 'connecting' | 'connected' | 'idle_offline'
let sock = null;
let state = 'disconnected';
let connected = false;        // kept for /status backward compat
let intentionalClose = false; // set before a deliberate sock.end() (idle/manual)
let lastActivityAt = Date.now();

function waitForOpen(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        (function poll() {
            if (state === 'connected') return resolve();
            if (Date.now() >= deadline) return reject(new Error('Timed out waiting for WhatsApp connection (QR pending?)'));
            setTimeout(poll, 250);
        })();
    });
}

async function ensureConnected(timeoutMs = 30000) {
    if (state === 'connected') return;
    if (state !== 'connecting') {
        intentionalClose = false;
        await startBot();
    }
    if (state === 'connected') return;
    await waitForOpen(timeoutMs);
}

async function startBot() {
    if (state === 'connecting' || state === 'connected') return;
    state = 'connecting';
    console.log('🔌 Connecting to WhatsApp...');
    try {
        const { version } = await fetchLatestBaileysVersion();
        if (state !== 'connecting') return;
        console.log(`Using WhatsApp Web v${version.join('.')}`);

        const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        if (state !== 'connecting') return;

        sock = makeWASocket({ version, auth: authState, printQRInTerminal: false });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n📱 Scan QR: WhatsApp → Linked Devices → Link a Device\n');
                QRCode.generate(qr, { small: true });
                console.log('\n⏳ Waiting for scan...\n');
            }

            if (connection === 'connecting') {
                state = 'connecting';
            }

            if (connection === 'open') {
                state = 'connected';
                connected = true;
                lastActivityAt = Date.now();
                console.log('✅ Connected! Bot ready — HTTP API is live\n');
            }

            if (connection === 'close') {
                connected = false;
                if (intentionalClose) {
                    // Idle/manual sleep — do NOT auto-reconnect. The socket
                    // comes back on the next send request (or POST /connect).
                    intentionalClose = false;
                    state = 'idle_offline';
                    sock = null;
                    console.log('[IDLE] WebSocket closed — turns back on with the next send request');
                    return;
                }
                state = 'disconnected';
                const status = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output.statusCode : 401;
                if (status === DisconnectReason.loggedOut) {
                    console.log('❌ Logged out. Delete auth/ and restart.');
                    process.exit(0);
                } else {
                    console.log(`⚠️ Disconnected (${status}). Reconnecting in 5s...`);
                    setTimeout(() => startBot().catch(e => console.error('[RECONNECT] failed:', e.message)), 5000);
                }
            }
        });

        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;
            lastActivityAt = Date.now(); // receiving counts as activity
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
    } catch (err) {
        state = 'disconnected';
        console.error('[BOOT] failed to start:', err.message);
        setTimeout(() => startBot().catch(() => {}), 10000);
    }
}

// ─── Idle watcher: close the WebSocket after N ms of inactivity ─
setInterval(() => {
    if (state !== 'connected' || sendQueue.length > 0 || workerBusy) return;
    const idleFor = Date.now() - lastActivityAt;
    if (idleFor >= IDLE_TIMEOUT_MS) {
        console.log(`[IDLE] No message activity for ${Math.round(idleFor / 1000)}s — closing WebSocket`);
        intentionalClose = true;
        state = 'idle_offline';
        try { sock.end(); } catch (e) { console.error('[IDLE] end failed:', e.message); }
    }
}, 10000);

// ─── Send worker: paces the queue (1-3 min between messages) ───
let workerBusy = false;
let nextSendAt = 0; // earliest time the next queued message may be sent

setInterval(async () => {
    if (workerBusy || sendQueue.length === 0) return;
    const item = sendQueue[0];
    if (item.nextRetryAt && Date.now() < item.nextRetryAt) return;
    if (nextSendAt && Date.now() < nextSendAt) return;
    workerBusy = true;
    try {
        // Wake the socket if it's idle-offline (or reconnect if dropped)
        await ensureConnected(30000);
        if (state !== 'connected') return; // will retry on next tick

        const popped = popQueueItem();

        // Short human-ish jitter, then build content (media read from disk)
        await randomDelay(1000, 2000);
        let content;
        if (popped.type === 'file') {
            if (!fs.existsSync(popped.filePath)) throw new Error(`Queued file missing: ${popped.filePath}`);
            const buffer = fs.readFileSync(popped.filePath);
            if (popped.mediaType === 'image') {
                content = { image: buffer, caption: popped.caption || '' };
            } else if (popped.mediaType === 'video') {
                content = { video: buffer, caption: popped.caption || '', gifPlayback: false };
            } else if (popped.mediaType === 'audio') {
                content = { audio: buffer, ptt: !!popped.ptt };
            } else {
                content = {
                    document: buffer,
                    mimetype: popped.mimetype || 'application/octet-stream',
                    fileName: popped.fileName || 'file',
                    caption: popped.caption || ''
                };
            }
        } else {
            content = { text: popped.message };
        }

        await sock.sendMessage(popped.jid, content);
        lastActivityAt = Date.now();
        nextSendAt = Date.now() + randMs(QUEUE_INTERVAL_MIN_MS, QUEUE_INTERVAL_MAX_MS);
        if (popped.queueFile) { try { fs.unlinkSync(popped.queueFile); } catch {} }
        console.log(`[SEND OK] ${popped.type || 'text'} → ${popped.phone} (id=${popped.id}) — next send no earlier than ${new Date(nextSendAt).toISOString()}`);
    } catch (err) {
        item.attempts += 1;
        console.error(`[QUEUE] send failed (id=${item.id}, attempt ${item.attempts}/3):`, err.message);
        if (item.attempts >= 3) {
            popQueueItem();
            if (item.queueFile) { try { fs.unlinkSync(item.queueFile); } catch {} }
            console.error(`[QUEUE] Giving up on id=${item.id} after 3 attempts — removed from queue`);
        } else {
            item.nextRetryAt = Date.now() + 60000;
            writeQueue(sendQueue); // persist attempts + retry time
        }
    } finally {
        workerBusy = false;
    }
}, 2000);

// ─── HTTP Server ────────────────────────────────────────────────
// File uploads arrive via multipart/form-data (field: "file").
// The buffer is persisted to outbox/ so queued media survives restarts.
// 16MB cap ≈ WhatsApp Web media limit.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 16 * 1024 * 1024, files: 1 }
});

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

// Validate a parsed /send payload and enqueue it. Throws {status} on bad input.
function enqueueFromParsed(parsed, req) {
    const { phone } = parsed;
    if (!phone) throw Object.assign(new Error('Missing phone'), { status: 400 });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (!cleanPhone) throw Object.assign(new Error('Invalid phone'), { status: 400 });
    const item = { phone: cleanPhone, jid: `${cleanPhone}@s.whatsapp.net` };

    if (parsed.type === 'file') {
        const { mediaType, caption, mimetype, fileName, ptt } = parsed;
        if (req.file) {
            // multipart upload — persist buffer so it survives a bot restart
            const ext = path.extname(req.file.originalname || fileName || '') || '.bin';
            const queueFile = path.join(OUTBOX_DIR, `queue-${crypto.randomBytes(6).toString('hex')}${ext}`);
            fs.writeFileSync(queueFile, req.file.buffer);
            Object.assign(item, {
                type: 'file', filePath: queueFile, queueFile,
                mediaType: mediaType || 'document',
                caption: caption || '',
                mimetype: mimetype || req.file.mimetype,
                fileName: fileName || req.file.originalname || 'file',
                ptt: ptt === 'true' || ptt === true
            });
        } else {
            // Legacy: file lives on disk (absolute path or relative to outbox/)
            const { filePath } = parsed;
            if (!filePath) throw Object.assign(new Error('Missing file — upload a "file" field or pass filePath'), { status: 400 });
            const fullPath = path.isAbsolute(filePath) ? filePath : path.join(OUTBOX_DIR, filePath);
            if (!fs.existsSync(fullPath)) throw Object.assign(new Error(`File not found: ${fullPath}`), { status: 404 });
            Object.assign(item, {
                type: 'file', filePath: fullPath,
                mediaType: mediaType || 'document',
                caption: caption || '',
                mimetype: mimetype || detectMimeType(fullPath),
                fileName: fileName || path.basename(fullPath),
                ptt: !!ptt
            });
        }
    } else {
        if (!parsed.message) throw Object.assign(new Error('Missing message'), { status: 400 });
        Object.assign(item, { type: 'text', message: parsed.message });
    }
    return enqueueItem(item);
}

const PORT = parseInt(process.env.WHATSAPP_BOT_PORT || '3100', 10);
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // GET /status
    if (req.method === 'GET' && req.url.startsWith('/status')) {
        sendJson(res, 200, {
            state,
            connected,
            user: sock?.user?.id?.user || (connected ? 'connected' : 'offline'),
            uptime: process.uptime(),
            queue: { pending: sendQueue.length, nextSendAt: nextSendAt || null },
            idle: {
                timeoutMs: IDLE_TIMEOUT_MS,
                lastActivityAt,
                nextOffAt: state === 'connected' ? lastActivityAt + IDLE_TIMEOUT_MS : null
            }
        });
        return;
    }

    // GET /messages?since=<unix_timestamp_ms>
    if (req.method === 'GET' && req.url.startsWith('/messages')) {
        pruneQueue();
        const url = new URL(req.url, 'http://localhost:3000');
        const since = parseFloat(url.searchParams.get('since') || '0');
        const messages = messageQueue.filter(m => m.ts > since);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages, queued: messageQueue.length, since }));
        return;
    }

    // GET /queue — pending outgoing messages + next-send ETA
    if (req.method === 'GET' && req.url.startsWith('/queue')) {
        sendJson(res, 200, {
            pending: sendQueue.map(i => ({
                id: i.id, phone: i.phone, type: i.type, ts: i.ts,
                attempts: i.attempts, nextRetryAt: i.nextRetryAt || null
            })),
            nextSendAt: nextSendAt || null,
            intervalMs: { min: QUEUE_INTERVAL_MIN_MS, max: QUEUE_INTERVAL_MAX_MS }
        });
        return;
    }

    // POST /send — ENQUEUE a message (returns immediately; the worker paces sends)
    if (req.method === 'POST' && req.url === '/send') {
        const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
        const handle = isMultipart ? upload.single('file') : (req, res, cb) => cb();
        handle(req, res, (err) => {
            if (err) {
                sendJson(res, 400, { error: `Upload error: ${err.message}` });
                return;
            }
            try {
                if (isMultipart) {
                    const item = enqueueFromParsed(Object.assign({}, req.body, { type: 'file' }), req);
                    const position = sendQueue.length;
                    console.log(`[QUEUE] +${item.type || 'text'} → ${item.phone} (id=${item.id}, position=${position})`);
                    sendJson(res, 202, { queued: true, id: item.id, position, note: 'sent with 1-3 min intervals; see GET /queue' });
                } else {
                    let body = '';
                    req.on('data', chunk => { body += chunk; });
                    req.on('end', () => {
                        try {
                            const parsed = JSON.parse(body);
                            const item = enqueueFromParsed(parsed, req);
                            const position = sendQueue.length;
                            console.log(`[QUEUE] +${item.type || 'text'} → ${item.phone} (id=${item.id}, position=${position})`);
                            sendJson(res, 202, { queued: true, id: item.id, position, note: 'sent with 1-3 min intervals; see GET /queue' });
                        } catch (e) {
                            sendJson(res, e.status || 400, { error: e.message });
                        }
                    });
                }
            } catch (e) {
                sendJson(res, e.status || 500, { error: e.message });
            }
        });
        return;
    }

    // POST /connect — wake the WebSocket now (manual)
    if (req.method === 'POST' && req.url === '/connect') {
        if (state === 'connected') { sendJson(res, 200, { state }); return; }
        try {
            await ensureConnected(30000);
            sendJson(res, 200, { state });
        } catch (e) {
            sendJson(res, 503, { error: e.message, state });
        }
        return;
    }

    // POST /disconnect — sleep the WebSocket now (manual)
    if (req.method === 'POST' && req.url === '/disconnect') {
        if (state !== 'connected') { sendJson(res, 200, { state, error: 'not connected' }); return; }
        if (sendQueue.length > 0) { sendJson(res, 409, { error: 'send queue not empty' }); return; }
        intentionalClose = true;
        state = 'idle_offline';
        try { sock.end(); } catch (e) { console.error('[DISCONNECT] end failed:', e.message); }
        sendJson(res, 200, { state: 'idle_offline' });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
    console.log(`🌐 HTTP server: port ${PORT}`);
    console.log('   POST /send       - enqueue text (JSON), file (multipart "file" field), or legacy filePath (JSON) → 202');
    console.log('   GET  /status     - connection + queue + idle state');
    console.log('   GET  /messages   - fetch queued incoming messages?since=<ms>');
    console.log('   GET  /queue      - pending outgoing messages + next-send ETA');
    console.log('   POST /connect    - wake WebSocket now');
    console.log('   POST /disconnect - sleep WebSocket now');
    console.log(`🛡️  Anti-ban: queue interval ${QUEUE_INTERVAL_MIN_MS / 1000}-${QUEUE_INTERVAL_MAX_MS / 1000}s, idle cutoff ${IDLE_TIMEOUT_MS / 1000}s`);
});

process.on('SIGINT', () => {
    console.log('\nShutting down... (send queue persisted in queue/pending.jsonl)');
    server.close();
    process.exit(0);
});
console.log('🚀 Starting WhatsApp Bot...\n');
startBot().catch(console.error);
