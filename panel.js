
const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;
const FIELDS = ['prompts', 'prefix', 'suffix', 'delay', 'perPrompt', 'startAt', 'aspect', 'model', 'mode', 'res', 'dur', 'vmodel'];
const CHECKS = ['applySettings', 'allowCredits', 'zipVideos'];
let state = { results: {}, status: null, submitted: [] };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function fail(el, text) {
  el.className = 'status error';
  el.textContent = text;
  return null;
}

async function send(msg, statusEl = $('status')) {
  const tab = await activeTab();
  if (!tab) return fail(statusEl, 'No active tab found.');
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (_) {
    // Content script missing (tab opened before install or extension reloaded). Inject and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      return fail(statusEl, 'Could not attach to the page: ' + (e && e.message ? e.message : e));
    }
  }
}

// ---------- tabs ----------
function showTab(name) {
  const review = name === 'review';
  $('viewQueue').hidden = review;
  $('viewReview').hidden = !review;
  $('tabQueue').setAttribute('aria-selected', String(!review));
  $('tabReview').setAttribute('aria-selected', String(review));
  if (review) renderReview();
}
$('tabQueue').onclick = () => showTab('queue');
$('tabReview').onclick = () => showTab('review');

// ---------- queue tab ----------
const MODEL_ALIASES = { pro: 'nano banana pro', lite: 'nano banana 2 lite', '2 lite': 'nano banana 2 lite', '2.1': 'nano banana 2.1', '2': 'nano banana 2.1',
    omni: 'omni 1.1 flash', 'omni flash': 'omni 1.1 flash', 'omni 1.1 flash': 'omni 1.1 flash',
    'veo lite': 'veo 3.1 lite', 'veo fast': 'veo 3.1 fast', 'veo quality': 'veo 3.1 quality' };
const MODEL_OK = /^(nano banana|veo|omni)/;
const MODEL_SHORT = { 'nano banana pro': 'Pro', 'nano banana 2 lite': '2 Lite', 'nano banana 2.1': '2.1', 'omni 1.1 flash': 'Omni Flash', 'veo 3.1 lite': 'Veo Lite', 'veo 3.1 fast': 'Veo Fast', 'veo 3.1 quality': 'Veo Quality' };
// Same rules as content.js: "[...]" alone on a line is a settings change for the prompts after it.
function parseTokens(str) {
  const opts = {};
  for (const tok of str.split(',')) {
    const t = tok.trim().toLowerCase();
    if (!t) continue;
    if (/^\d+:\d+$/.test(t)) opts.aspect = t;
    else if (/^x[1-4]$/.test(t)) opts.count = Number(t.slice(1));
    else if (t === 'reset' || t === 'default') opts.reset = true;
    else if (/^(360|720)p$/.test(t)) opts.res = t;
    else if (/^(4|6|8|10)s$/.test(t)) opts.dur = t;
    else if (t === 'video' || t === 'image') opts.mode = t;
    else if (t === 'ingredients' || t === 'frames') opts.vmode = t;
    else { const m = MODEL_ALIASES[t] || t; if (m !== 'veo' && MODEL_OK.test(m)) opts.model = m; }
  }
  return opts;
}
function parsePrompts(raw) {
  const items = [];
  let sticky = {};
  for (const line of (raw || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const only = /^[\[{]([^\]}]*)[\]}]$/.exec(line);
    if (only) {
      const o = parseTokens(only[1]);
      if (o.reset) sticky = {};
      delete o.reset;
      sticky = { ...sticky, ...o };
      continue;
    }
    const m = /^[\[{]([^\]}]*)[\]}]\s*(.+)$/.exec(line);
    if (m) { const o = parseTokens(m[1]); delete o.reset; items.push({ text: m[2].trim(), opts: { ...sticky, ...o } }); }
    else items.push({ text: line, opts: { ...sticky } });
  }
  return items;
}
const promptItems = () => parsePrompts($('prompts').value);
const promptList = () => promptItems().map((i) => i.text);
const optsLabel = (o) => [o.mode, o.vmode, o.res, o.dur, o.aspect, o.count ? 'x' + o.count : '', o.model ? MODEL_SHORT[o.model] || o.model : ''].filter(Boolean).join(', ');
const want = () => Math.max(1, Number($('perPrompt').value) || 2);
const hasResults = () => Object.values(state.results || {}).some((r) => r.images && r.images.length);

