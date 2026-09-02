import makeWASocket, { useMultiFileAuthState, downloadMediaMessage, DisconnectReason } from '@whiskeysockets/baileys';
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

// per-user state
const userState = new Map(); // jid -> { loggedIn:bool, attempts, pendingFile: {buffer, filename, type} }
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const DEFAULT_CATS = ['Transaction','Purchase Order','Invoice','Important'];

app.use(express.json());

app.get('/', (req,res)=>{
  res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Live Tech Bot</title>
  <style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f8f8f7;margin:0;padding:16px}.card{max-width:560px;margin:16px auto;background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:20px}h1{font-size:19px;margin:0}.mono{font-family:monospace;font-size:11px;color:#71717a;word-break:break-all}.qr{margin:16px 0;text-align:center;min-height:260px;display:grid;place-items:center;background:#fafafa;border:1px dashed #e4e4e7;border-radius:12px;padding:12px}.btn{height:36px;padding:0 16px;border-radius:999px;border:1px solid #e4e4e7;background:#fff;font-weight:600;font-size:12px;cursor:pointer}.btn-primary{background:#0E4D2A;color:#fff;border-color:#0E4D2A}.btn-danger{background:#fee2e2;color:#dc2626;border-color:#fecaca}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}@media(max-width:480px){.card{padding:16px}.qr img{width:100%!important;height:auto!important}}</style></head>
  <body><div class="card">
  <h1>Live Tech WhatsApp Bot</h1>
  <p class="mono">Vault: <a href="${VAULT_URL}" target="_blank">${VAULT_URL}</a> • Status: <span id="status">connecting...</span></p>
  <div class="qr" id="qrBox">Loading QR...</div>
  <div class="row"><button class="btn btn-primary" onclick="location.reload()">Refresh QR</button><button class="btn btn-danger" onclick="disconnectBot()">Disconnect</button><button class="btn" onclick="reconnectBot()">Reconnect</button></div>
  <p class="mono" style="margin-top:12px">Flow: pehla msg → help + password mango → bina password ke file block → file bhejo → category list (tap karo) → upload → link<br>Responsive • Anti-block delay 1.5s • Session saved</p>
  </div>
  <script>
    async function loadQR(){ try{ const r=await fetch('/qr'); const j=await r.json(); document.getElementById('status').textContent=j.connected?'Connected ✓':'Waiting for scan'; if(j.qr){ document.getElementById('qrBox').innerHTML='<img src="'+j.qr+'" style="width:260px;height:260px;border:1px solid #e4e4e7;border-radius:12px">'; } else if(j.connected){ document.getElementById('qrBox').innerHTML='<div style="color:#16a34a;font-weight:700">✓ Connected — send file to test</div>'; } else document.getElementById('qrBox').textContent='No QR yet, waiting...'; }catch(e){ document.getElementById('status').textContent='error'; } }
    async function disconnectBot(){ if(!confirm('Disconnect? Need QR again.')) return; const p=prompt('Admin password:'); if(!p) return; const r=await fetch('/disconnect',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password:p})}); const j=await r.json(); if(!r.ok) alert('Failed: '+(j.error||'wrong password')); else { alert('Disconnected'); location.reload(); } }
    async function reconnectBot(){ const p=prompt('Admin password:'); if(!p) return; const r=await fetch('/reconnect',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password:p})}); const j=await r.json(); if(!r.ok) alert('Failed: '+(j.error||'wrong password')); else { alert('Reconnecting...'); setTimeout(()=>location.reload(),5000); } }
    loadQR(); setInterval(loadQR,4000);
  </script></body></html>`);
});
function checkBotAuth(req){
  const pass = req.query.password || req.headers['x-password'] || req.headers['authorization']?.replace(/^Bearer\s+/i,'') || req.body?.password || '';
  return pass === AUTH_PASSWORD;
}
app.get('/qr', async (req,res)=>{
  // allow with password, but also allow without for initial setup (viewer can see status only)
  let qrDataUrl=null; if(qrString){ try{ qrDataUrl=await QRCode.toDataURL(qrString);}catch{} }
  res.json({qr:qrDataUrl, connected:isConnected});
});
app.get('/health', (req,res)=>res.json({ok:true, connected:isConnected}));
app.post('/disconnect', async (req,res)=>{
  if(!checkBotAuth(req)) return res.status(401).json({error:'Unauthorized - admin only'});
  try{ await sock?.logout(); }catch{}
  isConnected=false; qrString=null;
  try{ fs.rmSync(path.join(__dirname,'auth_info'),{recursive:true, force:true}); }catch{}
  res.json({ok:true});
});
app.post('/reconnect', async (req,res)=>{
  if(!checkBotAuth(req)) return res.status(401).json({error:'Unauthorized - admin only'});
  isConnected=false; qrString=null;
  try{ sock?.end?.(undefined);}catch{}
  setTimeout(()=>startBot(),1000);
  res.json({ok:true});
});

async function uploadToCloudinary(buffer, filename, category){
  const timestamp=Math.floor(Date.now()/1000);
  const folder=`live-tech-backup/${category}`;
  const params={ folder, timestamp, use_filename:'true', unique_filename:'true' };
  const toSign=Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join('&');
  const signature=crypto.createHash('sha1').update(toSign+API_SECRET).digest('hex');
  const FormData=(await import('form-data')).default;
  const fd=new FormData();
  fd.append('file', buffer, {filename});
  fd.append('api_key', API_KEY);
  fd.append('timestamp', String(timestamp));
  fd.append('signature', signature);
  fd.append('folder', folder);
  fd.append('use_filename','true');
  fd.append('unique_filename','true');
  const resp=await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`, {method:'POST', body:fd});
  const out=await resp.json();
  if(!resp.ok) throw new Error(out.error?.message||'cloudinary failed');
  return out;
}

