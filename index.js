import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  isJidBroadcast,
  isLidUser,
  jidNormalizedUser,
  decryptPollVote,
  getAggregateVotesInPollMessage
} from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Boom } from '@hapi/boom';
import { v2 as cloudinary } from 'cloudinary';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'eoriwaaw';
const API_KEY = process.env.CLOUDINARY_API_KEY || '574556244787576';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '6Zz697mbMjQ9HPcxOiFXgKiaM3E';
const AUTH_PASSWORD = process.env.UPLOAD_PASSWORD || 'Live@786';
const VAULT_URL = process.env.VAULT_URL || 'https://live-tech-backup-system.pages.dev';

cloudinary.config({ cloud_name: CLOUD_NAME, api_key: API_KEY, api_secret: API_SECRET });

let qrString = null;
let sock = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT = 50;

const logger = pino({ level: 'silent' });
// Simple in-memory CacheStore per official docs — no external dep needed
function makeSimpleCache(ttlSec = 0) {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); if (ttlSec) setTimeout(() => map.delete(k), ttlSec * 1000); },
    del: (k) => map.delete(k),
    keys: () => [...map.keys()],
  };
}
const msgRetryCounterCache = makeSimpleCache();
const groupCache = makeSimpleCache(5 * 60);
const messageStore = new Map();
const userState = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ponytail: sirf Cloudinary folders = single source, koi hardcoded default nahi, 10min cache
let catCache = { list: [], ts: 0 };
async function getCats() {
  if (Date.now() - catCache.ts < 10 * 60 * 1000) return catCache.list;
  try {
    const r = await cloudinary.api.sub_folders('live-tech-backup', { max_results: 50 });
    catCache = { list: (r.folders || []).map(f => f.name).filter(n => n.toLowerCase() !== 'system'), ts: Date.now() };
  } catch { catCache.ts = Date.now() - 9 * 60 * 1000; } // fail soft, 1min me retry
  return catCache.list;
}
function noteNewCat(name) {
  if (!catCache.list.some(x => x.toLowerCase() === name.toLowerCase())) {
    catCache.list.push(name); catCache.ts = Date.now();
  }
}
const CLIENTS = ['Abdul Rehman Garments','Arif Habib Corporation','Arif Habib Limitd','Arif Habib Limited','BDO','BDO Pakistan','Blue Light Computers','CASH','FESF','Habib Public','Habib Public School','Harmain Jewellers','Harmain Jewelllers','Harmain Jweler','MSN','Maple Pharmaceuticals','Maple pharma','Mega Textiles','Mr.Naseem Baig','Mr.Taha','NCCPL','NRT','NoorulQuran madrsa','Murtaza Jaffrani','S.Ejazuddin & Co.','S.Ejazuddin and Co.','S.Ejazudin & Co.','SSFR','SSFR (PVT) LTD.','SSFR PVT LTD','SSFR PVT. LTD.','Sana Safinaz','Shajar Capital','Meezan Bank','TAJ CORPORATION','Virtuesoft'];

function clientMenuText() {
  let lines=['Client select karo:\n'];
  CLIENTS.forEach((c,i)=> lines.push(`${i+1}. ${c}`));
  lines.push(`\nNumber bhejo (1-${CLIENTS.length}) ya naya client naam likho`);
  return lines.join('\n');
}

function msgKeyId(key) { return `${key.remoteJid}:${key.id}`; }

app.use(express.json());
// CORS for Vault dashboard (Cloudflare Pages calls /api/invoice-meta + /api/invoice)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-password');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Dashboard ───
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live Tech Bot v2</title>
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
<h1>Live Tech WhatsApp Bot <span style="font-size:11px;background:#0E4D2A;color:#fff;padding:2px 8px;border-radius:99px;vertical-align:middle">v2 Official</span></h1>
<div class="sub">Vault: <a href="${VAULT_URL}" target="_blank" style="color:#0E4D2A;text-decoration:none">${VAULT_URL}</a></div>
<div class="qr-box" id="qrBox"><span class="wait">Loading...</span></div>
<div class="btns">
<button class="btn btn-g" onclick="location.reload()">Refresh</button>
<button class="btn btn-r" onclick="doDisconnect()">Disconnect</button>
<button class="btn" onclick="doReconnect()">Reconnect</button>
<button class="btn" onclick="doReset()">Reset Auth</button>
</div>
<div class="stats">
<div class="stat"><div class="label">Status</div><div class="val" id="stConn">—</div></div>
<div class="stat"><div class="label">Users</div><div class="val" id="stUsers">0</div></div>
</div>
<div class="msg">Flow: msg → password → file → category number → upload → link<br>
Commands: <b>help</b> · <b>list</b> · <b>logout</b><br>
No password hints · Anti-block 1s delay · Official Baileys v7</div>
</div>
<script>
async function poll(){try{const r=await fetch('/qr');const j=await r.json();
document.getElementById('stConn').textContent=j.connected?'Connected':'Disconnected';
document.getElementById('stConn').style.color=j.connected?'#16a34a':'#dc2626';
if(j.qr){document.getElementById('qrBox').innerHTML='<img src="'+j.qr+'">'}
else if(j.connected){document.getElementById('qrBox').innerHTML='<span class="ok">✅ Connected — send a file to test</span>'}
else{document.getElementById('qrBox').innerHTML='<span class="wait">Waiting for QR...</span>'}}catch(e){}}
async function doDisconnect(){if(!confirm('Disconnect?'))return;const p=prompt('Password:');if(!p)return;
await fetch('/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
location.reload()}
async function doReconnect(){const p=prompt('Password:');if(!p)return;
await fetch('/reconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
location.reload()}
async function doReset(){if(!confirm('Reset auth? QR will regenerate.'))return;const p=prompt('Password:');if(!p)return;
await fetch('/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
location.reload()}
poll();setInterval(poll,3000);
</script></body></html>`);
});

function verifyVaultToken(tok) {
  try {
    const parts = String(tok || '').split('.');
    if (parts.length !== 2) return false;
    const [exp, hex] = parts;
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    const mine = crypto.createHmac('sha256', AUTH_PASSWORD).update(exp).digest('hex');
    return mine.length === hex.length && crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(hex));
  } catch { return false; }
}
function checkAuth(req) {
  const pass = req.query.password || req.headers['x-password'] || req.body?.password || '';
  return pass === AUTH_PASSWORD || verifyVaultToken(pass);
}
// ponytail: WhatsApp shares me direct Cloudinary link nahi — vault proxy + 30d file-token
function fileToken(pid, days = 30) {
  const exp = String(Date.now() + days * 86400 * 1000);
  const sig = crypto.createHmac('sha256', AUTH_PASSWORD).update(`file:${pid}:${exp}`).digest('hex');
  return `f.${exp}.${sig}`;
}
function vaultFileLink(pid, rt) {
  return `${VAULT_URL}/api/file?id=${encodeURIComponent(pid)}&rt=${rt || 'raw'}&token=${fileToken(pid)}`;
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
  userState.forEach((v, k) => users.push({ jid: k, loggedIn: v.loggedIn, hasPending: (v.pendingQueue || []).length, attempts: v.attempts }));
  res.json({ connected: isConnected, hasSock: !!sock, users, qrPresent: !!qrString });
});

app.get('/api/stats', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  let loggedIn = 0;
  userState.forEach(s => { if (s.loggedIn) loggedIn++; });
  res.json({ connected: isConnected, totalUsers: userState.size, loggedInUsers: loggedIn });
});

// Categories for Vault dashboard — Cloudinary folders = single source (auto-sync)
app.get('/api/categories', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ categories: await getCats() });
});

// Poll categories for Vault admin — admin portal se set, WhatsApp poll wahi dikhega
app.get('/api/poll-config', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ categories: await loadPollConfig() });
});
app.post('/api/poll-config', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const cats = req.body?.categories;
    if (!Array.isArray(cats)) return res.status(400).json({ error: 'categories[] bhejo' });
    const saved = await savePollConfig(cats);
    res.json({ ok: true, categories: saved });
  } catch (e) { res.status(400).json({ error: e.message || 'save failed' }); }
});

// Invoice history for Vault dashboard — no, client, date, total (password/token)
app.get('/api/invoices', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ invoices: await loadInvIndex() });
});

// Invoice meta for Vault dashboard — next no + clients (same source as bot)
app.get('/api/invoice-meta', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ nextInvoiceNo: getNextInvoiceNo(), lastInvoiceNo, clients: CLIENTS });
});

// Invoice generate for Vault dashboard — same fill_excel.py + template, uploads to Cloudinary
app.post('/api/invoice', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { date, invoiceNo, client, items } = req.body || {};
    if (!date || !invoiceNo || !client || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'date, invoiceNo, client, items[] required' });
    const cleanItems = items.slice(0, 20).map(it => ({
      brand: String(it.brand || '').slice(0, 40),
      description: String(it.description || '').slice(0, 120),
      qty: Number(it.qty) || 0,
      rate: Number(it.rate) || 0,
      disc: 0,
    })).filter(it => it.description && it.qty > 0);
    if (!cleanItems.length) return res.status(400).json({ error: 'koi valid item nahi' });
    const subtotal = cleanItems.reduce((s, it) => s + it.qty * it.rate, 0);
    const inv = { date: String(date).slice(0, 12), invoiceNo: String(invoiceNo).replace(/[^0-9]/g, '').slice(0, 10), client: String(client).slice(0, 60), items: cleanItems };
    if (!inv.invoiceNo) return res.status(400).json({ error: 'invoiceNo number me bhejo' });
    const excelBuf = await generateInvoiceExcelBuffer(inv);
    setLastInvoiceNo(parseInt(inv.invoiceNo, 10));
    await saveSerialToCloud();
    const b64 = excelBuf.toString('base64');
    const dataUri = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${b64}`;
    const out = await cloudinary.uploader.upload(dataUri, { folder: 'live-tech-backup/Invoice', public_id: `Invoice-${inv.invoiceNo}.xlsx`, use_filename: true, unique_filename: true, resource_type: 'raw' });
    await addInvIndex({ no: inv.invoiceNo, client: inv.client, date: inv.date, items: cleanItems.length, total: subtotal, public_id: out.public_id, rt: out.resource_type });
    res.json({ ok: true, url: vaultFileLink(out.public_id, out.resource_type), invoiceNo: inv.invoiceNo, total: subtotal, items: cleanItems.length });
  } catch (e) {
    console.error('API invoice fail:', e.message);
    res.status(500).json({ error: e.message || 'invoice failed' });
  }
});

app.post('/disconnect', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'wrong password' });
  try { await sock?.logout(); } catch {}
  isConnected = false; qrString = null;
  try { fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

app.post('/reset', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'wrong password' });
  try { sock?.end?.(undefined); } catch {}
  isConnected = false; qrString = null; reconnectAttempts = 0;
  try { fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true }); } catch {}
  messageStore.clear();
  console.log('🔄 Auth reset — restarting bot');
  setTimeout(() => startBot(), 1000);
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