function updateCount() {
  const n = promptList().length;
  $('count').textContent = n ? `${n} prompt${n === 1 ? '' : 's'} in the queue` : '';
}

function showTargets(s) {
  const manual = !!s.useManual;
  $('promptState').textContent = manual && s.promptTarget ? 'manual' : 'auto';
  $('buttonState').textContent = manual && s.btnTarget ? 'manual' : 'auto';
  $('promptState').className = 'tag' + (manual ? ' ok' : '');
  $('buttonState').className = 'tag' + (manual ? ' ok' : '');
}

function updateResume() {
  const st = state.status || {};
  const n = promptList().length;
  const next = Number(st.nextIndex) || 0;
  const show = st.state !== 'running' && next > 1 && next <= n;
  $('resume').hidden = !show;
  if (show) $('resume').textContent = `Resume at #${next}`;
}

function showStatus(st) {
  state.status = st || null;
  const el = $('status');
  el.className = 'status' + (st && st.state === 'error' ? ' error' : '');
  el.textContent = st && st.msg ? st.msg : '';
  if (st && (st.state === 'running' || st.state === 'error')) {
    $('reviewStatus').className = el.className;
    $('reviewStatus').textContent = el.textContent;
  }
  updateResume();
}

FIELDS.forEach((f) => $(f).addEventListener('input', () => {
  store.set({ [f]: $(f).value });
  if (f === 'prompts') { updateCount(); updateResume(); }
  if (f === 'prompts' || f === 'perPrompt') renderReview();
}));
['aspect', 'model', 'vmodel', 'mode', 'res', 'dur'].forEach((f) => $(f).addEventListener('change', () => store.set({ [f]: $(f).value })));
CHECKS.forEach((f) => $(f).addEventListener('change', () => store.set({ [f]: $(f).checked })));

$('pickPrompt').onclick = () => send({ type: 'pick', which: 'prompt' });
$('pickButton').onclick = () => send({ type: 'pick', which: 'button' });
$('useAuto').onclick = () => store.set({ useManual: false });
$('detect').onclick = async () => {
  const r = await send({ type: 'detect' });
  if (!r) return;
  const el = $('detectState');
  const ok = r.box && r.btn;
  el.className = 'tag' + (ok ? ' ok' : '');
  el.textContent = ok
    ? `found both (highlighted), ${r.images} image${r.images === 1 ? '' : 's'} on page`
    : `prompt box: ${r.box ? 'found' : 'missing'}, button: ${r.btn ? 'found' : 'missing'}`;
};
$('start').onclick = async () => {
  const startAt = Math.max(1, Number($('startAt').value) || 1);
  const fresh = startAt === 1;
  if (fresh && hasResults() && !confirm('Starting from prompt 1 replaces the images in the Review tab. Continue?')) return;
  if (fresh) state.submitted = [];
  await store.set({ status: { state: 'running', msg: 'Starting...', nextIndex: startAt }, ...(fresh ? { submitted: [] } : {}) });
  await send({ type: 'start', fresh });
};
$('resume').onclick = async () => {
  const next = Number((state.status || {}).nextIndex) || 1;
  $('startAt').value = String(next);
  await store.set({ startAt: String(next), status: { ...(state.status || {}), state: 'running', msg: 'Resuming...' } });
  await send({ type: 'start', fresh: false });
};
$('stop').onclick = () => send({ type: 'stop' });
$('testSettings').onclick = async () => {
  const el = $('settingsState');
  el.className = 'tag';
  el.textContent = 'Applying...';
  const target = { aspect: $('aspect').value, model: $('model').value, vmodel: $('vmodel').value, count: Math.min(4, want()), mode: $('mode').value, res: $('res').value, dur: $('dur').value };
  const r = await send({ type: 'testSettings', want: target, allowCredits: $('allowCredits').checked });
  if (!r) { el.textContent = ''; return; }
  const bits = [];
  if (r.error) bits.push(r.error);
  else {
    if (r.warn) bits.push(r.warn); else bits.push('Applied.');
    if (r.note) bits.push(r.note + '.');
    if (target.aspect) bits.push(r.aspectSeen ? `Flow shows ${r.aspectSeen} selected.` : 'Could not read which aspect is selected.');
  }
  $('settingsDebug').value = r.debug || '';
  el.className = 'tag' + (r.error || r.warn ? '' : ' ok');
  el.textContent = bits.join(' ');
};

