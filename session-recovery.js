// ─── Session persistence + missed-photo recovery (2026-10-31) ───
// Masla: Northflank ki disk ephemeral hai — container restart/redeploy par
// auth_info ur jata tha, bot har dafa QR mangta tha aur band doran aayi hui
// group photos hamesha ke liye reh jati thin.
// Hal: (1) poora auth_info Cloudinary par AUTHENTICATED raw asset me backup —
// boot par local session na mile to wahi se restore; deploy/restart par QR
// nahi mangega. WhatsApp khud logout kare to backup bhi delete (dead session
// restore nahi hota).
// (2) Recovery ledger (Cloudinary JSON): har saved file ka WhatsApp message
// id + MD5 hash + aakhri live-dekha-hua timestamp. Reconnect par history /
// queued messages me se SIRF wohi photos dobara uthti hain jo vault me
// pehle se NA hon — teen parakh: message-id, MD5-vs-vault-etag, time window.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const SESSION_PID = 'live-tech-backup/system/auth-session';
export const LEDGER_PID = 'live-tech-backup/system/recovery-ledger';
const MAX_LEDGER_ITEMS = 3000;

export function md5hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// ─── Auth dir <-> snapshot object (files are small JSON texts) ───
export function serializeAuthDir(authDir) {
  let names;
  try { names = fs.readdirSync(authDir); } catch { return null; }
  const files = {};
  let skipped = 0;
  for (const name of names) {
    if (name !== path.basename(name)) { skipped++; continue; }
    const full = path.join(authDir, name);
    try {
      if (!fs.statSync(full).isFile()) { skipped++; continue; }
      const text = fs.readFileSync(full, 'utf8');
      JSON.parse(text); // torn/mid-write file snapshot me nahi jayega
      files[name] = text;
    } catch { skipped++; }
  }
  if (!files['creds.json']) return null;
  return { v: 1, savedAt: Date.now(), files, skipped };
}

export function restoreAuthDir(authDir, snapshot) {
  if (!snapshot || !snapshot.files || !snapshot.files['creds.json']) return 0;
  fs.mkdirSync(authDir, { recursive: true });
  let written = 0;
  for (const [name, text] of Object.entries(snapshot.files)) {
    if (name !== path.basename(name)) continue; // path traversal guard
    try {
      JSON.parse(text);
      fs.writeFileSync(path.join(authDir, name), text);
      written++;
    } catch { /* kharab entry skip */ }
  }
  return written;
}

// ─── Session backup manager (Cloudinary, authenticated — ye credentials hain) ───
export function createSessionBackup(cloudinary, authDir, log = console) {
  let dirty = false;
  let flushing = false;
  let timer = null;
  let lastOkAt = 0;

  async function flush() {
    if (flushing) return false;
    const snap = serializeAuthDir(authDir);
    if (!snap) { dirty = false; return false; }
    flushing = true;
    try {
      const dataUri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(snap)).toString('base64');
      await cloudinary.uploader.upload(dataUri, {
        public_id: SESSION_PID, resource_type: 'raw', type: 'authenticated',
        overwrite: true, unique_filename: false, use_filename: false, invalidate: true,
      });
      dirty = false;
      lastOkAt = Date.now();
      log.log(`💾 session backup saved (${Object.keys(snap.files).length} files)`);
      return true;
    } catch (e) {
      log.error('session backup fail:', e.message);
      return false;
    } finally { flushing = false; }
  }

  return {
    markDirty() { dirty = true; },
    isDirty() { return dirty; },
    lastOkAt() { return lastOkAt; },
    flush,
    flushSoon(ms = 5000) { dirty = true; setTimeout(() => { if (dirty) flush(); }, ms); },
    startAutoFlush() {
      if (timer) return;
      timer = setInterval(() => { if (dirty) flush(); }, 30000);
      if (timer.unref) timer.unref();
    },
    async restoreIfNeeded() {
      const credsPath = path.join(authDir, 'creds.json');
      if (fs.existsSync(credsPath)) return 'local';
      try {
        const info = await cloudinary.api.resource(SESSION_PID, { resource_type: 'raw', type: 'authenticated' });
        if (!info) return 'none';
        const url = cloudinary.utils.url(SESSION_PID, {
          resource_type: 'raw', type: 'authenticated', sign_url: true, secure: true,
          ...(info.version ? { version: info.version } : {}),
        });
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) { log.error('session restore fetch fail:', r.status); return 'none'; }
        const snap = await r.json();
        const n = restoreAuthDir(authDir, snap);
        if (n > 0) { log.log(`♻️ session restored from cloud backup (${n} files, savedAt=${new Date(snap.savedAt || 0).toISOString()})`); return 'restored'; }
        return 'none';
      } catch (e) {
        log.log('session restore skip:', String(e.message || e).slice(0, 120));
        return 'none';
      }
    },
    async wipeRemote() {
      try {
        await cloudinary.uploader.destroy(SESSION_PID, { resource_type: 'raw', type: 'authenticated', invalidate: true });
        log.log('🗑️ session backup deleted (logged out)');
      } catch (e) { log.error('session backup delete fail:', e.message); }
    },
  };
}

