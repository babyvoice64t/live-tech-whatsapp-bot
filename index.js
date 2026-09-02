import makeWASocket, { useMultiFileAuthState, downloadMediaMessage, DisconnectReason, makeCacheableSignalKeyStore, isLidUser } from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'eoriwaaw';
const API_KEY = process.env.CLOUDINARY_API_KEY || '574556244787576';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '6Zz697mbMjQ9HPcxOiFXgKiaM3E';
const AUTH_PASSWORD = process.env.UPLOAD_PASSWORD || 'Live@786';
const VAULT_URL = process.env.VAULT_URL || 'https://live-tech-backup-system.pages.dev';

let qrString = null;
let sock = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT = 50;
let botJid = null; // store bot's own JID

const userState = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DEFAULT_CATS = ['Transaction', 'Purchase Order', 'Invoice', 'Important'];

app.use(express.json());

// â”€â”€â”€ Dashboard â”€â”€â”€
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live Tech Bot</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f4;min-height:100vh;display:grid;place-items:center;padding:16px}
.card{max-width:520px;width:100%;background:#fff;border:1px solid #e4e4e7;border-radius:24px;padding:32px;box-shadow:0 8px 32px rgba(0,0,0,.06)}
h1{font-size:20px;font-weight:800;letter-spacing:-.02em}
.sub{font-size:12px;color:#71717a;margin-top:4px;font-family:monospace}
.qr-box{margin:20px 0;min-height:280px;border-radius:16px;background:#fafafa;border:1.5px dashed #d4d4d8;display:grid;place-items:center;padding:16px;text-align:center;transition:all .2s}
.qr-box img{width:240px;height:240px;border-radius:12px;border:1px solid #e4e4e7}
.ok{color:#16a34a;font-weight:700;font-size:15px}.wait{color:#a1a1aa;font-size:13px}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.btn{flex:1;min-width:100px;height:40px;border-radius:999px;border:1.5px solid #e4e4e7;background:#fff;font-weight:600;font-size:12px;cursor:pointer;transition:all .15s}
.btn:hover{background:#f5f5f4}.btn-g{background:#0E4D2A;color:#fff;border-color:#0E4D2A}.btn-g:hover{background:#0c3d21}
.btn-r{background:#fef2f2;color:#dc2626;border-color:#fecaca}.btn-r:hover{background:#fee2e2}
.stats{margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat{padding:12px;border-radius:12px;background:#fafafa;border:1px solid #f0f0f0;text-align:center}
.stat .label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#a1a1aa;font-weight:600}
.stat .val{font-size:16px;font-weight:800;margin-top:2px}
.msg{margin-top:16px;padding:12px;border-radius:12px;background:#fafafa;border:1px solid #f0f0f0;font-size:12px;color:#52525b;line-height:1.6;font-family:monospace}</style></head>
<body><div class="card">
<h1>Live Tech WhatsApp Bot</h1>
<div class="sub">Vault: <a href="${VAULT_URL}" target="_blank" style="color:#0E4D2A;text-decoration:none">${VAULT_URL}</a></div>
<div class="qr-box" id="qrBox"><span class="wait">Loading...</span></div>
<div class="btns">
<button class="btn btn-g" onclick="location.reload()">Refresh</button>
<button class="btn btn-r" onclick="doDisconnect()">Disconnect</button>
<button class="btn" onclick="doReconnect()">Reconnect</button>
</div>
<div class="stats">
<div class="stat"><div class="label">Status</div><div class="val" id="stConn">â€”</div></div>
<div class="stat"><div class="label">Users</div><div class="val" id="stUsers">0</div></div>
</div>
<div class="msg">Flow: msg â†’ password â†’ file â†’ category number â†’ upload â†’ link<br>
Commands: <b>help</b> Â· <b>list</b> Â· <b>logout</b><br>
No password hints Â· Anti-block 1s delay Â· Persistent session</div>
</div>
<script>
async function poll(){try{const r=await fetch('/qr');const j=await r.json();
document.getElementById('stConn').textContent=j.connected?'Connected':'Disconnected';
document.getElementById('stConn').style.color=j.connected?'#16a34a':'#dc2626';
if(j.qr){document.getElementById('qrBox').innerHTML='<img src="'+j.qr+'">'}
else if(j.connected){document.getElementById('qrBox').innerHTML='<span class="ok">Connected â€” send a file to test</span>'}
else{document.getElementById('qrBox').innerHTML='<span class="wait">Waiting for QR...</span>'}}catch(e){}}
async function doDisconnect(){if(!confirm('Disconnect?'))return;const p=prompt('Password:');if(!p)return;
await fetch('/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
location.reload()}
async function doReconnect(){const p=prompt('Password:');if(!p)return;
await fetch('/reconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
location.reload()}
poll();setInterval(poll,3000);
</script></body></html>`);
});

function checkAuth(req) {
  const pass = req.query.password || req.headers['x-password'] || req.body?.password || '';
  return pass === AUTH_PASSWORD;
}

app.get('/qr', async (req, res) => {
  let qrDataUrl = null;
  if (qrString) { try { qrDataUrl = await QRCode.toDataURL(qrString); } catch {} }
  res.json({ qr: qrDataUrl, connected: isConnected });
});

app.get('/health', (req, res) => res.json({ ok: true, connected: isConnected, users: userState.size }));

app.get('/debug', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const users = [];
  userState.forEach((v, k) => users.push({ jid: k, loggedIn: v.loggedIn, hasPending: !!v.pendingFile, attempts: v.attempts }));
  res.json({ connected: isConnected, hasSock: !!sock, users, qrPresent: !!qrString });
});

app.get('/api/stats', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  let loggedIn = 0;
  userState.forEach(s => { if (s.loggedIn) loggedIn++; });
  res.json({ connected: isConnected, totalUsers: userState.size, loggedInUsers: loggedIn });
});

app.post('/disconnect', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'wrong password' });
  try { await sock?.logout(); } catch {}
  isConnected = false; qrString = null;
  try { fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

app.post('/reconnect', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'wrong password' });
  isConnected = false; qrString = null;
  try { sock?.end?.(undefined); } catch {}
  reconnectAttempts = 0;
  setTimeout(() => startBot(), 1000);
  res.json({ ok: true });
});

// â”€â”€â”€ Cloudinary Upload â”€â”€â”€
async function uploadToCloudinary(buffer, filename, category) {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `live-tech-backup/${category}`;
  const params = { folder, timestamp, use_filename: 'true', unique_filename: 'true' };
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + API_SECRET).digest('hex');
  const FormData = (await import('form-data')).default;
  const fd = new FormData();
  fd.append('file', buffer, { filename });
  fd.append('api_key', API_KEY);
  fd.append('timestamp', String(timestamp));
  fd.append('signature', signature);
  fd.append('folder', folder);
  fd.append('use_filename', 'true');
  fd.append('unique_filename', 'true');
  const resp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`, { method: 'POST', body: fd });
  const out = await resp.json();
  if (!resp.ok) throw new Error(out.error?.message || 'cloudinary failed');
  return out;
}

function getState(jid) {
  if (!userState.has(jid)) userState.set(jid, { loggedIn: false, attempts: 0, pendingFile: null, lastCat: null });
  return userState.get(jid);
}

function catMenu() {
  let lines = ['ðŸ“‚ *Category choose karo:*\n'];
  DEFAULT_CATS.forEach((c, i) => lines.push(`  *${i + 1}.* ${c}`));
  lines.push(`  *${DEFAULT_CATS.length + 1}.* New Category (apna naam likho)`);
  lines.push(`\nNumber bhejo ya naam likho â€” jaise *1* ya *Invoice*`);
  return lines.join('\n');
}

async function sendCatMenu(jid) {
  await sock.sendMessage(jid, { text: catMenu() });
}

function cleanText(t) {
  return (t || '').replace(/[""''Â«Â»]/g, '').trim();
}

// Resolve LID to PN (phone number JID) - only if needed
async function resolveJid(jid) {
  if (!jid) return jid;
  if (!jid.endsWith('@lid')) return jid; // already PN
  // In Baileys v7, sendMessage works with both LID and PN
  // But if we want to try PN for better compatibility:
  try {
    if (sock.signalRepository?.lidMapping?.getPNForLID) {
      const pnJid = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pnJid) {
        console.log(`ðŸ”€ LID resolved: ${jid} â†’ ${pnJid}`);
        return pnJid;
      }
    }
  } catch (e) {
    console.log(`âš ï¸ LID resolve skipped: ${e.message}`);
  }
  return jid; // Use LID directly - v7 supports it
}

// Safe send with LID resolution
async function safeSend(jid, content) {
  const resolved = await resolveJid(jid);
  try {
    const result = await sock.sendMessage(resolved, content);
    console.log(`âœ… Sent to ${resolved}: ok=${!!result}`);
    return result;
  } catch (err) {
    console.error(`âŒ Send failed to ${resolved}: ${err.message}`);
    // If resolved PN failed, try original LID
    if (resolved !== jid) {
      try {
        const result2 = await sock.sendMessage(jid, content);
        console.log(`âœ… Sent to original ${jid}: ok=${!!result2}`);
        return result2;
      } catch (err2) {
        console.error(`âŒ Original also failed: ${err2.message}`);
      }
    }
    throw err;
  }
}

// â”€â”€â”€ Bot Start â”€â”€â”€
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'warn' })),
    },
    logger: pino({ level: 'warn' }),
    printQRInTerminal: false,
    browser: ['Live Tech', 'Safari', '3.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async () => undefined,
    retryRequestDelayMs: 2000,
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 25000,
    generateHighQualityLinkPreview: false,
    optionalCaptureConnectNotify: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Cache LID mappings as they come in
  sock.ev.on('lid-mapping.update', (mapping) => {
    console.log('ðŸ“‹ LID mapping update:', JSON.stringify(mapping));
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { qrString = qr; reconnectAttempts = 0; }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut || code === 401;
      isConnected = false;

      if (loggedOut) {
        qrString = null;
        try { fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true }); } catch {}
        console.log('ðŸ”´ Logged out â€” need QR scan');
      } else {
        reconnectAttempts++;
        const delay = Math.min(reconnectAttempts * 2000, 60000);
        console.log(`ðŸ”„ Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
        setTimeout(startBot, delay);
      }
    } else if (connection === 'open') {
      isConnected = true;
      reconnectAttempts = 0;
      console.log('âœ… Connected');
    }
  });

  // â”€â”€â”€ Message Handler â”€â”€â”€
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`ðŸ“¨ messages.upsert: type=${type}, count=${messages.length}`);
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) { console.log('â­ï¸ skip: no message or fromMe'); continue; }
        console.log(`ðŸ“© from=${msg.key.remoteJid}, type=${Object.keys(msg.message)[0] || 'unknown'}`);
        const jid = msg.key.remoteJid;
        const state = getState(jid);

        // Extract text from any message type
        const text = cleanText(
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.documentMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
          msg.message.buttonsResponseMessage?.selectedButtonId ||
          ''
        );
        const lower = text.toLowerCase();

        // Safe anti-block delay
        await sleep(1000);

        // â”€â”€â”€ Number reply (for category selection) â”€â”€â”€
        if (/^\d+$/.test(text) && state.pendingFile) {
          const num = parseInt(text);
          if (num >= 1 && num <= DEFAULT_CATS.length) {
            const cat = DEFAULT_CATS[num - 1];
            try {
              await safeSend(jid, { text: `â³ *${cat}* me save ho raha hai...` });
              const out = await uploadToCloudinary(state.pendingFile.buffer, state.pendingFile.filename, cat);
              await safeSend(jid, {
                text: `âœ… Done!\nðŸ“‚ Category: *${cat}*\nðŸ“„ ${state.pendingFile.filename}\nðŸ”— ${out.secure_url}\n\nVault: ${VAULT_URL}`
              });
              state.pendingFile = null;
            } catch (e) {
              await safeSend(jid, { text: `âŒ Upload failed: ${e.message}` });
            }
          } else if (num === DEFAULT_CATS.length + 1) {
            await safeSend(jid, { text: `ðŸ“ Nayi category ka naam likh ke bhejo (jaise: *My Files*)` });
          } else {
            await safeSend(jid, { text: `âš ï¸ Galat number. 1-${DEFAULT_CATS.length + 1} tak choose karo.` });
          }
          continue;
        }

        // â”€â”€â”€ Password check â”€â”€â”€
        if (!state.loggedIn) {
          const isPass = lower === AUTH_PASSWORD.toLowerCase() || lower === `login ${AUTH_PASSWORD.toLowerCase()}` || lower === `password ${AUTH_PASSWORD.toLowerCase()}`;
          if (isPass) {
            state.loggedIn = true; state.attempts = 0;
            await safeSend(jid, {
              text: `âœ… *Login ho gaya!*\n\nAb file bhejo (image, PDF, video, document).\n\nBhejne ke baad category choose karni hogi.\n\nCommands: *help* Â· *list* Â· *logout*\nVault: ${VAULT_URL}`
            });
            continue;
          }

          // Welcome on first message
          if (['hi', 'hello', 'start', 'help', 'start', 'hey'].includes(lower)) {
            await safeSend(jid, {
              text: `*Live Tech Backup Bot*\n\nFile bhejne ke liye pehle password lagta hai.\n\nPassword bhejo to access mil jayega.`
            });
            continue;
          }

          // Wrong password
          state.attempts = (state.attempts || 0) + 1;
          if (state.attempts >= 5) {
            await safeSend(jid, { text: `âš ï¸ 5 galat tries. Thodi der baad try karo.` });
            setTimeout(() => { state.attempts = 0; }, 15 * 60 * 1000);
          } else {
            await safeSend(jid, { text: `ðŸ”’ Password galat hai. Dobara bhejo.` });
          }
          continue;
        }

        // â”€â”€â”€ Logged in commands â”€â”€â”€
        if (lower === 'help' || lower === '?') {
          await safeSend(jid, {
            text: `*Help*\n\n1. File bhejo (image/PDF/video)\n2. Category number choose karo\n3. Upload ho jayega + link milega\n\nCommands:\n*help* â€” ye message\n*list* â€” vault link\n*logout* â€” logout`
          });
          continue;
        }
        if (lower === 'list') {
          await safeSend(jid, { text: `ðŸ“‚ Vault: ${VAULT_URL}\n\nCategories: ${DEFAULT_CATS.join(' Â· ')}` });
          continue;
        }
        if (lower === 'logout') {
          state.loggedIn = false;
          await safeSend(jid, { text: `ðŸ‘‹ Logout ho gaya. Dobara login ke liye password bhejo.` });
          continue;
        }

        // â”€â”€â”€ Custom category name (when pending file) â”€â”€â”€
        if (state.pendingFile && text && !/^\d+$/.test(text)) {
          const catName = text.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30);
          if (catName && !DEFAULT_CATS.map(c => c.toLowerCase()).includes(catName.toLowerCase())) {
            try {
              await safeSend(jid, { text: `â³ *${catName}* me save ho raha hai...` });
              const out = await uploadToCloudinary(state.pendingFile.buffer, state.pendingFile.filename, catName);
              await safeSend(jid, {
                text: `âœ… Done!\nðŸ“‚ Category: *${catName}*\nðŸ“„ ${state.pendingFile.filename}\nðŸ”— ${out.secure_url}\n\nVault: ${VAULT_URL}`
              });
              state.pendingFile = null;
            } catch (e) {
              await safeSend(jid, { text: `âŒ Upload failed: ${e.message}` });
            }
            continue;
          }
        }

        // â”€â”€â”€ Handle media â”€â”€â”€
        const isImage = !!msg.message.imageMessage;
        const isDoc = !!msg.message.documentMessage;
        const isVideo = !!msg.message.videoMessage;

        if (isImage || isDoc || isVideo) {
          // Check caption for category
          const caption = cleanText(msg.message.imageMessage?.caption || msg.message.documentMessage?.caption || '');
          const captionLower = caption.toLowerCase();
          let captionCat = null;
          for (const c of DEFAULT_CATS) {
            if (captionLower.includes(c.toLowerCase())) { captionCat = c; break; }
          }

          if (captionCat) {
            // Direct upload with caption category
            try {
              await safeSend(jid, { text: `â³ *${captionCat}* me save ho raha hai...` });
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
              let filename = msg.message.imageMessage?.caption?.split('\n')[0] || msg.message.documentMessage?.fileName || `file-${Date.now()}`;
              if (!filename.includes('.')) { if (isImage) filename += '.jpg'; else if (isDoc) filename += '.pdf'; else filename += '.bin'; }
              filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
              const out = await uploadToCloudinary(buffer, filename, captionCat);
              await safeSend(jid, {
                text: `âœ… Done!\nðŸ“‚ Category: *${captionCat}*\nðŸ“„ ${filename}\nðŸ”— ${out.secure_url}\n\nVault: ${VAULT_URL}`
              });
            } catch (e) {
              await safeSend(jid, { text: `âŒ Upload failed: ${e.message}` });
            }
          } else {
            // No category â€” store file and show menu
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
              let filename = msg.message.documentMessage?.fileName || `file-${Date.now()}`;
              if (!filename.includes('.') && isImage) filename += '.jpg';
              filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
              state.pendingFile = { buffer, filename };
              await safeSend(jid, { text: `ðŸ“Ž *${filename}* ready hai\n\n` + catMenu() });
            } catch (e) {
              await safeSend(jid, { text: `âŒ File read failed: ${e.message}` });
            }
          }
          continue;
        }

        // â”€â”€â”€ Plain text category name (without file) â”€â”€â”€
        const foundCat = DEFAULT_CATS.find(c => c.toLowerCase() === lower);
        if (foundCat) {
          await safeSend(jid, { text: `ðŸ“‚ *${foundCat}* select hui. Ab is category me file bhejo.` });
          state.lastCat = foundCat;
          continue;
        }

      } catch (err) {
        console.error('Handler error:', err.message);
        try { await safeSend(msg.key.remoteJid, { text: `âŒ Error: ${err.message}` }); } catch {}
      }
    }
  });
}

// â”€â”€â”€ Server â”€â”€â”€
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
  startBot();
});
