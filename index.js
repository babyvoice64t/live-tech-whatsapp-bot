import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  isJidBroadcast,
  isLidUser,
  jidNormalizedUser
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
// Simple in-memory CacheStore per official docs â€” no external dep needed
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
const DEFAULT_CATS = ['Transaction', 'Purchase Order', 'Invoice', 'Important'];

function msgKeyId(key) { return `${key.remoteJid}:${key.id}`; }

app.use(express.json());

// â”€â”€â”€ Dashboard â”€â”€â”€
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
<div class="stat"><div class="label">Status</div><div class="val" id="stConn">â€”</div></div>
<div class="stat"><div class="label">Users</div><div class="val" id="stUsers">0</div></div>
</div>
<div class="msg">Flow: msg â†’ password â†’ file â†’ category number â†’ upload â†’ link<br>
Commands: <b>help</b> Â· <b>list</b> Â· <b>logout</b><br>
No password hints Â· Anti-block 1s delay Â· Official Baileys v7</div>
</div>
<script>
async function poll(){try{const r=await fetch('/qr');const j=await r.json();
document.getElementById('stConn').textContent=j.connected?'Connected':'Disconnected';
document.getElementById('stConn').style.color=j.connected?'#16a34a':'#dc2626';
if(j.qr){document.getElementById('qrBox').innerHTML='<img src="'+j.qr+'">'}
else if(j.connected){document.getElementById('qrBox').innerHTML='<span class="ok">âœ… Connected â€” send a file to test</span>'}
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

app.post('/reset', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'wrong password' });
  try { sock?.end?.(undefined); } catch {}
  isConnected = false; qrString = null; reconnectAttempts = 0;
  try { fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true }); } catch {}
  messageStore.clear();
  console.log('ðŸ”„ Auth reset â€” restarting bot');
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

// â”€â”€â”€ Cloudinary Upload â€” via SDK (no manual signature, fixes preset error) â”€â”€â”€
async function uploadToCloudinary(buffer, filename, category) {
  const folder = `live-tech-backup/${category}`;
  // Use data URI so SDK handles signing correctly
  const base64 = buffer.toString('base64');
  const ext = filename.split('.').pop()?.toLowerCase() || 'bin';
  const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', pdf:'application/pdf', mp4:'video/mp4', mov:'video/quicktime', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls:'application/vnd.ms-excel', csv:'text/csv', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc:'application/msword', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt:'application/vnd.ms-powerpoint', zip:'application/zip', txt:'text/plain' };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const dataUri = `data:${mime};base64,${base64}`;
  try {
    const out = await cloudinary.uploader.upload(dataUri, {
      folder,
      public_id: filename.replace(/\.[^/.]+$/, '').slice(0,80),
      use_filename: true,
      unique_filename: true,
      resource_type: 'auto',
    });
    return out;
  } catch (e) {
    console.error('Cloudinary SDK error:', e.message);
    throw new Error(e.error?.message || e.message || 'cloudinary failed');
  }
}

function getState(jid) {
  const norm = jidNormalizedUser(jid);
  if (!userState.has(norm)) userState.set(norm, { loggedIn: false, attempts: 0, pendingFile: null, lastCat: null, rawJid: jid, mode: null, invoice: null });
  const s = userState.get(norm);
  s.rawJid = jid;
  return s;
}