// ─── Cloudinary Upload — via SDK (no manual signature, fixes preset error) ───
async function uploadToCloudinary(buffer, filename, category) {
  const folder = `live-tech-backup/${category}`;
  // Use data URI so SDK handles signing correctly
  const base64 = buffer.toString('base64');
  const ext = filename.split('.').pop()?.toLowerCase() || 'bin';
  const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', pdf:'application/pdf', mp4:'video/mp4', mov:'video/quicktime', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls:'application/vnd.ms-excel', csv:'text/csv', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc:'application/msword', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt:'application/vnd.ms-powerpoint', zip:'application/zip', txt:'text/plain' };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const dataUri = `data:${mime};base64,${base64}`;
  // ponytail: free-tier Slow Down pe 3 try (2s, 5s), sirf transient errors pe
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      return await cloudinary.uploader.upload(dataUri, {
        folder,
        public_id: filename.replace(/\.[^/.]+$/, '').slice(0,80),
        use_filename: true,
        unique_filename: true,
        resource_type: 'auto',
      });
    } catch (e) {
      lastErr = e;
      const msg = String(e.error?.message || e.message || '').toLowerCase();
      const transient = /slow down|rate limit|capac|timeout|temporar|econn|socket|network|fetch failed/.test(msg) || (e.http_code && (e.http_code === 429 || e.http_code >= 500));
      console.error(`Cloudinary try ${i + 1}/3 fail:`, e.message);
      if (!transient || i === 2) throw new Error(e.error?.message || e.message || 'cloudinary failed');
      await sleep(i === 0 ? 2000 : 5000);
    }
  }
  throw lastErr;
}

// ─── Groq (DM intent + date resolve; group me ab manual category sawal hai) ───
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

function getState(jid) {
  const norm = jidNormalizedUser(jid);
  if (!userState.has(norm)) userState.set(norm, { loggedIn: false, attempts: 0, pendingQueue: [], lastCat: null, rawJid: jid, mode: null, invoice: null });
  if (!userState.get(norm).pendingQueue) userState.get(norm).pendingQueue = [];
  const s = userState.get(norm);
  s.rawJid = jid;
  return s;
}