$('dumpVideo').onclick = async () => {
  const r = await send({ type: 'dumpVideo' });
  $('videoDump').value = r && r.dump ? r.dump : 'No answer from the Flow page. Refresh the tab and try again.';
  $('videoDump').select();
};

$('dumpMenus').onclick = async () => {
  $('videoDump').value = 'Opening menus...';
  const r = await send({ type: 'dumpMenus' });
  $('videoDump').value = r && r.dump ? r.dump : 'No answer from the Flow page. Refresh the tab and try again.';
  $('videoDump').select();
};

// ---------- zip + downloads (run here, in the panel, so page CORS does not apply) ----------
// ZIP-START
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const dt = new Date();
    const dosTime = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
    const dosDate = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + size;
    }
    let csize = 0;
    central.forEach((b) => { csize += b.byteLength; });
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  // ZIP-END

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const slug = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extOf = (blob, im) => (im && im.kind === 'video' ? (/webm/.test(blob.type) ? 'webm' : 'mp4') : ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[blob.type] || 'png'));
const pad = (n) => String(n).padStart(3, '0');
const fileName = (row, n, blob) => `${pad(row.idx + 1)}_${slug(row.prompt)}_${n + 1}.${extOf(blob, row.images[n])}`;

// Ask once for access to the image hosts (the manifest only lists Google hosts up front).
async function ensureHosts(srcs) {
  try {
    const origins = [...new Set(srcs.filter((s) => /^https?:/.test(s)).map((s) => new URL(s).origin + '/*'))];
    if (!origins.length) return;
    if (await chrome.permissions.contains({ origins })) return;
    await chrome.permissions.request({ origins });
  } catch (_) { /* fall through; the fetch will report what failed */ }
}
const srcsOf = (rows) => rows.flatMap((r) => r.images.flatMap((i) => [i.src, i.hint].filter(Boolean)));

// Returns { blob } or { error }.
async function getBlob(src) {
  let err = '';
  try {
    const r = await fetch(src, { credentials: 'include' });
    if (r.ok) return { blob: await r.blob() };
    err = 'HTTP ' + r.status;
  } catch (e) { err = String((e && e.message) || e); }
  if (!/^(blob|data):/.test(src)) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'fetchimg', url: src });
      if (r && r.ok) {
        const bin = atob(r.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return { blob: new Blob([arr], { type: r.type }) };
      }
      err += ' / ' + (r && r.error);
    } catch (e) { err += ' / ' + String((e && e.message) || e); }
  }
  let host = '';
  try { host = new URL(src).host; } catch (_) { host = src.slice(0, 30); }
  return { error: `${err} (${host})` };
}