// ─── Recovery ledger: saved message ids + content hashes + live watermark ───
export function createRecoveryLedger(cloudinary, log = console) {
  let data = { savedIds: [], savedHashes: [], lastLiveTs: 0 };
  let loaded = false;
  let persistChain = Promise.resolve();

  function trim() {
    if (data.savedIds.length > MAX_LEDGER_ITEMS) data.savedIds = data.savedIds.slice(-MAX_LEDGER_ITEMS);
    if (data.savedHashes.length > MAX_LEDGER_ITEMS) data.savedHashes = data.savedHashes.slice(-MAX_LEDGER_ITEMS);
  }

  async function persistNow() {
    const dataUri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(data)).toString('base64');
    await cloudinary.uploader.upload(dataUri, {
      public_id: LEDGER_PID, resource_type: 'raw',
      overwrite: true, unique_filename: false, use_filename: false, invalidate: true,
    });
  }

  const api = {
    get lastLiveTs() { return data.lastLiveTs || 0; },
    has(id) { return !!id && data.savedIds.includes(id); },
    hasHash(h) { return !!h && data.savedHashes.includes(h); },
    async load() {
      if (loaded) return data;
      loaded = true;
      try {
        const info = await cloudinary.api.resource(LEDGER_PID, { resource_type: 'raw' });
        const url = info?.secure_url || info?.url;
        if (url) {
          const r = await fetch(url, { cache: 'no-store' });
          if (r.ok) {
            const j = await r.json();
            if (j && Array.isArray(j.savedIds) && Array.isArray(j.savedHashes)) {
              data = { savedIds: j.savedIds, savedHashes: j.savedHashes, lastLiveTs: Number(j.lastLiveTs) || 0 };
              log.log(`📒 recovery ledger loaded: ${data.savedIds.length} ids, lastLiveTs=${data.lastLiveTs}`);
              return data;
            }
          }
        }
      } catch { /* pehli dafa — naya ledger */ }
      // Pehla run: sirf pichle 72 ghante ki history recovery ke liye khuli rakho
      data = { savedIds: [], savedHashes: [], lastLiveTs: Math.floor(Date.now() / 1000) - 72 * 3600 };
      log.log('📒 recovery ledger naya bana (window: 72h)');
      return data;
    },
    noteLiveSeen(tsSec) {
      // Load se pehle persist ho jaye to cloud wala asal ledger ur jayega — pehle load lazmi
      api.load().then(() => {
        const ts = Number(tsSec) || 0;
        if (ts > (data.lastLiveTs || 0)) {
          data.lastLiveTs = ts;
          persistChain = persistChain.then(persistNow).catch((e) => log.error('ledger persist fail:', e.message));
        }
      }).catch(() => {});
    },
    async recordSave(id, hash, tsSec) {
      await api.load();
      if (id && !data.savedIds.includes(id)) data.savedIds.push(id);
      if (hash && !data.savedHashes.includes(hash)) data.savedHashes.push(hash);
      const ts = Number(tsSec) || 0;
      if (ts > (data.lastLiveTs || 0)) data.lastLiveTs = ts;
      trim();
      persistChain = persistChain.then(persistNow).catch((e) => log.error('ledger persist fail:', e.message));
      await persistChain;
    },
    snapshot() { return { ids: data.savedIds.length, hashes: data.savedHashes.length, lastLiveTs: data.lastLiveTs }; },
  };
  return api;
}

// ─── Vault me pehle se maujood images ke etag (Cloudinary ka etag = file ka MD5) ───
export async function listVaultEtags(cloudinary, log = console) {
  const etags = new Set();
  let nextCursor = undefined;
  try {
    for (let page = 0; page < 6; page++) {
      const r = await cloudinary.api.resources({
        type: 'upload', resource_type: 'image', prefix: 'live-tech-backup/',
        max_results: 500, ...(nextCursor ? { next_cursor: nextCursor } : {}),
      });
      for (const res of r.resources || []) if (res.etag) etags.add(String(res.etag).toLowerCase());
      nextCursor = r.next_cursor;
      if (!nextCursor) break;
    }
  } catch (e) { log.error('etag list fail:', e.message); }
  return etags;
}