function mainMenuText() {
  return `Main Menu:\n1. Backup add karna (file bhejo)\n2. Invoice banana\n3. Purane documents mangwana (date se)\n\n1, 2 ya 3 bhejo`;
}
// ponytail: AI se date nikalo ("5 din pehle", "1 mahine pehle" Roman Urdu samajhta hai)
async function aiResolveDate(text) {
  if (!GROQ_API_KEY) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0, max_tokens: 60,
        messages: [
          { role: 'system', content: `Today is ${formatDateDDMMYYYY(new Date())}. Resolve the user's day/span to JSON ONLY {"date":"DD-MM-YYYY","days":1}. Examples: "5 din pehle"→date 5 days ago days 1, "1 mahine pehle"→date 30 days ago days 1, "pichle hafte ke"→date 7 days ago days 7, "pichle mahine ke"→date 30 days ago days 30, "peer ko"→most recent past Monday days 1. Cap days at 31. If no date meant, {"date":"","days":0}.` },
          { role: 'user', content: String(text).slice(0, 200) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const m = String(j.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    if (!/^\d{2}-\d{2}-\d{4}$/.test(o.date || '')) return null;
    return { date: o.date, days: Math.min(Math.max(parseInt(o.days, 10) || 1, 1), 31) };
  } catch { return null; } finally { clearTimeout(t); }
}
function shiftDate(ddmmyyyy, delta) {
  const [dd, mm, yyyy] = ddmmyyyy.split('-').map(Number);
  const d = new Date(yyyy, mm - 1, dd);
  d.setDate(d.getDate() + delta);
  return formatDateDDMMYYYY(d);
}
// ponytail: date ka record (invoices + files, link ke saath) — menu option 3 + AI dono use karte hain
async function sendDateRecord(primaryJid, fallbackJid, target) {
  return sendDateRecords(primaryJid, fallbackJid, [target]);
}
async function sendDateRecords(primaryJid, fallbackJid, targets) {
  const invList = await loadInvIndex();
  let invHits = [];
  targets.forEach(t => { invList.filter(e => e.date === t).slice(0, 5).forEach(e => invHits.push(e)); });
  invHits = invHits.slice(0, 10);
  let fileHits = [];
  try {
    const sr = await cloudinary.search.expression('folder:live-tech-backup/*').sort_by('created_at', 'desc').max_results(100).execute();
    (sr.resources || []).forEach(r => {
      const d = new Date(r.created_at);
      const dd = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
      if (targets.includes(dd) && fileHits.length < 10) fileHits.push(r);
    });
  } catch {}
  await sendRecordMessage(primaryJid, fallbackJid, targets, invHits, fileHits);
}
async function sendRecordMessage(primaryJid, fallbackJid, targets, invHits, fileHits) {
  if (!invHits.length && !fileHits.length) {
    await sendMessageSafe(primaryJid, fallbackJid, { text: `${targets.join(', ') || 'Us din'} ka kuch nahi mila. Menu: menu` });
    return;
  }
  const label = targets.length > 1 ? `${targets[0]} se ${targets[targets.length - 1]} tak` : targets[0];
  let out = `${label} ka record:\n`;
  invHits.forEach(e => { out += `🧾 #${e.no} | ${e.client || '—'} | ${e.date || ''}\n`; });
  invHits.forEach(e => { if (e.public_id) out += `#${e.no}: ${vaultFileLink(e.public_id, e.rt || 'raw')}\n`; });
  fileHits.forEach(f => { out += `📁 ${f.public_id.split('/').pop()}: ${vaultFileLink(f.public_id, f.resource_type || 'raw')}\n`; });
  await sendMessageSafe(primaryJid, fallbackJid, { text: out });
}

function formatDateDDMMYYYY(d) {
  const dd=String(d.getDate()).padStart(2,'0'), mm=String(d.getMonth()+1).padStart(2,'0'), yyyy=d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}
function parseDateInput(t) {
  const s=t.trim();
  if(s.toLowerCase()==='today') return formatDateDDMMYYYY(new Date());
  // try DD-MM-YYYY or DD/MM/YYYY or YYYY-MM-DD
  const m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if(m) return `${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}-${m[3]}`;
  const m2=s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if(m2) return `${m2[3].padStart(2,'0')}-${m2[2].padStart(2,'0')}-${m2[1]}`;
  return null;
}
function numberToWords(n) {
  const a=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const b=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  const num=parseInt(n,10); if(isNaN(num)) return 'Zero Only'; if(num===0) return 'Zero Only';
  function w(x){ if(x<20) return a[x]; if(x<100) return b[Math.floor(x/10)] + (x%10? ' '+a[x%10]:''); if(x<1000) return a[Math.floor(x/100)]+' Hundred'+(x%100? ' '+w(x%100):''); return w(Math.floor(x/1000))+' Thousand'+(x%1000? ' '+w(x%1000):''); }
  return w(num)+' Only';
}
// Invoice serial - last used, suggest next, allow manual
let lastInvoiceNo = 7779;
try { const v = fs.readFileSync(path.join(__dirname, 'last_invoice.txt'), 'utf8').trim(); const n = parseInt(v,10); if(!isNaN(n)) lastInvoiceNo = n; } catch {}
function getNextInvoiceNo(){ return String(lastInvoiceNo + 1); }
function setLastInvoiceNo(n){ const v=parseInt(n,10); if(!isNaN(v) && v>lastInvoiceNo){ lastInvoiceNo=v; try{ fs.writeFileSync(path.join(__dirname,'last_invoice.txt'), String(v)); }catch{} } }
// ponytail: invoice history index (vault history + client filter ke liye), 5min cache
const INVOICES_PID = 'live-tech-backup/system/invoices.json';
let invIndexCache = { list: [], ts: 0 };
async function loadInvIndex() {
  if (Date.now() - invIndexCache.ts < 5 * 60 * 1000) return invIndexCache.list;
  try {
    const info = await cloudinary.api.resource(INVOICES_PID, { resource_type: 'raw' });
    if (info?.secure_url) {
      const r = await fetch(info.secure_url);
      const j = await r.json();
      if (Array.isArray(j)) invIndexCache = { list: j, ts: Date.now() };
    }
  } catch {}
  return invIndexCache.list;
}
async function addInvIndex(entry) {
  try {
    const list = await loadInvIndex();
    const i = list.findIndex(x => String(x.no) === String(entry.no));
    if (i >= 0) list[i] = entry; else list.unshift(entry);
    const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(list.slice(0, 500))).toString('base64')}`;
    await cloudinary.uploader.upload(dataUri, { public_id: INVOICES_PID, resource_type: 'raw', overwrite: true, unique_filename: false, use_filename: false });
    invIndexCache = { list, ts: Date.now() };
  } catch (e) { console.error('inv index save fail:', e.message); }
}
// ponytail: serial Cloudinary me durable (disk ephemeral hai, rebuild pe reset se bachao)
const SERIAL_PID = 'live-tech-backup/system/last_invoice';
async function saveSerialToCloud() {
  try {
    const dataUri = `data:text/plain;base64,${Buffer.from(String(lastInvoiceNo)).toString('base64')}`;
    await cloudinary.uploader.upload(dataUri, { public_id: SERIAL_PID, resource_type: 'raw', overwrite: true, unique_filename: false, use_filename: false });
  } catch (e) { console.error('serial cloud save fail:', e.message); }
}
async function loadSerialFromCloud() {
  try {
    const info = await cloudinary.api.resource(SERIAL_PID, { resource_type: 'raw' });
    if (!info?.secure_url) return;
    const r = await fetch(info.secure_url);
    const n = parseInt((await r.text()).trim(), 10);
    if (!isNaN(n) && n > lastInvoiceNo) {
      lastInvoiceNo = n;
      try { fs.writeFileSync(path.join(__dirname, 'last_invoice.txt'), String(n)); } catch {}
      console.log(`serial cloud se load: ${n}`);
    }
  } catch (e) { console.error('serial cloud load skip:', e.message?.slice(0, 120)); }
}
function getStepPrompt(step, inv){
  if(step==='date') return `Date bhejo - Today likho ya DD-MM-YYYY (jaise 04-09-2026). Back ke liye 'back' likho`;
  if(step==='invoiceNo'){ const nxt=getNextInvoiceNo(); return `Invoice No ready hai: ${nxt} (last ${lastInvoiceNo}). Yehi use karna hai to ${nxt} bhejo, ya manual No likho. Back: back`; }
  if(step==='client') return clientMenuText() + `\n\nBack: back`;
  if(step==='description') return `Description bhejo (kaam ka naam). Back: back`;
  if(step==='qty') return `Qty bhejo (number, jaise 2). Back: back`;
  if(step==='rate') return `Rate / Unit Price bhejo (jaise 12000). Back: back`;
  if(step==='brand') return `Brand bhejo (optional, skip ke liye - bhejo). Back: back`;
  if(step==='askMore') return `Item ${inv.items?.length||1} save ho gaya.\nAur item add karna hai?\n1. Haan, aur item\n2. Nahi, invoice generate karo\n\nBack: back`;
  return '';
}

async function generateInvoicePdfBuffer(inv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 24 });
    const bufs=[]; doc.on('data', d=>bufs.push(d)); doc.on('end', ()=>resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const lineTotal = (parseFloat(inv.qty)||0)*(parseFloat(inv.rate)||0) - (parseFloat(inv.discount)||0);
    const words = numberToWords(lineTotal);
    // Outer border
    doc.rect(24, 24, 547, 794).strokeColor('#CBD5E1').lineWidth(0.7).stroke();
    // Top accent line
    doc.rect(24, 24, 547, 3).fill('#0E4D2A');
    // Company block
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(11).text('UA International', 32, 34);
    doc.font('Helvetica').fontSize(7).fillColor('#475569').text('IT Solution provider', 32, 48);
    doc.fontSize(7).fillColor('#334155').text('9 Floor Office # 905 Uni Center,', 32, 60);
    doc.text('II Chundrigar Road Karachi.', 32, 70);
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(22).text('INVOICE', 380, 34, { align: 'right', width: 180 });
    // Date / Invoice # box
    doc.font('Helvetica').fontSize(8).fillColor('#334155');
    doc.text('Date:', 380, 62, { width: 80, align: 'right' }); doc.font('Helvetica-Bold').text(inv.date, 465, 62);
    doc.font('Helvetica').text('Invoice #:', 380, 76, { width: 80, align: 'right' }); doc.font('Helvetica-Bold').text(String(inv.invoiceNo), 465, 76);
    // Divider
    doc.moveTo(32, 92).lineTo(563, 92).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
    // Bill To
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0E4D2A').text('Bill To:', 32, 100);
    doc.font('Helvetica').fontSize(9).fillColor('#0F172A').text(inv.client || 'Walk-in Client', 32, 112);
    doc.fontSize(7).fillColor('#475569').text('Client', 32, 126);
    // Ship/extra info placeholder to match template spacing
    doc.fontSize(7).fillColor('#64748B').text('Payment Terms: 30 Days', 400, 112, { align: 'right' });
    // Sales Details header (light)
    const sdTop=142; doc.rect(32, sdTop, 531, 14).fill('#F1F5F9'); doc.strokeColor('#E2E8F0').rect(32, sdTop, 531, 14).stroke();
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text('Job', 36, sdTop+5, { width: 80 }); doc.text('Shipping Method', 120, sdTop+5, { width: 90 });
    doc.text('Shipping Terms', 210, sdTop+5, { width: 90 }); doc.text('Delivery Date', 300, sdTop+5, { width: 80 });
    doc.text('Payment Terms', 380, sdTop+5, { width: 80 }); doc.text('Due Date', 460, sdTop+5, { width: 80 });
    // Invoice table header - dark
    const top=162; doc.rect(32, top, 531, 18).fill('#0F172A');
    doc.fillColor('white').font('Helvetica-Bold').fontSize(7);
    doc.text('S/No', 34, top+6, { width: 28, align: 'center' }); doc.text('Brand', 64, top+6, { width: 60, align: 'center' });
    doc.text('Description', 126, top+6, { width: 190, align: 'center' }); doc.text('Qty', 316, top+6, { width: 40, align: 'center' });
    doc.text('Unit Price', 356, top+6, { width: 65, align: 'center' }); doc.text('Discount', 421, top+6, { width: 55, align: 'center' });
    doc.text('Line Total', 476, top+6, { width: 80, align: 'center' });
    // Table grid - only needed rows (dynamic, not 12 empty rows)
    const rowH=18; const rows=1; // single item, add more when multi-item
    for(let i=0;i<rows;i++){
      const y=top+18 + i*rowH;
      doc.rect(32, y, 531, rowH).strokeColor('#E2E8F0').lineWidth(0.4).stroke();
      doc.moveTo(62, y).lineTo(62, y+rowH).stroke(); doc.moveTo(124, y).lineTo(124, y+rowH).stroke();
      doc.moveTo(314, y).lineTo(314, y+rowH).stroke(); doc.moveTo(354, y).lineTo(354, y+rowH).stroke();
      doc.moveTo(419, y).lineTo(419, y+rowH).stroke(); doc.moveTo(474, y).lineTo(474, y+rowH).stroke();
    }
    // First row data
    const y0=top+18+5; doc.fillColor('#0F172A').font('Helvetica').fontSize(7);
    doc.text('1', 34, y0, { width:28, align:'center' }); doc.text(inv.brand||'-', 64, y0, { width:60, align:'center' });
    doc.text(inv.description, 126, y0, { width:190 }); doc.text(String(inv.qty), 316, y0, { width:40, align:'center' });
    doc.text(Number(inv.rate).toLocaleString(), 356, y0, { width:65, align:'center' }); doc.text(String(inv.discount||0), 421, y0, { width:55, align:'center' });
    doc.font('Helvetica-Bold').text(lineTotal.toFixed(2), 476, y0, { width:80, align:'center' }); doc.font('Helvetica');
    // Totals area
    const tTop=top+18+rows*rowH+6;
    // Subtotal / Total box
    doc.rect(380, tTop, 183, 36).strokeColor('#E2E8F0').stroke();
    doc.moveTo(460, tTop).lineTo(460, tTop+36).stroke();
    doc.moveTo(380, tTop+18).lineTo(563, tTop+18).stroke();
    doc.fillColor('#475569').fontSize(7).text('Subtotal', 384, tTop+6, { width: 70, align: 'right' });
    doc.fillColor('#0F172A').font('Helvetica-Bold').text(lineTotal.toFixed(2), 465, tTop+6, { width: 90, align: 'center' });
    doc.font('Helvetica-Bold').fillColor('#0E4D2A').text('Total', 384, tTop+22, { width: 70, align: 'right' });
    doc.text(lineTotal.toFixed(2), 465, tTop+22, { width: 90, align: 'center' });
    doc.font('Helvetica');
    // Amount in words
    doc.fillColor('#334155').fontSize(7).text('Amount In Words:', 32, tTop+8);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0F172A').text(words, 32, tTop+20, { width: 340 });
    // Thank you
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#0E4D2A').text('Thank you for your business!', 32, tTop+50, { align: 'center', width: 531 });
    // Footer
    doc.font('Helvetica').fontSize(6).fillColor('#94A3B8').text('UA International • IT Solution provider • Generated by Live Tech Backup System', 32, 790, { align: 'center', width: 531 });
    doc.end();
  });
}
async function generateInvoiceExcelBuffer(inv) {
  // Try Python openpyxl (exact, preserves VBA/tables better) first, fallback to ExcelJS
  const hasMulti = inv.items && inv.items.length>0;
  const subtotal = hasMulti ? inv.items.reduce((s,it)=> s + (Number(it.qty)||0)*(Number(it.rate)||0), 0) : (Number(inv.qty)||0)*(Number(inv.rate)||0);
  const words=numberToWords(subtotal);
  const data={ date: inv.date, invoiceNo: String(inv.invoiceNo), client: inv.client||'Walk-in Client', words, items: hasMulti ? inv.items : [{brand: inv.brand||'', description: inv.description, qty: inv.qty, rate: inv.rate, disc: 0}] };
  const templatePath = path.join(__dirname, 'template.xlsm');
  const tmpOut = path.join(os.tmpdir(), `inv_${Date.now()}_${inv.invoiceNo}.xlsx`);
  // Try python3 first (Linux), then python (Windows), then py
  let buf=null;
  let lastErr=null;
  for(const py of ['python3','python','py']){
    try {
      await execAsync(`${py} "${path.join(__dirname, 'fill_excel.py')}" "${templatePath}" "${tmpOut}" '${JSON.stringify(data).replace(/'/g, "\\'")}'`);
      buf = await fs.promises.readFile(tmpOut);
      await fs.promises.unlink(tmpOut).catch(()=>{});
      console.log(`Excel via ${py} ok`, buf.length);
      return buf;
    } catch(e) {
      lastErr=e;
      console.log(`Python ${py} failed`, e.message?.slice(0,200));
    }
  }
  // All python attempts failed -> fallback ExcelJS (multi)
  console.log('Python fill failed, fallback ExcelJS', lastErr?.message);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const keep='Sales Invoice'; wb.worksheets.slice().forEach(s=>{ if(s.name!==keep) try{ wb.removeWorksheet(s.id);}catch{} });
  let ws=wb.getWorksheet(keep)||wb.worksheets[0];
  try{ ws.getImages().forEach(img=> ws.removeImage(img.imageId)); }catch{}
  try{ ws.model.media=[];}catch{} try{ if(wb.model&&wb.model.media) wb.model.media=[];}catch{}
  try{ ws.auto_filter=null;}catch{} try{ ws.autoFilter=null;}catch{}
  try{ if(ws.model&&ws.model.tables) ws.model.tables=[];}catch{} try{ if(ws._tables) ws._tables=[];}catch{} try{ if(ws.tables) ws.tables=[];}catch{}
  // header style
  try{
    const hdrFill={ type:'pattern', pattern:'solid', fgColor:{argb:'FF0F172A'} };
    const hdrFont={ name:'Century Gothic', size:11, bold:true, color:{argb:'FFFFFFFF'} };
    for(const col of ['B','C','D','E','F','G','H']){
      const c=ws.getCell(col+'18'); c.fill=hdrFill; c.font=hdrFont; c.alignment={horizontal:'center', vertical:'middle'};
    }
    ws.getRow(18).height=18;
  }catch{}
  ws.getCell('H6').value=inv.date; ws.getCell('H7').value=String(inv.invoiceNo); ws.getCell('F10').value=inv.client||'Walk-in Client';
  const fItems = hasMulti ? inv.items : [{brand: inv.brand||'', description: inv.description, qty: inv.qty, rate: inv.rate, disc:0}];
  const sub = fItems.reduce((s,it)=> s + (Number(it.qty)||0)*(Number(it.rate)||0), 0);
  fItems.forEach((it,i)=>{
    const r=19+i;
    const isBlue = (i%2===1);
    const fill = isBlue ? { type:'pattern', pattern:'solid', fgColor:{argb:'FFD5E0EA'} } : { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFFFFF'} };
    ws.getCell(`B${r}`).value=i+1; ws.getCell(`C${r}`).value=it.brand||''; ws.getCell(`D${r}`).value=it.description; ws.getCell(`E${r}`).value=Number(it.qty)||0; ws.getCell(`F${r}`).value=Number(it.rate)||0; ws.getCell(`G${r}`).value=0; ws.getCell(`H${r}`).value=(Number(it.qty)||0)*(Number(it.rate)||0);
    ws.getRow(r).hidden=false; ws.getRow(r).height=16;
    for(const col of ['B','C','D','E','F','G','H']){
      const c=ws.getCell(col+r); c.fill=fill; c.font={ name:'Century Gothic', size:12, color:{argb:'FF0F172A'} }; c.alignment={ horizontal: (['B','E','F','G','H'].includes(col)?'center':'left'), vertical:'middle' };
    }
  });
  for(let r=19+fItems.length;r<=38;r++){ ws.getRow(r).hidden=true; ws.getRow(r).height=0; for(const col of ['B','C','D','E','F','G','H']) ws.getCell(col+r).value=null; }
  ws.getCell('H41').value=sub; ws.getCell('H43').value=sub; ws.getCell('D44').value=words;
  try{ ws.getCell('H41').fill={ type:'pattern', pattern:'solid', fgColor:{argb:'FFD5E0EA'} }; ws.getCell('H43').fill={ type:'pattern', pattern:'solid', fgColor:{argb:'FFD5E0EA'} }; }catch{}
  try{ ws.pageSetup={ paperSize:9, orientation:'portrait', fitToPage:true, fitToWidth:1, fitToHeight:1, horizontalCentered:true, printArea:'A1:H44', margins:{left:0.25,right:0.25,top:0.3,bottom:0.3}}; }catch{}
  const outBuf=await wb.xlsx.writeBuffer(); return Buffer.from(outBuf);
}
async function generatePdfFromExcelBuffer(excelBuf) {
  // Same Excel file se hi PDF - Python reportlab (exact data, 1-page), fallback to soffice, then pdfkit
  const tmpDir = os.tmpdir();
  const xlsxPath = path.join(tmpDir, `inv_${Date.now()}.xlsx`);
  const pdfPath = xlsxPath.replace('.xlsx', '.pdf');
  await fs.promises.writeFile(xlsxPath, excelBuf);
  // 1) Try Python excel_to_pdf.py (reportlab, same Excel data, no new template)
  for(const py of ['python3','python','py']){
    try{
      await execAsync(`${py} "${path.join(__dirname, 'excel_to_pdf.py')}" "${xlsxPath}" "${pdfPath}"`);
      const pdfBuf = await fs.promises.readFile(pdfPath);
      await fs.promises.unlink(xlsxPath).catch(()=>{});
      await fs.promises.unlink(pdfPath).catch(()=>{});
      console.log(`PDF via ${py} excel_to_pdf ok`, pdfBuf.length);
      return pdfBuf;
    }catch(e){ console.log(`excel_to_pdf via ${py} fail`, e.message?.slice(0,200)); }
  }
  // 2) Try LibreOffice
  try {
    await execAsync(`soffice --headless --convert-to pdf --outdir "${tmpDir}" "${xlsxPath}"`);
    const pdfBuf = await fs.promises.readFile(pdfPath);
    await fs.promises.unlink(xlsxPath).catch(()=>{});
    await fs.promises.unlink(pdfPath).catch(()=>{});
    return pdfBuf;
  } catch(e) {
    await fs.promises.unlink(xlsxPath).catch(()=>{});
    throw e;
  }
}