// Zips the kept (not skipped) files of the given rows. With "Put videos in the zip" off, each video is saved as its own file.
// Zips are split into parts of about 250 MB so a big batch of videos cannot exhaust the panel's memory.
async function exportRows(rows, zipName) {
  const lines = rows.map((row) => `${pad(row.idx + 1)}: ${row.prompt}`);
  const promptsTxt = new TextEncoder().encode(lines.join('\n') + '\n');
  const zipV = $('zipVideos').checked;
  const CAP = 250 * 1024 * 1024;
  let files = [], bytes = 0, part = 0, items = 0, videos = 0, failed = 0, lastErr = '';
  const flush = () => {
    if (!files.length) return;
    part++;
    if (part === 1) files.push({ name: 'prompts.txt', data: promptsTxt });
    saveBlob(makeZip(files), part === 1 ? zipName : zipName.replace(/\.zip$/, `-part${part}.zip`));
    files = []; bytes = 0;
  };
  for (const row of rows) {
    for (let n = 0; n < row.images.length; n++) {
      const im = row.images[n];
      if (im.rejected) continue;
      const r = await getBlob(im.src);
      if (!r.blob) { failed++; lastErr = r.error + (im.guessed ? ' (this video link was guessed from the thumbnail)' : ''); continue; }
      items++;
      if (im.kind === 'video') videos++;
      if (im.kind === 'video' && !zipV) { saveBlob(r.blob, fileName(row, n, r.blob)); await sleep(600); continue; }
      const data = new Uint8Array(await r.blob.arrayBuffer());
      if (files.length && bytes + data.length > CAP) { flush(); await sleep(600); }
      files.push({ name: fileName(row, n, r.blob), data });
      bytes += data.length;
    }
  }
  if (!items) return { ok: false, error: lastErr ? 'Nothing could be fetched: ' + lastErr : 'Nothing to download (all skipped?).' };
  if (files.length) flush();
  else saveBlob(new Blob([promptsTxt], { type: 'text/plain' }), 'prompts.txt');
  return { ok: true, count: items, failed, videos, parts: part, separate: !zipV ? videos : 0 };
}

const sortedRows = () => Object.values(state.results || {}).filter((r) => r.images && r.images.length).sort((a, b) => a.idx - b.idx);

async function downloadAll() {
  const rows = sortedRows();
  await ensureHosts(srcsOf(rows));
  return exportRows(rows, 'flow-images.zip');
}
async function downloadPrompt(i) {
  const row = (state.results || {})[i];
  if (!row) return { ok: false, error: 'Nothing to download for this prompt.' };
  await ensureHosts(srcsOf([row]));
  return exportRows([row], `${pad(i + 1)}_${slug(row.prompt)}.zip`);
}
async function downloadOne(i, k) {
  const row = (state.results || {})[i];
  const img = row && row.images[k];
  if (!img) return { ok: false, error: 'Image not found.' };
  await ensureHosts([img.src, img.hint].filter(Boolean));
  const r = await getBlob(img.src);
  if (!r.blob) return { ok: false, error: 'Could not fetch this ' + (img.kind === 'video' ? 'video' : 'image') + ': ' + r.error + (img.guessed ? ' (the video link was guessed from the thumbnail)' : '') };
  saveBlob(r.blob, fileName(row, k, r.blob));
  return { ok: true };
}

// ---------- review tab ----------
function openZoom(src) {
  const wrap = document.createElement('div');
  wrap.className = 'zoom';
  const img = document.createElement('img');
  img.src = src;
  wrap.appendChild(img);
  wrap.onclick = () => wrap.remove();
  document.body.appendChild(wrap);
}

const reviewMsg = (text, isError) => { const el = $('reviewStatus'); el.className = 'status' + (isError ? ' error' : ''); el.textContent = text; };
const saveResults = (results) => { state.results = results; renderReview(); return store.set({ results }); };

function missingIdx() {
  const n = promptList().length;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!(state.submitted || []).includes(i)) continue; // never submitted yet, so not "missing"
    const row = (state.results || {})[i];
    if (!row || row.images.length < ((row && row.want) || want())) out.push(i);
  }
  return out;
}

async function rerun(idxs) {
  const results = { ...(state.results || {}) };
  idxs.forEach((i) => { delete results[i]; });
  await saveResults(results);
  reviewMsg(`Re-running ${idxs.length} prompt${idxs.length === 1 ? '' : 's'}...`);
  await store.set({ status: { ...(state.status || {}), state: 'running', msg: 'Starting...' } });
  await send({ type: 'start', only: idxs, fresh: false }, $('reviewStatus'));
}