function getState(jid){
  if(!userState.has(jid)) userState.set(jid,{loggedIn:false, attempts:0, pendingFile:null});
  return userState.get(jid);
}

async function sendCategoryList(jid){
  const rows = DEFAULT_CATS.map(c=>({ title: c, rowId: `cat_${c}` }));
  rows.push({ title: '+ New Category', rowId: 'cat_new' });
  try{
    await sock.sendMessage(jid, {
      text: `*Category select karo* — neeche list se tap karo:\n\nAgar nayi chahiye to *New Category* likh ke bhejo (jaise: My Files)`,
      footer: 'Live Tech Vault',
      title: 'Categories',
      buttonText: 'View Categories',
      sections: [{ title:'Categories', rows }]
    });
  }catch{
    // fallback to buttons if list fails
    await sock.sendMessage(jid, { text: `Category select karo — likh ke bhejo:\n• Transaction\n• Purchase Order\n• Invoice\n• Important\n\nNayi ke liye naam likho.` });
  }
}

async function startBot(){
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname,'auth_info'));
  sock=makeWASocket({
    auth:state,
    logger:pino({level:'silent'}),
    printQRInTerminal:false,
    browser:['Live Tech','Chrome','1.0'],
    markOnlineOnConnect:false,
    syncFullHistory:false,
    shouldSyncHistoryMessage:()=>false,
    getMessage: async()=>undefined,
    retryRequestDelayMs:1500
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update)=>{
    const {connection, lastDisconnect, qr}=update;
    if(qr) qrString=qr;
    if(connection==='close'){
      const reason=lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect=reason!==DisconnectReason.loggedOut && reason!==401;
      isConnected=false; qrString=null;
      if(shouldReconnect) setTimeout(startBot,4000);
    } else if(connection==='open'){ isConnected=true; qrString=null; console.log('✅ connected'); }
  });

  sock.ev.on('messages.upsert', async ({messages})=>{
    for(const msg of messages){
      if(!msg.message || msg.key.fromMe) continue;
      const jid=msg.key.remoteJid;
      const state=getState(jid);
      const text=msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.documentMessage?.caption || msg.message.videoMessage?.caption || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || msg.message.buttonsResponseMessage?.selectedButtonId || '';
      const lower=text.trim().toLowerCase();
      await sleep(800);

      // handle list/button response: cat_XXX
      if(text.startsWith('cat_')){
        const catRaw=text.slice(4);
        if(catRaw==='new'){
          await sock.sendMessage(jid, { text: `Nayi category ka naam likh ke bhejo (jaise: My Files)` });
          continue;
        }
        let category=catRaw;
        // find exact case from DEFAULT_CATS
        const found=DEFAULT_CATS.find(c=>c.toLowerCase()===catRaw.toLowerCase());
        if(found) category=found;
        if(state.pendingFile){
          try{
            await sock.sendMessage(jid, { text: `⏳ *${category}* me save ho raha hai...` });
            const out=await uploadToCloudinary(state.pendingFile.buffer, state.pendingFile.filename, category);
            await sock.sendMessage(jid, { text: `✅ Ho gaya! *${category}* me save\n📄 ${state.pendingFile.filename}\n🔗 ${out.secure_url}\n\nVault pe dekho: ${VAULT_URL}` });
            state.pendingFile=null;
          }catch(e){ await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }); }
        } else {
          await sock.sendMessage(jid, { text: `Category *${category}* select hui. Ab file bhejo to isme save hogi.` });
          state.lastCategory=category;
        }
        continue;
      }

      // password check - allow "Live@786" or "login Live@786"
      const isPassword = text.trim() === AUTH_PASSWORD || lower === `login ${AUTH_PASSWORD.toLowerCase()}` || lower === AUTH_PASSWORD.toLowerCase();
      if(!state.loggedIn){
        if(isPassword){
          state.loggedIn=true; state.attempts=0;
          await sock.sendMessage(jid, { text: `✅ *Password sahi hai!* Ab file bhejo.\n\n*Help:* image/pdf/document bhejo, caption me category likh do ya list se select karo.\nCategories: Transaction, Purchase Order, Invoice, Important\n\nVault: ${VAULT_URL}` });
          continue;
        }
        // welcome + ask password on first message
        if(lower==='help' || lower==='hi' || lower==='hello' || lower==='start'){
          await sock.sendMessage(jid, { text: `*As-salamu Alaikum! Live Tech Backup*\n\nPehle password bhejo: *${AUTH_PASSWORD}*\nBina password ke file save nahi hogi (security).\n\nHelp ke liye *help* likho.\nVault: ${VAULT_URL}` });
          continue;
        }
        // check attempts
        state.attempts=(state.attempts||0)+1;
        if(state.attempts>=3){
          await sock.sendMessage(jid, { text: `❌ 3 galat try. 10 min baad try karo.` });
          // block for 10 min
          setTimeout(()=>{ state.attempts=0; }, 10*60*1000);
          continue;
        }
        await sock.sendMessage(jid, { text: `🔒 Pehle password bhejo: *${AUTH_PASSWORD}*\nBina password ke file upload nahi hogi.\n\nHelp: *help*` });
        continue;
      }

      // logged in - handle help/list
      if(lower==='help'){
        await sock.sendMessage(jid, { text: `*Help — kaise use karein*\n\n1. File (image/pdf) bhejo\n2. List se category select karo (Transaction / Purchase Order / Invoice / Important) ya naya naam likho\n3. Upload ke baad link milega + Vault pe dikhega\n\nCommands:\n• *help* - ye help\n• *list* - vault link\n• *logout* - logout` });
        continue;
      }
      if(lower==='list'){
        await sock.sendMessage(jid, { text: `Vault: ${VAULT_URL}\nCategories: ${DEFAULT_CATS.join(', ')}` });
        continue;
      }
      if(lower==='logout'){
        state.loggedIn=false;
        await sock.sendMessage(jid, { text: `Logged out. Dobara login ke liye password bhejo.` });
        continue;
      }

      // check if message is new category name (when pendingFile exists and user typed custom category)
      if(state.pendingFile && text && !text.startsWith('cat_') && lower!=='help' && lower!=='list'){
        // treat typed text as new category if not a command
        const newCat=text.trim().replace(/[^a-zA-Z0-9 _-]/g,'').slice(0,30);
        if(newCat && !DEFAULT_CATS.map(c=>c.toLowerCase()).includes(newCat.toLowerCase())){
          // its a new category
          try{
            await sock.sendMessage(jid, { text: `⏳ Nayi category *${newCat}* me save ho raha hai...` });
            const out=await uploadToCloudinary(state.pendingFile.buffer, state.pendingFile.filename, newCat);
            await sock.sendMessage(jid, { text: `✅ Nayi category *${newCat}* me save ho gaya!\n📄 ${state.pendingFile.filename}\n🔗 ${out.secure_url}\n\nVault: ${VAULT_URL}` });
            state.pendingFile=null;
            continue;
          }catch(e){ await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }); continue; }
        }
      }

      // handle media
      const isImage=!!msg.message.imageMessage;
      const isDoc=!!msg.message.documentMessage;
      const isVideo=!!msg.message.videoMessage;
      if(isImage || isDoc || isVideo){
        // check caption for category
        let captionCat=null;
        const capLower=(msg.message.imageMessage?.caption || msg.message.documentMessage?.caption || '').toLowerCase();
        for(const c of DEFAULT_CATS){ if(capLower.includes(c.toLowerCase())){ captionCat=c; break; } }
        if(captionCat){
          try{
            await sock.sendMessage(jid, { text: `⏳ *${captionCat}* me save ho raha hai...` });
            const buffer=await downloadMediaMessage(msg,'buffer',{}, {logger:pino({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
            let filename=msg.message.imageMessage?.caption?.split('\n')[0] || msg.message.documentMessage?.fileName || `file-${Date.now()}.jpg`;
            if(!filename.includes('.')){ if(isImage) filename+='.jpg'; else if(isDoc) filename+='.pdf'; }
            filename=filename.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,80);
            const out=await uploadToCloudinary(buffer, filename, captionCat);
            await sock.sendMessage(jid, { text: `✅ *${captionCat}* me ho gaya!\n📄 ${filename}\n🔗 ${out.secure_url}\n\nVault: ${VAULT_URL}` });
          }catch(e){ await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }); }
        } else {
          // no category in caption -> store pending and ask
          try{
            const buffer=await downloadMediaMessage(msg,'buffer',{}, {logger:pino({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
            let filename=msg.message.documentMessage?.fileName || `file-${Date.now()}.jpg`;
            if(!filename.includes('.') && isImage) filename+='.jpg';
            filename=filename.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,80);
            state.pendingFile={buffer, filename};
            await sendCategoryList(jid);
          }catch(e){ await sock.sendMessage(jid, { text: `❌ File read failed: ${e.message}` }); }
        }
      } else if(text && state.loggedIn){
        // if user typed a category name without file, treat as lastCategory hint
        const foundCat=DEFAULT_CATS.find(c=>c.toLowerCase()===lower);
        if(foundCat){
          await sock.sendMessage(jid, { text: `Category *${foundCat}* select hui. Ab file bhejo to isme save hogi.` });
          state.lastCategory=foundCat;
        }
      }
    }
  });
}

app.listen(PORT, ()=> console.log('Bot on',PORT));
startBot();