async function catMenu() {
  const cats = await getCats();
  let lines = ['Category choose karo:\n'];
  cats.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  lines.push(`  ${cats.length + 1}. New Category (apna naam likho)`);
  lines.push(`  0. Cancel (ye file rehne do, upload mat karo)`);
  lines.push(`\nNumber bhejo ya naam likho - jaise 1 ya Invoice, cancel ke liye 0`);
  return lines.join('\n');
}
// ponytail: har backup file pe aaj ki date + HH-mm-ss (same-day Cloudinary overwrite rokne ko)
function datedName(filename) {
  const d = new Date();
  const stamp = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}_${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}`;
  const i = filename.lastIndexOf('.');
  if (i <= 0) return `${filename}_${stamp}`;
  return `${filename.slice(0, i)}_${stamp}${filename.slice(i)}`;
}
// ponytail: group upload ka naam = category + custom-naam + DD-MM-YYYY_HH-mm-ss (custom khali to purana format)
function catDatedName(cat, filename, custom) {
  const d = new Date();
  const stamp = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}_${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}`;
  const f = String(filename || '');
  const i = f.lastIndexOf('.');
  const ext = i > 0 ? f.slice(i) : '.jpg';
  const safe = String(cat || '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 40) || 'file';
  const cn = String(custom || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 40);
  if (cn) return `${safe}_${cn}_${stamp}${ext}`;
  return `${safe}_${stamp}${ext}`;
}
function pendingCount(s) { return (s.pendingQueue || []).length; }
async function nextPrompt(s) {
  const f = s.pendingQueue[0];
  if (!f) return '';
  const n = s.pendingQueue.length;
  return `File: ${f.filename}${n > 1 ? ` (1/${n} — baaki line me)` : ''} ready hai\n\n` + await catMenu();
}
// ponytail: poll categories = admin portal se (Cloudinary JSON), fallback GROUP_CATS
const GROUP_CATS = ['home exp', 'office exp', 'cheque', 'bank transaction', 'purchase', 'bill'];
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_CONFIG_PID = 'live-tech-backup/system/poll-config';
let pollConfigCache = { list: [...GROUP_CATS], ts: 0 };
async function loadPollConfig() {
  if (Date.now() - pollConfigCache.ts < 60000) return pollConfigCache.list;
  try {
    const info = await cloudinary.api.resource(POLL_CONFIG_PID, { resource_type: 'raw' });
    const url = info.secure_url || info.url;
    if (url) {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) pollConfigCache = { list: j.slice(0, 12), ts: Date.now() }; }
    }
  } catch {}
  return pollConfigCache.list;
}
async function savePollConfig(list) {
  const clean = [...new Set((Array.isArray(list) ? list : []).map(s => String(s || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 12);
  if (!clean.length) throw new Error('koi category nahi');
  const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(clean)).toString('base64')}`;
  await cloudinary.uploader.upload(dataUri, { public_id: POLL_CONFIG_PID, resource_type: 'raw', overwrite: true, invalidate: true });
  pollConfigCache = { list: clean, ts: Date.now() };
  return clean;
}
async function groupChoiceList() { return [...await loadPollConfig()]; }
async function groupPollOptions() {
  const base = await loadPollConfig();
  // admin list + cancel (new category hataya — admin se hi banao)
  return [...base.slice(0, 11), 'cancel'];
}
async function groupCatPrompt(filename, n) {
  const choices = await groupChoiceList();
  const lines = [`File: ${filename}${n > 1 ? ` (1/${n} — baaki line me)` : ''}`, `Ye kis category me dalun? (IMAGE ko reply karke jawab do)\n`];
  choices.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  lines.push(`  0. Cancel (ye file rehne do)`);
  lines.push(`\nNumber ya naam — jaise 1 ya home exp. Admin ne categories Vault se set ki hain.`);
  return lines.join('\n');
}
// quoted reply kis message ka jawab hai — image ka id ya bot ke sawal ka id
function quotedTargetId(inner) {
  return inner?.extendedTextMessage?.contextInfo?.stanzaId || null;
}
function matchGroupCat(t) {
  const l = String(t || '').trim().toLowerCase();
  return GROUP_CATS.find(c => c === l) || null;
}
// ponytail: naam → poll list ke hisab se (new category ab nahi)
async function resolveGroupCat(t) {
  const l = String(t || '').trim().toLowerCase();
  if (!l) return null;
  const hit = (await groupChoiceList()).find(c => String(c).toLowerCase() === l);
  return hit ? { cat: hit } : null;
}
// ponytail: group jawab ka shared upload — queue se nikaal ke Cloudinary, done msg
async function saveGroupPending(primaryJid, fallbackJid, state, idx, cat) {
  const cur = state.pendingQueue[idx];
  if (!cur || cur.busy) return;
  cur.busy = true;
  try {
    await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, ${cat} me save ho raha hai...` });
    const fname = catDatedName(cat, cur.filename, cur.customName);
    const out = await uploadToCloudinary(cur.buffer, fname, cat);
    noteNewCat(cat);
    state.pendingQueue.splice(idx, 1);
    let doneMsg = `Ho gaya!\nCategory: ${cat}\nFile: ${fname}\nLink: ${vaultFileLink(out.public_id, out.resource_type)}\n\nVault: ${VAULT_URL}`;
    const n = pendingCount(state);
    if (n) doneMsg += `\n\n${n} aur baaki hain — unke poll me vote karo.`;
    await sendMessageSafe(primaryJid, fallbackJid, { text: doneMsg });
  } catch (e) {
    cur.busy = false;
    throw e;
  }
}
// ponytail: group file pe pehle NAAM pucho, naam milte hi category poll bhejo (caption me naam ho to direct poll)
function cleanGroupName(t) {
  return String(t || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 40);
}
async function sendGroupPollFor(primaryJid, fallbackJid, state, idx) {
  const entry = state.pendingQueue[idx];
  if (!entry || entry.pollMsgId || entry.busy || entry.done) return;
  const label = entry.customName || entry.filename;
  try {
    const pollSecret = crypto.randomBytes(32);
    const pollOpts = await groupPollOptions();
    const sent = await sendMessageSafe(primaryJid, fallbackJid, { poll: { name: `File: ${label} — kis category me dalun?`, values: pollOpts, selectableCount: 1, messageSecret: pollSecret } });
    entry.pollMsgId = sent?.key?.id || null;
    entry.pollSecret = pollSecret;
    entry.pollOptions = pollOpts;
    if (sent) messageStore.set(msgKeyId(sent.key), sent);
    if (!entry.pollMsgId) throw new Error('poll043');
  } catch {
    await sendGroupTextFallback(primaryJid, fallbackJid, state, idx, null);
  }
}
// ponytail: poll option ka SHA-256 hash — vote hashes se milao (Baileys jaisa)
function pollOptionHash(name) {
  return crypto.createHash('sha256').update(String(name), 'utf8').digest();
}
// ponytail: poll secret + JID combos (PN/LID) try karke vote decrypt
function decryptGroupVote(pollUpd, entry, voteMsg) {
  const enc = pollUpd.vote;
  if (!enc || !entry.pollSecret) return null;
  const meId = sock?.user?.id || '';
  const meLid = sock?.user?.lid || '';
  const voter = voteMsg.key?.participant || voteMsg.key?.remoteJid || '';
  const swap = (j) => {
    const m = String(j).match(/^([^@]+)@(.+)$/);
    if (!m) return null;
    const other = m[2] === 'lid' ? 's.whatsapp.net' : (m[2] === 's.whatsapp.net' ? 'lid' : null);
    return other ? `${m[1]}@${other}` : null;
  };
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const creators = uniq([meId && jidNormalizedUser(meId), meLid && jidNormalizedUser(meLid)]);
  const voters = uniq([voter, jidNormalizedUser(voter), swap(voter), swap(jidNormalizedUser(voter))]);
  let lastErr = '';
  for (const creator of creators) {
    for (const v of voters) {
      try {
        const dec = decryptPollVote(enc, { pollEncKey: entry.pollSecret, pollCreatorJid: creator, pollMsgId: entry.pollMsgId, voterJid: v });
        if (dec?.selectedOptions?.length) return dec;
      } catch (e) { lastErr = String(e?.message || e).slice(0, 80); }
    }
  }
  console.log(`🗳️ combos tried: creators=[${creators.join(',')}] voters=[${voters.join(',')}] lastErr=${lastErr}`);
  return null;
}
// ponytail: vote hash se option nikalo — aakhri 2: new, cancel
function voteOptionIndex(dec, options) {
  const opts = options && options.length ? options : GROUP_CATS;
  const hashes = dec.selectedOptions || [];
  for (let i = 0; i < opts.length; i++) {
    const h = pollOptionHash(opts[i]);
    if (hashes.some(sh => Buffer.from(sh).equals(h))) return i;
  }
  return -1;
}
// ponytail: poll fail/timeout pe silent reply fallback (file ko quote karke sawal)
async function sendGroupTextFallback(primaryJid, fallbackJid, state, idx, note) {
  const entry = state.pendingQueue[idx];
  if (!entry || entry.done) return;
  entry.fallbackSent = true;
  const n = pendingCount(state);
  const qtext = (note ? note + '\n\n' : '') + groupCatPrompt(entry.customName || entry.filename, n);
  try {
    const sent = await sendMessageSafe(primaryJid, fallbackJid, { text: qtext }, entry.fileMsg ? { quoted: entry.fileMsg } : undefined);
    entry.qid = sent?.key?.id || null;
  } catch {
    try { await sendMessageSafe(primaryJid, fallbackJid, { text: qtext }); } catch {}
  }
}
// ponytail: new-category vote pe alag Create message — naam isi ko reply karke
async function sendNewCategoryPrompt(primaryJid, fallbackJid, state, idx, prefix) {
  const entry = state.pendingQueue[idx];
  if (!entry || entry.done) return;
  entry.fallbackSent = true;
  const qtext = (prefix ? prefix + '\n\n' : '') + `Create new category 📁\n\nFile: ${entry.filename}\nNayi category ka naam isi message ko reply karke bhejo.`;
  try {
    const sent = await sendMessageSafe(primaryJid, fallbackJid, { text: qtext });
    entry.qid = sent?.key?.id || entry.qid;
  } catch {
    try { await sendMessageSafe(primaryJid, fallbackJid, { text: qtext }); } catch {}
  }
}
// ponytail: pollMsgId se entry dhoondo (saari chats me — vote update ke liye)
function findPollEntry(pollMsgId) {
  for (const s of userState.values()) {
    const idx = (s.pendingQueue || []).findIndex(f => f.pollMsgId === pollMsgId && !f.done);
    if (idx >= 0) return { state: s, idx };
  }
  return null;
}