async function moveImage(i, k, to) {
  const results = { ...(state.results || {}) };
  const row = results[i];
  if (!row || !row.images[k]) return;
  const [im] = row.images.splice(k, 1);
  if (!row.images.length) delete results[i];
  const dest = results[to] || (results[to] = { idx: to, prompt: promptList()[to], images: [], want: want() });
  dest.images.push(im);
  await saveResults(results);
}

async function swapPrompts(i, j) {
  const results = { ...(state.results || {}) };
  const a = results[i], b = results[j];
  const prompts = promptList();
  const mk = (idx, row) => (row ? { ...row, idx, prompt: prompts[idx] } : null);
  const na = mk(i, b), nb = mk(j, a);
  delete results[i]; delete results[j];
  if (na) results[i] = na;
  if (nb) results[j] = nb;
  await saveResults(results);
}

async function toggleSkip(i, k) {
  const results = { ...(state.results || {}) };
  const im = results[i] && results[i].images[k];
  if (!im) return;
  im.rejected = !im.rejected;
  await saveResults(results);
}

function mini(label, fn, cls) {
  const b = document.createElement('button');
  b.className = cls || 'ghost';
  b.textContent = label;
  b.onclick = fn;
  return b;
}

function renderReview() {
  const items = promptItems();
  const prompts = items.map((i) => i.text);
  const results = state.results || {};
  const box = $('cards');
  box.textContent = '';
  let complete = 0;
  prompts.forEach((p, i) => {
    const row = results[i];
    const n = row ? row.images.length : 0;
    const kept = row ? row.images.filter((im) => !im.rejected).length : 0;
    const need = (row && row.want) || want();
    if (n >= need) complete++;
    const card = document.createElement('div');
    card.className = 'card' + (n ? '' : ' empty') + (n && n < need ? ' incomplete' : '');

    const head = document.createElement('div');
    head.className = 'card-head';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const lab = optsLabel(items[i].opts);
    meta.textContent = (n ? `Prompt ${i + 1}, ${n} image${n === 1 ? '' : 's'}${kept < n ? ` (${kept} kept)` : ''}` : `Prompt ${i + 1}, no images yet`) + (lab ? ` · ${lab}` : '');
    head.appendChild(meta);
    if (n && n < need) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = `${n} of ${need}`;
      head.appendChild(b);
    }
    if (n && row.images.some((im) => im.by === 'order')) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.title = 'Matched by submission order. Check these against the prompt.';
      b.textContent = 'check';
      head.appendChild(b);
    }
    if (n || prompts.length > 1) {
      const sw = document.createElement('select');
      sw.className = 'swap';
      sw.setAttribute('aria-label', 'Swap images with another prompt');
      sw.add(new Option('Swap...', ''));
      prompts.forEach((_, j) => { if (j !== i) sw.add(new Option(`with ${j + 1}`, String(j))); });
      sw.onchange = () => { if (sw.value !== '') swapPrompts(i, Number(sw.value)); };
      head.appendChild(sw);
    }
    if (n) head.appendChild(mini('Save set', async () => {
      reviewMsg('Preparing zip...');
      const r = await downloadPrompt(i).catch((e) => ({ ok: false, error: String(e) }));
      if (!r.ok) reviewMsg(r.error, true); else reviewMsg(`Downloaded ${r.count} file${r.count === 1 ? '' : 's'}${r.separate ? ` (${r.separate} videos saved separately)` : ''}${r.parts > 1 ? ` in ${r.parts} zips` : ''}.`);
    }));
    head.appendChild(mini(n ? 'Redo' : 'Run', () => {
      if (n && !confirm(`Replace the current images for prompt ${i + 1}?`)) return;
      rerun([i]);
    }));
    card.appendChild(head);

    const text = document.createElement('p');
    text.className = 'prompt';
    text.textContent = p;
    card.appendChild(text);

    if (n) {
      const grid = document.createElement('div');
      grid.className = 'thumbs';
      row.images.forEach((im, k) => {
        const t = document.createElement('div');
        t.className = 'thumb' + (im.rejected ? ' rejected' : '');
        if (im.kind === 'video') { t.classList.add('video'); if (im.guessed) t.title = 'Video link guessed from the thumbnail'; }
        const img = document.createElement('img');
        img.src = im.thumb || (im.kind === 'video' ? '' : im.src);
        img.alt = `Result ${k + 1} for prompt ${i + 1}`;
        img.onclick = () => openZoom(im.thumb || im.src);
        const skip = mini(im.rejected ? 'Keep' : 'Skip', () => toggleSkip(i, k));
        skip.classList.add('skip');
        const dl = mini('Save', async () => {
          const r = await downloadOne(i, k);
          if (!r.ok) reviewMsg(r.error, true);
        });
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', 'Move this image to another prompt');
        const first = new Option('Move to...', '');
        sel.add(first);
        prompts.forEach((_, j) => { if (j !== i) sel.add(new Option(`Prompt ${j + 1}`, String(j))); });
        sel.onchange = () => { if (sel.value !== '') moveImage(i, k, Number(sel.value)); };
        if (im.kind === 'video') { const vb = document.createElement('span'); vb.className = 'vbadge'; vb.textContent = '\u25B6 video'; t.append(vb); }
        t.append(img, skip, dl, sel);
        grid.appendChild(t);
      });
      card.appendChild(grid);
    }
    box.appendChild(card);
  });

  $('reviewCount').textContent = prompts.length ? `${complete}/${prompts.length}` : '';
  const missing = missingIdx();
  $('retryMissing').disabled = !missing.length;
  $('retryMissing').textContent = missing.length ? `Retry missing (${missing.length})` : 'Retry missing';
  $('downloadAll').disabled = !hasResults();
  if (!prompts.length) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'Add prompts in the Queue tab. Generated images will appear next to each prompt.';
    box.appendChild(empty);
  }
}