function mainMenuText() {
  return `Main Menu:\n1. Backup add karna (file bhejo)\n2. Invoice banana\n\n1 ya 2 bhejo`;
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
    // Table grid
    const rowH=18; const rows=12; // show 12 rows like template (19-30)
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
    doc.font('Helvetica').fontSize(6).fillColor('#94A3B8').text('UA International â€¢ IT Solution provider â€¢ Generated by Live Tech Backup System', 32, 790, { align: 'center', width: 531 });
    doc.end();
  });
}
async function generateInvoiceExcelBuffer(inv) {
  const templatePath = path.join(__dirname, 'template.xlsm');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.readFile(templatePath); } catch(e){ console.log('Template load fail', e.message); throw e; }
  let ws = wb.getWorksheet('Sales Invoice');
  if(!ws) ws = wb.worksheets[0];
  // Exact overwrite - same file, same formatting, only values change (no clearing, no style change)
  try { ws.getCell('H6').value = inv.date; } catch {}
  try { ws.getCell('H7').value = String(inv.invoiceNo); } catch {}
  try { ws.getCell('F10').value = inv.client || 'Walk-in Client'; } catch {}
  // First invoice row only - keep all template formulas and styles intact
  try { ws.getCell('B19').value = 1; } catch {}
  try { ws.getCell('C19').value = inv.brand || ''; } catch {}
  try { ws.getCell('D19').value = inv.description; } catch {}
  try { ws.getCell('E19').value = Number(inv.qty)||0; } catch {}
  try { ws.getCell('F19').value = Number(inv.rate)||0; } catch {}
  try { ws.getCell('G19').value = Number(inv.discount)||0; } catch {}
  const lineTotal=(Number(inv.qty)||0)*(Number(inv.rate)||0)-(Number(inv.discount)||0);
  try { ws.getCell('D44').value = numberToWords(lineTotal); } catch {}
  // Let Excel formulas auto-calculate H19, H41, H43 - don't overwrite if formula exists
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function catMenu() {
  let lines = ['Category choose karo:\n'];
  DEFAULT_CATS.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  lines.push(`  ${DEFAULT_CATS.length + 1}. New Category (apna naam likho)`);
  lines.push(`\nNumber bhejo ya naam likho - jaise 1 ya Invoice`);
  return lines.join('\n');
}

function cleanText(t) {
  return (t || '').trim();
}

function isGreeting(text) {
  const l = text.toLowerCase();
  return ['hi','hello','hey','salam','asalam','assalam','aoa','aslam o alaikum','salam alaikum','start','help','hello bhai','salam bhai'].some(g => l.includes(g));
}

// Robust send: tries primary JID then fallback, logs every attempt per official docs
async function sendMessageSafe(primaryJid, fallbackJid, content) {
  const targets = [primaryJid, fallbackJid].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  let lastErr = null;
  for (const jid of targets) {
    try {
      const res = await sock.sendMessage(jid, content);
      console.log(`âœ… Sent to ${jid} ok=${!!res}`);
      return res;
    } catch (e) {
      lastErr = e;
      console.error(`âŒ Send failed to ${jid}: ${e.message}`);
    }
  }
  throw lastErr || new Error('send failed - no target');
}