function cleanText(t) {
  return (t || '').trim();
}

// ponytail: forwarded/ephemeral/view-once wrap hota hai, 5 level tak unwrap
function unwrapMsg(m) {
  let cur = m;
  for (let i = 0; i < 5; i++) {
    if (!cur) break;
    if (cur.ephemeralMessage) cur = cur.ephemeralMessage.message;
    else if (cur.viewOnceMessage) cur = cur.viewOnceMessage.message;
    else if (cur.viewOnceMessageV2) cur = cur.viewOnceMessageV2.message;
    else if (cur.viewOnceMessageV2Extension) cur = cur.viewOnceMessageV2Extension.message;
    else if (cur.documentWithCaptionMessage) cur = cur.documentWithCaptionMessage.message;
    else break;
  }
  return cur || m;
}

function isGreeting(text) {
  const l = text.toLowerCase();
  if (/\b(hi|hello|hey|salam|aoa|start|help)\b/.test(l)) return true;
  return ['aslam o alaikum', 'salam alaikum', 'hello bhai', 'salam bhai', 'assalam', 'wa alaikum'].some(g => l.includes(g));
}
// ponytail: rules fail hon to Groq intent — dimagh AI ka, haath apne code ke (number/link AI nahi banata)
async function aiIntent(text) {
  if (!GROQ_API_KEY) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.2, max_tokens: 150,
        messages: [
          { role: 'system', content: `Today is ${formatDateDDMMYYYY(new Date())}. You route messages for a backup/invoice WhatsApp bot (Roman Urdu + English). Reply ONLY JSON {"intent":"...","client":"","date":"","days":1,"reply":""}. intents: backup (user wants to save/send a file), invoice_start (wants to MAKE a new invoice), invoice_search (asks about an existing invoice/bill — put client name or number in client), date_search (asks for files/invoices of days — put start date as DD-MM-YYYY in date and span in days: "5 din pehle" means date=5 days ago days=1, "pichle hafte ke" means date=7 days ago days=7, "pichle mahine ke" means date=30 days ago days=30), list (vault link), help, logout, smalltalk (greetings/thanks/ok/how-are-you — put 1-2 line friendly Roman Urdu in reply, else empty), unknown. Never invent numbers, links, or prices.` },
          { role: 'user', content: String(text).slice(0, 300) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const m = String(j.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch { return null; } finally { clearTimeout(t); }
}

// Robust send: tries primary JID then fallback, logs every attempt per official docs
async function sendMessageSafe(primaryJid, fallbackJid, content, extra) {
  const targets = [primaryJid, fallbackJid].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  let lastErr = null;
  for (const jid of targets) {
    try {
      const res = await sock.sendMessage(jid, content, extra);
      console.log(`✅ Sent to ${jid} ok=${!!res}`);
      return res;
    } catch (e) {
      lastErr = e;
      console.error(`❌ Send failed to ${jid}: ${e.message}`);
    }
  }
  throw lastErr || new Error('send failed - no target');
}

// ─── Bot Start — 100% Official Docs Compliant ───
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys version: ${version.join('.')}`);

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
    msgRetryCounterCache,
    maxMsgRetryCount: 5,
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 30000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 250,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    getMessage: async (key) => {
      const id = msgKeyId(key);
      return messageStore.get(id)?.message ?? undefined;
    },
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('lid-mapping.update', (mapping) => {
    console.log('📋 LID mapping update:', JSON.stringify(mapping).slice(0, 500));
  });

  sock.ev.on('groups.update', async ([event]) => {
    try { const metadata = await sock.groupMetadata(event.id); groupCache.set(event.id, metadata); } catch {}
  });

  sock.ev.on('group-participants.update', async (event) => {
    try { const metadata = await sock.groupMetadata(event.id); groupCache.set(event.id, metadata); } catch {}
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log('🔌 connection.update:', JSON.stringify({ connection, hasQr: !!qr, code: lastDisconnect?.error?.output?.statusCode }));
    if (qr) { qrString = qr; reconnectAttempts = 0; }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : lastDisconnect?.error?.output?.statusCode);
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      isConnected = false;
      // clear QR on close so new one generates
      // keep qrString until new qr arrives, unless loggedOut
      if (loggedOut) {
        qrString = null;
        try { fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true }); } catch {}
        console.log('🔴 Logged out — deleted auth_info, need new QR');
      } else {
        if (reconnectAttempts >= MAX_RECONNECT) {
          console.log('⛔ Max reconnect reached, waiting for manual reset');
          return;
        }
        reconnectAttempts++;
        const delay = Math.min(reconnectAttempts * 2000, 30000);
        console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}) code=${statusCode}`);
        setTimeout(startBot, delay);
      }
    } else if (connection === 'open') {
      isConnected = true;
      reconnectAttempts = 0;
      qrString = null;
      console.log('✅ Connected — id:', sock.user?.id);
    }
  });

  // ─── Message Handler — Official: only type === 'notify', store via getMessage ───
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`📨 messages.upsert: type=${type}, count=${messages.length}`);
    // Persist to messageStore for getMessage (required per docs)
    for (const msg of messages) {
      if (msg.key?.id) messageStore.set(msgKeyId(msg.key), msg);
      if (messageStore.size > 500) {
        const firstKey = messageStore.keys().next().value;
        messageStore.delete(firstKey);
      }
    }
    // Official: only handle real-time notify, ignore append/history
    if (type !== 'notify') {
      console.log('⏭️ skip: type is not notify');
      return;
    }
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) { console.log('⏭️ skip: no message or fromMe'); continue; }
        if (isJidBroadcast(msg.key.remoteJid)) { console.log('⏭️ skip: broadcast'); continue; }

        const rawJid = msg.key.remoteJid;
        const altJid = msg.key.remoteJidAlt || null;
        const isLid = isLidUser(rawJid);
        console.log(`📩 from=${rawJid} alt=${altJid || 'none'} isLid=${isLid} type=${Object.keys(msg.message)[0] || 'unknown'}`);

        // Official v7: remoteJid may be @lid, remoteJidAlt is the PN form for DMs
        // Use PN (alt) as primary for delivery if available, LID as fallback
        const primaryJid = altJid || rawJid;
        const fallbackJid = altJid ? rawJid : null;
        // State keyed by normalized user (handles device suffix & LID/PN duality)
        const normalizedForState = jidNormalizedUser(primaryJid);
        const state = getState(normalizedForState);
        // Keep raw mapping for send fallback
        state._rawJid = rawJid;
        state._altJid = altJid;
        // Groups: no password, backup-only (DM me invoice). Spam se bachne ke liye fallback/menu group me khamosh.
        const isGroup = rawJid.endsWith('@g.us');
        if (isGroup) { state.loggedIn = true; state.invoice = null; }

        const inner = unwrapMsg(msg.message);
        const text = cleanText(
          inner.conversation ||
          inner.extendedTextMessage?.text ||
          inner.imageMessage?.caption ||
          inner.documentMessage?.caption ||
          inner.videoMessage?.caption ||
          inner.audioMessage?.caption ||
          inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
          inner.buttonsResponseMessage?.selectedButtonId ||
          ''
        );
        const lower = text.toLowerCase();

        // ─── Poll vote (group) — pehla vote wins, decrypt fail to reply fallback ───
        if (inner.pollUpdateMessage?.pollCreationMessageKey?.id) {
          if (isGroup) {
            const found = findPollEntry(inner.pollUpdateMessage.pollCreationMessageKey.id);
            if (found) {
              const entry = found.state.pendingQueue[found.idx];
              if (entry.busy) { continue; } // pehla vote/reply lock — double upload nahi
              console.log(`🗳️ vote: poll=${inner.pollUpdateMessage.pollCreationMessageKey.id} voter=${msg.key?.participant || '?'} secret=${entry.pollSecret ? 'yes' : 'NO'} me=${sock?.user?.id || '?'} lid=${sock?.user?.lid || 'none'}`);
              const dec = decryptGroupVote(inner.pollUpdateMessage, entry, msg);
              if (!dec) console.log(`🗳️ vote decrypt FAILED`);
              if (dec) {
                const opts = entry.pollOptions && entry.pollOptions.length ? entry.pollOptions : await loadPollConfig();
                const optIdx = voteOptionIndex(dec, opts);
                console.log(`🗳️ vote decrypted optIdx=${optIdx}`);
                if (opts[optIdx] === 'cancel') {
                  found.state.pendingQueue.splice(found.idx, 1);
                  await sendMessageSafe(primaryJid, fallbackJid, { text: `Rehne di ❌ ${entry.filename} upload nahi hui.` });
                } else if (optIdx >= 0) {
                  try { await saveGroupPending(primaryJid, fallbackJid, found.state, found.idx, opts[optIdx]); }
                  catch (e) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` }); }
                }
              } else {
                // vote samajh nahi aaya — silent reply fallback
                await sendGroupTextFallback(primaryJid, fallbackJid, found.state, found.idx, `Vote samajh nahi aaya ⚠️`);
              }
            }
          }
          continue;
        }

        // ─── Poll timeout — 10 min me vote na aye to reply fallback; naam na aye to original naam se poll ───
        if (isGroup && pendingCount(state)) {
          const now = Date.now();
          for (let ti = 0; ti < state.pendingQueue.length; ti++) {
            const e = state.pendingQueue[ti];
            if (!e.done && e.awaitingName && !e.pollMsgId && now - (e.createdAt || now) > POLL_TIMEOUT_MS) {
              e.awaitingName = false;
              await sendGroupPollFor(primaryJid, fallbackJid, state, ti);
            } else if (!e.done && !e.fallbackSent && e.pollMsgId && now - (e.createdAt || now) > POLL_TIMEOUT_MS) {
              await sendGroupTextFallback(primaryJid, fallbackJid, state, ti, `Vote nahi mila ⏰`);
            }
          }
        }

        await sleep(1000);

        // ─── Group: FILE ko reply karke NAAM, phir category — naam wali entry pehle ───
        if (isGroup && pendingCount(state) && text && !inner.imageMessage && !inner.documentMessage && !inner.videoMessage) {
          const q = quotedTargetId(inner);
          // naam-step: FILE ya naam-sawal ko reply, poll se pehle (awaitingName)
          const nIdx = q ? state.pendingQueue.findIndex(f => f.awaitingName && !f.pollMsgId && !f.done && ((f.nameQid && f.nameQid === q) || (f.fileMsgId && f.fileMsgId === q))) : -1;
          if (nIdx >= 0) {
            const entry = state.pendingQueue[nIdx];
            const GROUP_CANCEL = ['cancel', 'rehne do', 'chor do', 'choro', 'rehnedo'];
            if (text.trim() === '0' || GROUP_CANCEL.includes(lower)) {
              state.pendingQueue.splice(nIdx, 1);
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Rehne di ❌ ${entry.filename} upload nahi hui.` });
              continue;
            }
            const nm = cleanGroupName(text);
            if (!nm || nm.length < 2) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Naam chota hai — 2+ lafz likho, misal: blc ya blue light computer (0 = cancel)` }, { quoted: msg });
              continue;
            }
            entry.customName = nm; entry.awaitingName = false;
            await sendGroupPollFor(primaryJid, fallbackJid, state, nIdx);
            continue;
          }
          // reply-to-file tabhi jab poll fail ho chuka (fallbackSent), reply-to-sawal hamesha
          const gIdx = q ? state.pendingQueue.findIndex(f => (f.qid && f.qid === q) || (f.fallbackSent && f.fileMsgId === q)) : -1;
          if (gIdx >= 0) {
            const entry = state.pendingQueue[gIdx];
            if (entry.busy) continue; // upload in flight — pehla wins
            const GROUP_CANCEL = ['cancel', 'rehne do', 'chor do', 'choro', 'rehnedo'];
            if (text.trim() === '0' || GROUP_CANCEL.includes(lower)) {
              state.pendingQueue.splice(gIdx, 1);
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Rehne di ❌ ${entry.filename} upload nahi hui.` });
              continue;
            }
            // nayi-category confirm ka jawab
            if (entry.confirmCat) {
              if (['haan', 'han', 'yes', 'ji', 'bana do', 'banado', 'banao'].includes(lower)) {
                try { await saveGroupPending(primaryJid, fallbackJid, state, gIdx, entry.confirmCat); }
                catch (e) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` }); }
                continue;
              }
              entry.confirmCat = null; // list se pick — neeche normal flow
            }
            let pick = null;
            if (/^\d+$/.test(text)) {
              const num = parseInt(text, 10);
              const choices = await groupChoiceList();
              if (num >= 1 && num <= choices.length) pick = choices[num - 1];
              else {
                await sendMessageSafe(primaryJid, fallbackJid, { text: `Galat number. 1-${choices.length} ya naam reply karo, cancel ke liye 0.` }, { quoted: msg });
                continue;
              }
            } else {
              pick = (await resolveGroupCat(text))?.cat || null;
            }
            if (pick) {
              try { await saveGroupPending(primaryJid, fallbackJid, state, gIdx, pick); }
              catch (e) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` }); }
              continue;
            }
            await sendMessageSafe(primaryJid, fallbackJid, { text: `List me nahi — Vault admin se nayi category banao. 1-${(await groupChoiceList()).length} ya naam reply karo, cancel 0.` }, { quoted: msg });
            continue;
          }
          // bina-quote: cancel purana behavior, command neeche, baaki beech ki chat khamosh
          if (lower === '0' || ['cancel', 'rehne do', 'chor do', 'choro', 'rehnedo'].includes(lower)) {
            const dropped = state.pendingQueue.shift();
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Rehne di ❌ ${dropped ? dropped.filename : ''} upload nahi hui.` });
            continue;
          }
          const isCmd = /^(menu|main|help|\?|list|logout)$/.test(lower) || lower.includes('vault') || lower.includes('link');
          if (!isCmd) continue;
        }

        // ─── Number reply (for category selection) — line ki pehli file pe ───
        if (/^\d+$/.test(text) && pendingCount(state)) {
          if (isGroup) continue; // group me sirf image ko quoted reply chalta hai (upar handle)
          const num = parseInt(text);
          const cats = await getCats();
          const cur = state.pendingQueue[0];
          if (num >= 1 && num <= cats.length) {
            const cat = cats[num - 1];
            try {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, ${cat} me save ho raha hai...` });
              const fname = datedName(cur.filename);
              const out = await uploadToCloudinary(cur.buffer, fname, cat);
              state.pendingQueue.shift();
              let doneMsg = `Ho gaya!\nCategory: ${cat}\nFile: ${fname}\nLink: ${vaultFileLink(out.public_id, out.resource_type)}\n\nVault: ${VAULT_URL}`;
              if (pendingCount(state)) doneMsg += `\n\n${pendingCount(state)} aur baaki hain.\n\n` + await nextPrompt(state);
              await sendMessageSafe(primaryJid, fallbackJid, { text: doneMsg });
            } catch (e) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` });
            }
          } else if (num === cats.length + 1) {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Nayi category ka naam likh ke bhejo (jaise: My Files)` });
          } else if (num === 0) {
            const dropped = state.pendingQueue.shift();
            let msg = `Rehne di ❌ ${dropped ? dropped.filename : ''} upload nahi hui.`;
            if (pendingCount(state)) msg += `\n\n${pendingCount(state)} aur baaki hain.\n\n` + await nextPrompt(state);
            await sendMessageSafe(primaryJid, fallbackJid, { text: msg });
          } else {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Galat number. 0-${cats.length + 1} tak choose karo.` });
          }
          continue;
        }

        // ─── Password check — smart Roman Urdu ───
        if (!state.loggedIn) {
          const isPass = lower === AUTH_PASSWORD.toLowerCase() || lower === `login ${AUTH_PASSWORD.toLowerCase()}` || lower === `password ${AUTH_PASSWORD.toLowerCase()}`;
          if (isPass) {
            state.loggedIn = true; state.attempts = 0; state.mode=null; state.invoice=null; state._menuShown=false;
            await sendMessageSafe(primaryJid, fallbackJid, {
              text: `Login ho gaya!\n\n${mainMenuText()}\n\nVault: ${VAULT_URL}`
            });
            continue;
          }

          if (isGreeting(lower)) {
            const greet = lower.includes('salam') || lower.includes('aoa') ? 'Wa Alaikum Salam!' : 'Assalam o Alaikum!';
            await sendMessageSafe(primaryJid, fallbackJid, {
              text: `${greet} Live Tech Backup Bot me khush amdeed.\n\nFile bhejne ke liye pehle password bhejo, phir aap file upload kar sakte ho.`
            });
            continue;
          }

          state.attempts = (state.attempts || 0) + 1;
          if (state.attempts >= 5) {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `5 dafa galat password. Thori der baad try karo (15 min).` });
            setTimeout(() => { state.attempts = 0; }, 15 * 60 * 1000);
          } else {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Password galat hai. Dobara sahi password bhejo.` });
          }
          continue;
        }

        // ─── Invoice flow — handle if active ───
        if (state.invoice) {
          const inv = state.invoice;
          const isBack = ['back','piche','peeche','wapas','previous','b'].includes(lower);
          if (isBack) {
            const order = ['date','invoiceNo','client','description','qty','rate','brand','askMore'];
            const idx = order.indexOf(inv.step);
            if(idx>0){
              if(inv.step==='askMore' && inv.items && inv.items.length>0){
                const last = inv.items.pop();
                inv.description = last.description; inv.qty = String(last.qty); inv.rate = String(last.rate); inv.brand = last.brand;
              }
              inv.step = order[idx-1];
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Piche chale gaye.\n` + getStepPrompt(inv.step, inv) });
            } else {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Pehle se hi pehle step pe ho.` });
            }
            continue;
          }
          if (lower==='cancel' || lower==='menu' || lower==='exit') { state.invoice=null; await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice cancel ho gaya.\n\n${mainMenuText()}` }); continue; }
          // ensure items array
          if(!inv.items) inv.items=[];
          if (inv.step === 'date') {
            let d=null;
            if (lower==='today' || lower==='aaj') d=formatDateDDMMYYYY(new Date());
            else d=parseDateInput(text);
            if (!d) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Date samajh nahi aayi. Today likho ya DD-MM-YYYY me bhejo (jaise 04-09-2026)` }); continue; }
            inv.date=d; inv.step='invoiceNo';
            const next = getNextInvoiceNo();
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Date: ${d} save ho gayi.\nInvoice No ready hai: ${next} (last ${lastInvoiceNo} tha)\nYehi use karna hai to ${next} bhejo, ya apna number manually likho` });
            continue;
          }
          if (inv.step === 'invoiceNo') {
            if (!text || text.length<1) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice No khali nahi, dobara bhejo` }); continue; }
            const entered = text.trim();
            const num = entered.replace(/[^0-9]/g,'');
            if(!num || num.length<1){ await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice No number me bhejo (jaise 7779)` }); continue; }
            inv.invoiceNo=num;
            setLastInvoiceNo(parseInt(num,10));
            saveSerialToCloud().catch(()=>{});
            inv.step='client';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice # ${inv.invoiceNo} save ho gaya.\n${clientMenuText()}` });
            continue;
          }
          if (inv.step === 'client') {
            let clientName='';
            if (/^\d+$/.test(text)) {
              const n=parseInt(text);
              if(n>=1 && n<=CLIENTS.length) clientName=CLIENTS[n-1];
              else { await sendMessageSafe(primaryJid, fallbackJid, { text: `Galat number. 1-${CLIENTS.length} bhejo ya naya naam likho` }); continue; }
            } else {
              clientName=text.trim().slice(0,60);
              if(clientName.length<2){ await sendMessageSafe(primaryJid, fallbackJid, { text: `Client naam chhota hai, dobara bhejo` }); continue; }
            }
            inv.client=clientName; inv.step='description';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Client: ${clientName} save.\nAb Description bhejo (kaam ka naam) - back ke liye 'back' likho` });
            continue;
          }
          if (inv.step === 'description') {
            if (!text || text.length<2) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Description chhota hai, dobara bhejo` }); continue; }
            inv.description=text.trim(); inv.step='qty';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Description save.\nAb Qty bhejo (number, jaise 1 ya 5) - back: back` });
            continue;
          }
          if (inv.step === 'qty') {
            const q=parseFloat(text); if(isNaN(q)||q<=0){ await sendMessageSafe(primaryJid, fallbackJid, { text: `Qty number me bhejo, jaise 2` }); continue; }
            inv.qty=String(q); inv.step='rate';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Qty ${q} save.\nAb Rate / Unit Price bhejo (jaise 5000) - back: back` });
            continue;
          }
          if (inv.step === 'rate') {
            const r=parseFloat(text); if(isNaN(r)||r<0){ await sendMessageSafe(primaryJid, fallbackJid, { text: `Rate number me bhejo` }); continue; }
            inv.rate=String(r); inv.step='brand';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Rate ${r} save.\nAb Brand bhejo (optional hai, skip ke liye - bhejo) - back: back` });
            continue;
          }
          if (inv.step === 'brand') {
            inv.brand = (text.trim()==='-' ? '' : text.trim()); 
            // push current item to items
            if(!inv.items) inv.items=[];
            inv.items.push({ brand: inv.brand, description: inv.description, qty: inv.qty, rate: inv.rate, disc: 0 });
            // clear temp for next item
            inv.description=''; inv.qty=''; inv.rate=''; inv.brand='';
            inv.step='askMore';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Item ${inv.items.length} save ho gaya: ${inv.items[inv.items.length-1].description} | Qty ${inv.items[inv.items.length-1].qty} | Rate ${inv.items[inv.items.length-1].rate}\n\nAur item add karna hai?\n1. Haan, aur item\n2. Nahi, invoice generate karo\n\nBack: back (pichla item edit)` });
            continue;
          }
          if (inv.step === 'askMore') {
            if(lower==='1' || lower==='haan' || lower==='yes' || lower==='han'){
              inv.step='description';
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Next item:\nDescription bhejo (kaam ka naam) - back: back` });
              continue;
            }
            if(lower==='2' || lower==='nahi' || lower==='no' || lower==='generate' || lower==='n'){
              // Generate invoice now - multi items, only Excel
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, aapka invoice ban raha hai...` });
              try {
                const subtotal = inv.items.reduce((s,it)=> s + (Number(it.qty)||0)*(Number(it.rate)||0), 0);
                inv.discount='0'; inv.client=inv.client||'Walk-in Client';
                // prepare inv for excel - pass items
                const excelBuf=await generateInvoiceExcelBuffer({...inv, items: inv.items});
                let excelUrl='', idxPid='', idxRt='raw';
                try{
                  const b64=excelBuf.toString('base64');
                  const dataUri=`data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${b64}`;
                  const out2=await cloudinary.uploader.upload(dataUri, { folder:'live-tech-backup/Invoice', public_id: `Invoice-${inv.invoiceNo}.xlsx`, use_filename:true, unique_filename:true, resource_type:'raw' });
                  excelUrl=vaultFileLink(out2.public_id, out2.resource_type);
                  idxPid=out2.public_id; idxRt=out2.resource_type;
                }catch(e){ console.log('Excel gen fail',e.stack||e.message); throw e; }
                const total = subtotal;
                addInvIndex({ no: inv.invoiceNo, client: inv.client, date: inv.date, items: inv.items.length, total, public_id: idxPid, rt: idxRt }).catch(()=>{});
                let msg=`Ho gaya! Invoice ban gaya.\nInvoice #: ${inv.invoiceNo}\nDate: ${inv.date}\nClient: ${inv.client}\nItems: ${inv.items.length}\n`;
                inv.items.forEach((it,i)=>{ msg+=`${i+1}. ${it.description} | ${it.qty} x ${it.rate} = ${(Number(it.qty)*Number(it.rate)).toFixed(2)}${it.brand?' | '+it.brand:''}\n`; });
                msg+=`Total: ${total.toFixed(2)}\n\nExcel: ${excelUrl}\n\nVault: ${VAULT_URL}`;
                state.invoice=null;
                await sendMessageSafe(primaryJid, fallbackJid, { text: msg });
                await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
              } catch(e){
                state.invoice=null;
                await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice banane me error: ${e.message}` });
                await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
              }
              continue;
            }
            await sendMessageSafe(primaryJid, fallbackJid, { text: `1 bhejo (aur item) ya 2 bhejo (generate). Back: back` });
            continue;
          }
        }

        // ─── History mode — date aayi to record bhejo ───
        if (!isGroup && state.mode === 'history') {
          if (['menu', 'main', 'cancel', 'exit'].includes(lower)) {
            state.mode = null;
            await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
            continue;
          }
          let targets = [];
          if (lower === 'today' || lower === 'aaj' || lower === 'aj') targets = [formatDateDDMMYYYY(new Date())];
          else if (lower === 'yesterday' || lower === 'kal') { const d = new Date(); d.setDate(d.getDate() - 1); targets = [formatDateDDMMYYYY(d)]; }
          else {
            const rigid = parseDateInput(text);
            if (rigid) targets = [rigid];
            else {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Samajh raha hun... 🔍` });
              const aiD = await aiResolveDate(text);
              if (aiD) { targets = []; for (let i = 0; i < aiD.days; i++) targets.push(shiftDate(aiD.date, i)); }
            }
          }
          if (!targets.length) {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Date samajh nahi aayi. "5 din pehle", "1 mahine pehle" ya DD-MM-YYYY likho. Menu: menu` });
            continue;
          }
          await sendDateRecords(primaryJid, fallbackJid, targets);
          state.mode = null;
          await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
          continue;
        }

        // ─── Main menu after login — 3 options ───
        if (lower==='menu' || lower==='main' || lower==='1' || lower==='2' || lower==='3' || lower==='backup' || lower.includes('invoice') || lower.includes('purane') || lower.includes('history') || lower.includes('record')) {
          if (lower==='1' || lower==='backup' || lower==='1 backup') {
            state.mode='backup'; state.invoice=null;
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Backup mode on hai. Ab file bhejo (image, PDF, video, xlsx).` });
            continue;
          }
          if (lower==='2' || lower==='invoice' || lower.includes('invoice banao') || lower.includes('invoice banana') || lower.includes('new invoice')) {
            if (isGroup) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice DM me banao — mujhe personal chat me msg karo.` });
              continue;
            }
            state.mode='invoice'; state.invoice={step:'date', date:'', invoiceNo:'', client:'', description:'', qty:'', rate:'', brand:'', discount:'0', items:[]};
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice banana shuru.\nDate bhejo - Today likho ya custom date (DD-MM-YYYY) bhejo` });
            continue;
          }
          if (lower==='3' || lower.includes('purane') || lower.includes('history') || lower.includes('record')) {
            state.mode='history'; state.invoice=null;
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Kis date ka record chahiye?\nToday / Kal likho ya DD-MM-YYYY bhejo (jaise 04-09-2026).\nMenu: menu` });
            continue;
          }
          // if just menu/help, show menu
          if (lower==='menu' || lower==='main') {
            await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
            continue;
          }
        }
        // Auto show menu if no mode and no pending queue and no invoice
        if (!isGroup && !state.invoice && !pendingCount(state) && !['help','?','list','logout'].includes(lower) && !lower.includes('vault') && !lower.includes('link') && !lower.includes('madad')) {
          // if user just logged in and sends something else, show menu once
          if (!state._menuShown) {
            state._menuShown=true;
            await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
            continue;
          }
        }

        // ─── Logged in commands — smart ───
        if (lower === 'help' || lower === '?' || lower.includes('madad') || lower.includes('help')) {
          await sendMessageSafe(primaryJid, fallbackJid, {
            text: `Help:\n1. File bhejo (image/PDF/video)\n2. Category number choose karo (list me se)\n3. Upload ho jayega + link milega\n\nMenu: 1 backup • 2 invoice • 3 purane documents\nCommands:\nhelp - ye message\nlist - vault link dekho\nlogout - bahar niklo\nmenu - main menu`
          });
          continue;
        }
        if (lower === 'list' || lower.includes('vault') || lower.includes('link')) {
          await sendMessageSafe(primaryJid, fallbackJid, { text: `Vault: ${VAULT_URL}\nCategories: ${(await getCats()).join(' | ')}` });
          continue;
        }
        if (lower === 'logout' || lower.includes('bahar') || lower.includes('exit')) {
          state.loggedIn = false; state.invoice=null; state.mode=null; state._menuShown=false;
          await sendMessageSafe(primaryJid, fallbackJid, { text: `Logout ho gaya. Dobara login ke liye password bhejo.` });
          continue;
        }

        // ─── Custom category name (when pending file) — line ki pehli file pe ───
        if (pendingCount(state) && text && !/^\d+$/.test(text)) {
          if (isGroup) continue; // group me sirf image ko quoted reply chalta hai (upar handle)
          if (['cancel', 'rehne do', 'chor do', 'choro', 'rehnedo'].includes(lower)) {
            const dropped = state.pendingQueue.shift();
            let msg = `Rehne di ❌ ${dropped ? dropped.filename : ''} upload nahi hui.`;
            if (pendingCount(state)) msg += `\n\n${pendingCount(state)} aur baaki hain.\n\n` + await nextPrompt(state);
            await sendMessageSafe(primaryJid, fallbackJid, { text: msg });
            continue;
          }
          const catName = text.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30);
          if (catName) {
            const cur = state.pendingQueue[0];
            try {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, ${catName} me save ho raha hai...` });
              const fname = datedName(cur.filename);
              const out = await uploadToCloudinary(cur.buffer, fname, catName);
              noteNewCat(catName);
              state.pendingQueue.shift();
              let doneMsg = `Ho gaya!\nCategory: ${catName}\nFile: ${fname}\nLink: ${vaultFileLink(out.public_id, out.resource_type)}\n\nVault: ${VAULT_URL}`;
              if (pendingCount(state)) doneMsg += `\n\n${pendingCount(state)} aur baaki hain.\n\n` + await nextPrompt(state);
              await sendMessageSafe(primaryJid, fallbackJid, { text: doneMsg });
            } catch (e) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` });
            }
            continue;
          }
        }

        // ─── Handle media — block if invoice active ───
        const isImage = !!inner.imageMessage;
        const isDoc = !!inner.documentMessage;
        const isVideo = !!inner.videoMessage;
        if (state.invoice && (isImage || isDoc || isVideo)) {
          await sendMessageSafe(primaryJid, fallbackJid, { text: `Pehle invoice complete karo ya cancel likho.` });
          continue;
        }

        if (isImage || isDoc || isVideo) {
          const caption = cleanText(inner.imageMessage?.caption || inner.documentMessage?.caption || inner.videoMessage?.caption || '');
          const captionLower = caption.toLowerCase();
          let captionCat = null;
          for (const c of await getCats()) {
            if (captionLower.includes(c.toLowerCase())) { captionCat = c; break; }
          }
          const dlMsg = { ...msg, message: inner };

          if (captionCat && !isGroup) {
            try {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, ${captionCat} me save ho raha hai...` });
              const buffer = await downloadMediaMessage(dlMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
              let filename = inner.documentMessage?.fileName || caption.split('\n')[0] || `file-${Date.now()}`;
              if (!filename.includes('.')) { if (isImage) filename += '.jpg'; else if (isDoc) filename += '.pdf'; else filename += '.bin'; }
              filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
              filename = datedName(filename);
              const out = await uploadToCloudinary(buffer, filename, captionCat);
              noteNewCat(captionCat);
              await sendMessageSafe(primaryJid, fallbackJid, {
                text: `Ho gaya!\nCategory: ${captionCat}\nFile: ${filename}\nLink: ${vaultFileLink(out.public_id, out.resource_type)}\n\nVault: ${VAULT_URL}`
              });
            } catch (e) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` });
            }
          } else {
            try {
              const buffer = await downloadMediaMessage(dlMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
              let filename = inner.documentMessage?.fileName || `file-${Date.now()}`;
              if (!filename.includes('.') && isImage) filename += '.jpg';
              if (!filename.includes('.') && isVideo) filename += '.mp4';
              filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
              // Group: pehle NAAM — FILE ko reply karke naam likho, phir category POLL (caption me naam ho to direct poll)
              if (isGroup) {
                if (!state.pendingQueue) state.pendingQueue = [];
                const gIdx = state.pendingQueue.length;
                const entry = { buffer, filename, customName: null, awaitingName: true, fileMsg: msg, fileMsgId: msg.key?.id || null, pollMsgId: null, pollSecret: null, qid: null, nameQid: null, confirmCat: null, fallbackSent: false, busy: false, done: false, createdAt: Date.now() };
                state.pendingQueue.push(entry);
                const capName = (!captionCat && caption) ? cleanGroupName(caption.split('\n')[0]) : '';
                if (capName && capName.length >= 2) {
                  entry.customName = capName; entry.awaitingName = false;
                  await sendGroupPollFor(primaryJid, fallbackJid, state, gIdx);
                } else {
                  try {
                    const sent = await sendMessageSafe(primaryJid, fallbackJid, { text: `File mili ✅ ${filename}\nPehle iska NAAM likho — FILE ko reply karke bhejo, misal: blc ya blue light computer\n(0 likho to cancel)` }, { quoted: msg });
                    entry.nameQid = sent?.key?.id || null;
                  } catch {
                    const sent = await sendMessageSafe(primaryJid, fallbackJid, { text: `File mili ✅ ${filename}\nPehle iska NAAM likho — FILE ko reply karke bhejo, misal: blc ya blue light computer\n(0 likho to cancel)` });
                    entry.nameQid = sent?.key?.id || null;
                  }
                }
              } else {
                if (!state.pendingQueue) state.pendingQueue = [];
                state.pendingQueue.push({ buffer, filename });
                await sendMessageSafe(primaryJid, fallbackJid, { text: await nextPrompt(state) });
              }
            } catch (e) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `File read failed: ${e.message}` });
            }
          }
          continue;
        }

        // ─── Plain text category name (without file) ───
        const foundCat = (await getCats()).find(c => c.toLowerCase() === lower);
        if (foundCat) {
          await sendMessageSafe(primaryJid, fallbackJid, { text: `${foundCat} select hui. Ab is category me file bhejo.` });
          state.lastCat = foundCat;
          continue;
        }

        // Smart fallback — pehle AI intent, warna menu (group me khamosh, warna spam)
        if (!isGroup && lower.length > 2) {
          const ai = await aiIntent(text).catch(() => null);
          const intent = ai?.intent || 'unknown';
          if (intent === 'backup') {
            state.mode = 'backup'; state.invoice = null;
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Backup mode on hai. Ab file bhejo (image, PDF, video, xlsx).` });
          } else if (intent === 'invoice_start') {
            state.mode = 'invoice'; state.invoice = { step: 'date', date: '', invoiceNo: '', client: '', description: '', qty: '', rate: '', brand: '', discount: '0', items: [] };
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice banana shuru.\nDate bhejo - Today likho ya custom date (DD-MM-YYYY) bhejo` });
          } else if (intent === 'invoice_search') {
            const q = String(ai.client || '').toLowerCase().trim();
            const list = await loadInvIndex();
            const hits = list.filter(e => !q || String(e.client || '').toLowerCase().includes(q) || String(e.no || '').includes(q)).slice(0, 5);
            if (!hits.length) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Koi invoice nahi mila${q ? ` (${ai.client})` : ''}. Naya banana ho to 2 likho.` });
            } else {
              let out = `Mile ${hits.length} invoice:\n`;
              hits.forEach(e => { out += `#${e.no} | ${e.client || '—'} | ${e.total != null && e.total !== '' && !isNaN(Number(e.total)) ? Number(e.total).toFixed(2) : '—'}\n`; });
              hits.forEach(e => { if (e.public_id) out += `#${e.no}: ${vaultFileLink(e.public_id, e.rt || 'raw')}\n`; });
              await sendMessageSafe(primaryJid, fallbackJid, { text: out });
            }
          } else if (intent === 'date_search') {
            const d0 = String(ai.date || '').trim();
            if (/^\d{2}-\d{2}-\d{4}$/.test(d0)) {
              const n = Math.min(Math.max(parseInt(ai.days, 10) || 1, 1), 31);
              const tg = []; for (let i = 0; i < n; i++) tg.push(shiftDate(d0, i));
              await sendDateRecords(primaryJid, fallbackJid, tg);
            } else {
              await sendDateRecords(primaryJid, fallbackJid, []);
            }
          } else if (intent === 'list') {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Vault: ${VAULT_URL}\nCategories: ${(await getCats()).join(' | ')}` });
          } else if (intent === 'help') {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Help:\nFile bhejo (backup), 2 likho (invoice), 3 likho (purane documents), client naam likho (invoice search).\nCommands: help • list • logout • menu` });
          } else if (intent === 'logout') {
            state.loggedIn = false; state.invoice = null; state.mode = null; state._menuShown = false;
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Logout ho gaya. Dobara login ke liye password bhejo.` });
          } else if (intent === 'smalltalk' && ai.reply) {
            const clean = String(ai.reply).slice(0, 300).replace(/https?:\S+/g, '').trim();
            await sendMessageSafe(primaryJid, fallbackJid, { text: clean || `Ji! File bhejo ya help likho.` });
          } else {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Samajh nahi aaya. File bhejo, 2 likh ke invoice banao, ya help likho.` });
          }
        }

      } catch (err) {
        console.error('Handler error:', err.stack || err.message);
        try {
          const rawJid = msg.key.remoteJidAlt || msg.key.remoteJid;
          const fb = msg.key.remoteJidAlt ? msg.key.remoteJid : null;
          await sendMessageSafe(rawJid, fb, { text: `Error: ${err.message}` });
        } catch {}
      }
    }
  });

  // ─── Poll votes via messages.update (agar Baileys auto-decrypt emit kare — bonus path) ───
  sock.ev.on('messages.update', async (updates) => {
    try {
      for (const { key, update } of updates || []) {
        if (!update?.pollUpdates?.length) continue;
        const found = findPollEntry(key.id);
        if (!found) continue;
        const entry = found.state.pendingQueue[found.idx];
        if (entry.busy) continue;
        const creation = messageStore.get(msgKeyId(key));
        let agg = [];
        try {
          agg = getAggregateVotesInPollMessage({ message: creation?.message, pollUpdates: update.pollUpdates }, sock?.user?.id) || [];
        } catch {}
        const hit = agg.find(a => (a.voters || []).length > 0);
        if (!hit) continue;
        const opts = entry.pollOptions && entry.pollOptions.length ? entry.pollOptions : await loadPollConfig();
        const optIdx = opts.findIndex(o => o === hit.name);
        if (optIdx < 0) continue;
        const primaryJid = key.remoteJidAlt || key.remoteJid;
        const fallbackJid = key.remoteJidAlt ? key.remoteJid : null;
        if (hit.name === 'cancel') {
          found.state.pendingQueue.splice(found.idx, 1);
          await sendMessageSafe(primaryJid, fallbackJid, { text: `Rehne di ❌ ${entry.filename} upload nahi hui.` });
        } else {
          try { await saveGroupPending(primaryJid, fallbackJid, found.state, found.idx, hit.name); }
          catch (e) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` }); }
        }
      }
    } catch (e) { console.error('poll update error:', e.message); }
  });
}

// ─── Server ───
await loadSerialFromCloud(); // rebuild pe serial reset se bachao (cloud > local)
app.listen(PORT, () => {
  console.log(`Bot v2 running on port ${PORT}`);
  startBot();
});