$('downloadAll').onclick = async () => {
  reviewMsg('Preparing zip...');
  const r = await downloadAll().catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) return reviewMsg(r.error, true);
  reviewMsg(`Downloaded ${r.count} file${r.count === 1 ? '' : 's'}${r.separate ? ` (${r.separate} video${r.separate === 1 ? '' : 's'} saved separately)` : ''}${r.parts > 1 ? ` in ${r.parts} zips` : ''}${r.failed ? `, ${r.failed} could not be fetched` : ''}.`);
};
$('retryMissing').onclick = () => {
  const idxs = missingIdx();
  if (!idxs.length) return;
  const withImages = idxs.filter((i) => (state.results || {})[i]).length;
  if (withImages && !confirm(`${withImages} of these prompts have some images already. They will be replaced. Continue?`)) return;
  rerun(idxs);
};
$('clearResults').onclick = () => {
  if (hasResults() && !confirm('Remove all images from the Review tab? Downloaded files are not affected.')) return;
  state.submitted = [];
  store.set({ results: {}, submitted: [] });
};

// ---------- boot ----------
async function load() {
  const s = await store.get([...FIELDS, ...CHECKS, 'promptTarget', 'btnTarget', 'useManual', 'status', 'results', 'submitted']);
  FIELDS.forEach((f) => { if (s[f] !== undefined) $(f).value = s[f]; });
  CHECKS.forEach((f) => { $(f).checked = !!s[f]; });
  if (s.zipVideos === undefined) $('zipVideos').checked = true;
  state.results = s.results || {};
  state.submitted = s.submitted || [];
  showTargets(s);
  showStatus(s.status);
  updateCount();
  renderReview();
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.status) showStatus(changes.status.newValue);
  if (changes.submitted) { state.submitted = changes.submitted.newValue || []; renderReview(); }
  if (changes.results) { state.results = changes.results.newValue || {}; renderReview(); }
  if (changes.promptTarget || changes.btnTarget || changes.useManual) store.get(['promptTarget', 'btnTarget', 'useManual']).then(showTargets);
});

load();