// â”€â”€â”€ Bot Start â€” 100% Official Docs Compliant â”€â”€â”€
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();
  console.log(`ðŸ“¦ Baileys version: ${version.join('.')}`);

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
    console.log('ðŸ“‹ LID mapping update:', JSON.stringify(mapping).slice(0, 500));
  });

  sock.ev.on('groups.update', async ([event]) => {
    try { const metadata = await sock.groupMetadata(event.id); groupCache.set(event.id, metadata); } catch {}
  });

  sock.ev.on('group-participants.update', async (event) => {
    try { const metadata = await sock.groupMetadata(event.id); groupCache.set(event.id, metadata); } catch {}
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log('ðŸ”Œ connection.update:', JSON.stringify({ connection, hasQr: !!qr, code: lastDisconnect?.error?.output?.statusCode }));
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
        console.log('ðŸ”´ Logged out â€” deleted auth_info, need new QR');
      } else {
        if (reconnectAttempts >= MAX_RECONNECT) {
          console.log('â›” Max reconnect reached, waiting for manual reset');
          return;
        }
        reconnectAttempts++;
        const delay = Math.min(reconnectAttempts * 2000, 30000);
        console.log(`ðŸ”„ Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}) code=${statusCode}`);
        setTimeout(startBot, delay);
      }
    } else if (connection === 'open') {
      isConnected = true;
      reconnectAttempts = 0;
      qrString = null;
      console.log('âœ… Connected â€” id:', sock.user?.id);
    }
  });

  // â”€â”€â”€ Message Handler â€” Official: only type === 'notify', store via getMessage â”€â”€â”€
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`ðŸ“¨ messages.upsert: type=${type}, count=${messages.length}`);
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
      console.log('â­ï¸ skip: type is not notify');
      return;
    }
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) { console.log('â­ï¸ skip: no message or fromMe'); continue; }
        if (isJidBroadcast(msg.key.remoteJid)) { console.log('â­ï¸ skip: broadcast'); continue; }

        const rawJid = msg.key.remoteJid;
        const altJid = msg.key.remoteJidAlt || null;
        const isLid = isLidUser(rawJid);
        console.log(`ðŸ“© from=${rawJid} alt=${altJid || 'none'} isLid=${isLid} type=${Object.keys(msg.message)[0] || 'unknown'}`);

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

        await sleep(1000);

        // â”€â”€â”€ Number reply (for category selection) â”€â”€â”€
        if (/^\d+$/.test(text) && state.pendingFile) {
          const num = parseInt(text);
          if (num >= 1 && num <= DEFAULT_CATS.length) {
            const cat = DEFAULT_CATS[num - 1];
            try {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, ${cat} me save ho raha hai...` });
              const out = await uploadToCloudinary(state.pendingFile.buffer, state.pendingFile.filename, cat);
              await sendMessageSafe(primaryJid, fallbackJid, {
                text: `Ho gaya!\nCategory: ${cat}\nFile: ${state.pendingFile.filename}\nLink: ${out.secure_url}\n\nVault: ${VAULT_URL}`
              });
              state.pendingFile = null;
            } catch (e) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` });
            }
          } else if (num === DEFAULT_CATS.length + 1) {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Nayi category ka naam likh ke bhejo (jaise: My Files)` });
          } else {
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Galat number. 1-${DEFAULT_CATS.length + 1} tak choose karo.` });
          }
          continue;
        }

        // â”€â”€â”€ Password check â€” smart Roman Urdu â”€â”€â”€
        if (!state.loggedIn) {
          const isPass = lower === AUTH_PASSWORD.toLowerCase() || lower === `login ${AUTH_PASSWORD.toLowerCase()}` || lower === `password ${AUTH_PASSWORD.toLowerCase()}`;
          if (isPass) {
            state.loggedIn = true; state.attempts = 0; state.mode=null; state.invoice=null; state._menuShown=false;
            await sendMessageSafe(primaryJid, fallbackJid, {
              text: `Login ho gaya!\n\n${mainMenuText()}\n\nVault: ${VAULT_URL}`
            });
            continue;
          }

          if (isGreeting(lower) || lower.length < 10) {
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

        // â”€â”€â”€ Invoice flow â€” handle if active â”€â”€â”€
        if (state.invoice) {
          if (lower==='cancel' || lower==='menu' || lower==='exit') { state.invoice=null; await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice cancel ho gaya.\n\n${mainMenuText()}` }); continue; }
          const inv = state.invoice;
          if (inv.step === 'date') {
            let d=null;
            if (lower==='today' || lower==='aaj') d=formatDateDDMMYYYY(new Date());
            else d=parseDateInput(text);
            if (!d) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Date samajh nahi aayi. Today likho ya DD-MM-YYYY me bhejo (jaise 04-09-2026)` }); continue; }
            inv.date=d; inv.step='invoiceNo';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Date: ${d} save ho gayi.\nAb Invoice No bhejo (jaise 9265)` });
            continue;
          }
          if (inv.step === 'invoiceNo') {
            if (!text || text.length<1) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice No khali nahi, dobara bhejo` }); continue; }
            inv.invoiceNo=text.trim(); inv.step='description';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice # ${inv.invoiceNo} save.\nAb Description bhejo (kaam ka naam)` });
            continue;
          }
          if (inv.step === 'description') {
            if (!text || text.length<2) { await sendMessageSafe(primaryJid, fallbackJid, { text: `Description chhota hai, dobara bhejo` }); continue; }
            inv.description=text.trim(); inv.step='qty';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Description save.\nAb Qty bhejo (number, jaise 1 ya 5)` });
            continue;
          }
          if (inv.step === 'qty') {
            const q=parseFloat(text); if(isNaN(q)||q<=0){ await sendMessageSafe(primaryJid, fallbackJid, { text: `Qty number me bhejo, jaise 2` }); continue; }
            inv.qty=String(q); inv.step='rate';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Qty ${q} save.\nAb Rate / Unit Price bhejo (jaise 5000)` });
            continue;
          }
          if (inv.step === 'rate') {
            const r=parseFloat(text); if(isNaN(r)||r<0){ await sendMessageSafe(primaryJid, fallbackJid, { text: `Rate number me bhejo` }); continue; }
            inv.rate=String(r); inv.step='brand';
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Rate ${r} save.\nAb Brand bhejo (optional hai, skip ke liye - bhejo)` });
            continue;
          }
          if (inv.step === 'brand') {
            inv.brand = (text.trim()==='-' ? '' : text.trim()); 
            // Generate invoice now
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, aapka invoice ban raha hai...` });
            try {
              const lineTotal=(Number(inv.qty)||0)*(Number(inv.rate)||0);
              inv.discount='0'; inv.client=inv.client||'Walk-in Client';
              // PDF - exact template design
              const pdfBuf=await generateInvoicePdfBuffer(inv);
              const pdfName=`Invoice-${inv.invoiceNo}.pdf`;
              const pdfOut=await new Promise(async (res, rej)=>{
                try{
                  const b64=pdfBuf.toString('base64');
                  const dataUri=`data:application/pdf;base64,${b64}`;
                  const out=await cloudinary.uploader.upload(dataUri, { folder:'live-tech-backup/Invoice', public_id: pdfName.replace('.pdf',''), use_filename:true, unique_filename:true, resource_type:'auto' });
                  res(out);
                }catch(e){ rej(e); }
              });
              // Also Excel via template - exact same design
              let excelUrl='';
              try{
                const excelBuf=await generateInvoiceExcelBuffer(inv);
                const b64=excelBuf.toString('base64');
                const dataUri=`data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${b64}`;
                const out2=await cloudinary.uploader.upload(dataUri, { folder:'live-tech-backup/Invoice', public_id: `Invoice-${inv.invoiceNo}`, use_filename:true, unique_filename:true, resource_type:'raw' });
                excelUrl=out2.secure_url;
                // ensure .xlsx extension visible
                if(!excelUrl.endsWith('.xlsx')) excelUrl=excelUrl+'.xlsx';
              }catch(e){ console.log('Excel gen fail',e.message); }
              state.invoice=null;
              let msg=`Ho gaya! Invoice ban gaya.\nInvoice #: ${inv.invoiceNo}\nDate: ${inv.date}\nDescription: ${inv.description}\nQty: ${inv.qty} | Rate: ${inv.rate} | Brand: ${inv.brand||'-'}\nTotal: ${lineTotal.toFixed(2)}\n\nPDF: ${pdfOut.secure_url}`;
              if(excelUrl) msg+=`\nExcel: ${excelUrl}`;
              msg+=`\n\nVault: ${VAULT_URL}`;
              await sendMessageSafe(primaryJid, fallbackJid, { text: msg });
              await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
            } catch(e){
              state.invoice=null;
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice banane me error: ${e.message}` });
              await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
            }
            continue;
          }
        }

        // â”€â”€â”€ Main menu after login â€” 2 options â”€â”€â”€
        if (lower==='menu' || lower==='main' || lower==='1' || lower==='2' || lower==='backup' || lower.includes('invoice')) {
          if (lower==='1' || lower==='backup' || lower==='1 backup') {
            state.mode='backup'; state.invoice=null;
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Backup mode on hai. Ab file bhejo (image, PDF, video, xlsx).` });
            continue;
          }
          if (lower==='2' || lower.includes('invoice')) {
            state.mode='invoice'; state.invoice={step:'date', date:'', invoiceNo:'', description:'', qty:'', rate:'', brand:'', discount:'0'};
            await sendMessageSafe(primaryJid, fallbackJid, { text: `Invoice banana shuru.\nDate bhejo - Today likho ya custom date (DD-MM-YYYY) bhejo` });
            continue;
          }
          // if just menu/help, show menu
          if (lower==='menu' || lower==='main') {
            await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
            continue;
          }
        }
        // Auto show menu if no mode and no pendingFile and no invoice
        if (!state.invoice && !state.pendingFile && !['help','?','list','logout'].includes(lower) && !lower.includes('vault') && !lower.includes('link') && !lower.includes('madad')) {
          // if user just logged in and sends something else, show menu once
          if (!state._menuShown) {
            state._menuShown=true;
            await sendMessageSafe(primaryJid, fallbackJid, { text: mainMenuText() });
            continue;
          }
        }

        // â”€â”€â”€ Logged in commands â€” smart â”€â”€â”€
        if (lower === 'help' || lower === '?' || lower.includes('madad') || lower.includes('help')) {
          await sendMessageSafe(primaryJid, fallbackJid, {
            text: `Help:\n1. File bhejo (image/PDF/video)\n2. Category number choose karo (1-5)\n3. Upload ho jayega + link milega\n\nCommands:\nhelp - ye message\nlist - vault link dekho\nlogout - bahar niklo\nmenu - main menu`
          });
          continue;
        }
        if (lower === 'list' || lower.includes('vault') || lower.includes('link')) {
          await sendMessageSafe(primaryJid, fallbackJid, { text: `Vault: ${VAULT_URL}\nCategories: ${DEFAULT_CATS.join(' | ')}` });
          continue;
        }
        if (lower === 'logout' || lower.includes('bahar') || lower.includes('exit')) {
          state.loggedIn = false; state.invoice=null; state.mode=null; state._menuShown=false;
          await sendMessageSafe(primaryJid, fallbackJid, { text: `Logout ho gaya. Dobara login ke liye password bhejo.` });
          continue;
        }

        // â”€â”€â”€ Custom category name (when pending file) â”€â”€â”€
        if (state.pendingFile && text && !/^\d+$/.test(text)) {
          const catName = text.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30);
          if (catName && !DEFAULT_CATS.map(c => c.toLowerCase()).includes(catName.toLowerCase())) {
            try {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, ${catName} me save ho raha hai...` });
              const out = await uploadToCloudinary(state.pendingFile.buffer, state.pendingFile.filename, catName);
              await sendMessageSafe(primaryJid, fallbackJid, {
                text: `Ho gaya!\nCategory: ${catName}\nFile: ${state.pendingFile.filename}\nLink: ${out.secure_url}\n\nVault: ${VAULT_URL}`
              });
              state.pendingFile = null;
            } catch (e) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` });
            }
            continue;
          }
        }

        // â”€â”€â”€ Handle media â€” block if invoice active â”€â”€â”€
        const isImage = !!msg.message.imageMessage;
        const isDoc = !!msg.message.documentMessage;
        const isVideo = !!msg.message.videoMessage;
        if (state.invoice && (isImage || isDoc || isVideo)) {
          await sendMessageSafe(primaryJid, fallbackJid, { text: `Pehle invoice complete karo ya cancel likho.` });
          continue;
        }

        if (isImage || isDoc || isVideo) {
          const caption = cleanText(msg.message.imageMessage?.caption || msg.message.documentMessage?.caption || '');
          const captionLower = caption.toLowerCase();
          let captionCat = null;
          for (const c of DEFAULT_CATS) {
            if (captionLower.includes(c.toLowerCase())) { captionCat = c; break; }
          }

          if (captionCat) {
            try {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Thori der, ${captionCat} me save ho raha hai...` });
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
              let filename = msg.message.imageMessage?.caption?.split('\n')[0] || msg.message.documentMessage?.fileName || `file-${Date.now()}`;
              if (!filename.includes('.')) { if (isImage) filename += '.jpg'; else if (isDoc) filename += '.pdf'; else filename += '.bin'; }
              filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
              const out = await uploadToCloudinary(buffer, filename, captionCat);
              await sendMessageSafe(primaryJid, fallbackJid, {
                text: `Ho gaya!\nCategory: ${captionCat}\nFile: ${filename}\nLink: ${out.secure_url}\n\nVault: ${VAULT_URL}`
              });
            } catch (e) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `Upload failed: ${e.message}` });
            }
          } else {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
              let filename = msg.message.documentMessage?.fileName || `file-${Date.now()}`;
              if (!filename.includes('.') && isImage) filename += '.jpg';
              filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
              state.pendingFile = { buffer, filename };
              await sendMessageSafe(primaryJid, fallbackJid, { text: `${filename} ready hai\n\n` + catMenu() });
            } catch (e) {
              await sendMessageSafe(primaryJid, fallbackJid, { text: `File read failed: ${e.message}` });
            }
          }
          continue;
        }

        // â”€â”€â”€ Plain text category name (without file) â”€â”€â”€
        const foundCat = DEFAULT_CATS.find(c => c.toLowerCase() === lower);
        if (foundCat) {
          await sendMessageSafe(primaryJid, fallbackJid, { text: `${foundCat} select hui. Ab is category me file bhejo.` });
          state.lastCat = foundCat;
          continue;
        }

        // Smart fallback â€” agar kuch samajh na aaye
        if (lower.length > 2) {
          await sendMessageSafe(primaryJid, fallbackJid, { text: `Samajh nahi aaya. File bhejo ya help likho.` });
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
}

// â”€â”€â”€ Server â”€â”€â”€
app.listen(PORT, () => {
  console.log(`Bot v2 running on port ${PORT}`);
  startBot();
});
