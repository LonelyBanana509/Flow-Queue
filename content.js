// Flow Queue - content script. Runs inside the Flow page.
(() => {
  // A newer copy of this script takes over; older (orphaned) copies stop themselves.
  const myToken = Math.random().toString(36).slice(2);
  window.__flowQueueToken = myToken;
  const alive = () => window.__flowQueueToken === myToken;
  const ctxOk = () => { try { return !!chrome.runtime.id; } catch (_) { return false; } };

  const store = chrome.storage.local;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stopRequested = false;
  let running = false;
  const halted = () => stopRequested || !alive() || !ctxOk();

  // ---------- helpers ----------
  const setStatus = async (patch) => {
    try {
      const { status } = await store.get('status');
      await store.set({ status: { ...(status || {}), ...patch } });
    } catch (_) { /* extension was reloaded; ignore */ }
  };

  const bg = async (msg) => {
    try { return await chrome.runtime.sendMessage(msg); } catch (_) { return null; }
  };
  const cdp = (action, extra) => bg({ type: 'cdp', action, ...extra });

  function badge(text) {
    let el = document.getElementById('__fq_badge');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = '__fq_badge';
      el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#14171f;color:#e7e9ee;font:13px system-ui,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        parts.unshift('#' + CSS.escape(el.id));
        break;
      }
      let part = el.tagName.toLowerCase();
      const aria = el.getAttribute('aria-label');
      if (aria && document.querySelectorAll(`${part}[aria-label="${aria.replace(/"/g, '\\"')}"]`).length === 1) {
        parts.unshift(`${part}[aria-label="${aria.replace(/"/g, '\\"')}"]`);
        break;
      }
      const sibs = el.parentElement ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function resolve(target) {
    if (!target) return null;
    try {
      const el = document.querySelector(target.sel);
      if (el) return el;
    } catch (_) {}
    if (target.text) {
      const wanted = target.text.trim().toLowerCase();
      return [...document.querySelectorAll('button,[role="button"]')].find((b) => (b.innerText || '').trim().toLowerCase() === wanted) || null;
    }
    return null;
  }

  // ---------- element picker ----------
  function pick(which) {
    return new Promise((resolvePick) => {
      const hint = document.createElement('div');
      hint.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#14171f;color:#e7e9ee;font:14px system-ui,sans-serif;padding:10px 16px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.5)';
      hint.textContent = which === 'prompt' ? 'Click the prompt box. Esc to cancel.' : 'Click the generate button. Esc to cancel.';
      document.body.appendChild(hint);

      let last = null;
      const clear = () => { if (last) { last.style.outline = last.__fqOutline || ''; last = null; } };
      const over = (e) => {
        clear();
        last = e.target;
        last.__fqOutline = last.style.outline;
        last.style.outline = '2px solid #7aa2ff';
      };
      const done = (value) => {
        clear();
        hint.remove();
        document.removeEventListener('mouseover', over, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', key, true);
        resolvePick(value);
      };
      const click = (e) => {
        e.preventDefault();
        e.stopPropagation();
        let el = e.target;
        el = which === 'prompt'
          ? el.closest('textarea,input,[contenteditable="true"],[role="textbox"]') || el
          : el.closest('button,[role="button"]') || el;
        done({ sel: cssPath(el), text: which === 'button' ? (el.innerText || '').trim() : '' });
      };
      const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
      document.addEventListener('mouseover', over, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
    });
  }

  // ---------- auto-detection ----------
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 20 && r.height > 10 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  function autoBox() {
    const cands = [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""],[role="textbox"],input[type="text"]')].filter(visible);
    if (!cands.length) return null;
    const score = (el) => {
      const near = [el, el.parentElement, el.parentElement && el.parentElement.parentElement].filter(Boolean);
      const text = near.map((n) => `${n.getAttribute('placeholder') || ''} ${n.getAttribute('aria-label') || ''} ${n.getAttribute('data-placeholder') || ''} ${(n.innerText || '').slice(0, 120)}`).join(' ').toLowerCase();
      const r = el.getBoundingClientRect();
      let s = (r.top / window.innerHeight) + Math.min(r.width / window.innerWidth, 1) * 2;
      if (/what do you want|create|prompt|describe|generate/.test(text)) s += 10;
      return s;
    };
    return cands.sort((a, b) => score(b) - score(a))[0];
  }

  function autoBtn(box) {
    if (!box) return null;
    const br = box.getBoundingClientRect();
    let node = box;
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      const btns = [...node.querySelectorAll('button,[role="button"]')]
        .filter((b) => visible(b) && !box.contains(b) && Math.abs(b.getBoundingClientRect().top - br.bottom) < 250);
      if (btns.length < 2) continue;
      const score = (b) => {
        const t = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.innerText || ''}`.toLowerCase();
        let s = b.getBoundingClientRect().right;
        if (/generate|create|submit|send|arrow_forward|arrow_upward/.test(t)) s += 5000;
        return s;
      };
      return btns.sort((a, b) => score(b) - score(a))[0];
    }
    return null;
  }

  // ---------- page actions ----------
  function setPromptSynthetic(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }
  }

  async function setPrompt(el, text) {
    el.focus();
    const r = await cdp('type', { text });
    if (!r || !r.ok) { setPromptSynthetic(el, text); return 'synthetic'; }
    return 'trusted';
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function pressEnter(el) {
    el.focus();
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  async function clickEl(el) {
    el.scrollIntoView({ block: 'center' });
    await sleep(150);
    const r = el.getBoundingClientRect();
    const res = await cdp('click', { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    if (!res || !res.ok) realClick(el);
  }

  async function enterKey(el) {
    el.focus();
    const res = await cdp('enter', {});
    if (!res || !res.ok) pressEnter(el);
  }

  const boxText = (el) => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : (el.innerText || el.textContent || '')).trim();

  // Returns how the prompt was submitted: 'click', 'enter' or 'unknown'.
  async function submit(box, btn) {
    const before = boxText(box);
    await clickEl(btn);
    await sleep(1500);
    if (boxText(box) !== before || !boxText(box)) return 'click';
    await enterKey(box);
    await sleep(1500);
    if (boxText(box) !== before || !boxText(box)) return 'enter';
    return 'unknown';
  }

  const isEnabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';

  async function waitForEnabled(getBtn, minDelayMs, maxWaitMs) {
    const start = Date.now();
    await sleep(minDelayMs);
    while (Date.now() - start < maxWaitMs) {
      if (halted()) return;
      const btn = getBtn();
      if (btn && isEnabled(btn)) return;
      await sleep(1000);
    }
  }

  async function countdown(ms, i, total) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (halted()) return;
      const left = Math.ceil((end - Date.now()) / 1000);
      await setStatus({ state: 'running', msg: `Image ${i} of ${total} submitted. Next in ${left}s` });
      await sleep(Math.min(1000, end - Date.now()));
    }
  }

  // ---------- image capture ----------
  // New images that show up on the page are matched to prompts in submission order.
  const keyOf = (src) => src.split('?')[0];
  const known = new Set();
  const blobCache = new Map();
  let pending = []; // prompts submitted and still waiting for images
  let watcher = null;
  let watcherBusy = false;
  let lastSubmitAt = 0;
  let perPrompt = 2;

  function scanImages() {
    const seen = new Set();
    const out = [];
    for (const im of document.images) {
      const src = im.currentSrc || im.src;
      if (!src || !im.complete || im.naturalWidth < 200 || im.naturalHeight < 200) continue;
      if (im.closest('#__fq_badge') || im.closest('flow-video-tile')) continue;
      const key = keyOf(src);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ el: im, src, key });
    }
    return out;
  }

  async function getBlob(src, el) {
    if (blobCache.has(src)) return blobCache.get(src);
    let blob = null;
    try {
      const r = await fetch(src, { credentials: 'include' });
      if (r.ok) blob = await r.blob();
    } catch (_) {}
    if (!blob && !/^(blob|data):/.test(src)) {
      const r = await bg({ type: 'fetchimg', url: src });
      if (r && r.ok) {
        const bin = atob(r.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        blob = new Blob([arr], { type: r.type });
      }
    }
    if (!blob && el) {
      try {
        const c = document.createElement('canvas');
        c.width = el.naturalWidth; c.height = el.naturalHeight;
        c.getContext('2d').drawImage(el, 0, 0);
        blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      } catch (_) {}
    }
    if (blob) blobCache.set(src, blob);
    return blob;
  }

  async function makeThumb(blob) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  async function saveResult(entry, image) {
    const { results } = await store.get('results');
    const all = results || {};
    const row = all[entry.idx] || { idx: entry.idx, prompt: entry.prompt, images: [] };
    row.want = entry.want || perPrompt;
    row.images.push(image);
    all[entry.idx] = row;
    await store.set({ results: all });
  }

  // Match an image to its prompt by the text Flow shows around it (alt text or the nearest
  // container that mentions one of our prompts). Returns null when it cannot tell.
  const norm = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let submittedEntries = [];
  function findOwner(imgEl, entries) {
    if (!imgEl || !entries.length) return null;
    const pickFrom = (text) => {
      const hits = entries.filter((e) => e.needle && text.includes(e.needle));
      if (!hits.length) return null;
      const distinct = hits.filter((h) => !hits.some((o) => o !== h && o.needle.length > h.needle.length && o.needle.includes(h.needle)));
      const ids = new Set(distinct.map((h) => h.idx));
      return ids.size === 1 ? distinct[0] : 'ambiguous';
    };
    for (const t of [imgEl.alt, imgEl.getAttribute('aria-label'), imgEl.title].map(norm).filter(Boolean)) {
      const r = pickFrom(t);
      if (r && r !== 'ambiguous') return r;
    }
    let node = imgEl.parentElement;
    for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) {
      const r = pickFrom(norm(node.innerText));
      if (r) return r === 'ambiguous' ? null : r;
    }
    return null;
  }

  // ---------- Flow settings (aspect ratio, model, count) ----------
  // Per-prompt syntax: [16:9, x2, pro] prompt text
  const MODEL_ALIASES = { pro: 'nano banana pro', lite: 'nano banana 2 lite', '2 lite': 'nano banana 2 lite', '2.1': 'nano banana 2.1', '2': 'nano banana 2.1',
    omni: 'omni 1.1 flash', 'omni flash': 'omni 1.1 flash', 'omni 1.1 flash': 'omni 1.1 flash',
    'veo lite': 'veo 3.1 lite', 'veo fast': 'veo 3.1 fast', 'veo quality': 'veo 3.1 quality' };
  const MODEL_OK = /^(nano banana|veo|omni)/;
  // Turns "16:9, x2, pro" into { aspect, count, model }. Unknown words are ignored; "reset" clears sticky settings.
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
      else {
        const m = MODEL_ALIASES[t] || t;
        if (m !== 'veo' && MODEL_OK.test(m)) opts.model = m;
      }
    }
    return opts;
  }
  // "[16:9, pro] prompt text" changes settings for that one prompt.
  function parseLine(line) {
    const m = /^[\[{]([^\]}]*)[\]}]\s*(.+)$/.exec(line);
    if (!m) return { text: line, opts: {} };
    const opts = parseTokens(m[1]);
    delete opts.reset;
    return { text: m[2].trim(), opts };
  }
  // A line that is only "[...]" or "{...}" changes settings for every prompt after it, until changed again.
  function parseAll(raw) {
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
      const one = parseLine(line);
      items.push({ text: one.text, opts: { ...sticky, ...one.opts } });
    }
    return items;
  }

  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const cleanText = (el) => norm(el.textContent).replace(/^[^a-z0-9]+/, '');
  const OPT_SEL = 'button,[role="button"],[role="radio"],[role="tab"],[role="option"],[role="menuitem"],[role="menuitemradio"],[role="combobox"],li,div,span';
  function findAllByText(text, scope) {
    return [...(scope || document).querySelectorAll(OPT_SEL)].filter((el) => el.textContent.length < 40 && cleanText(el) === text && shown(el));
  }

  // The settings panel is the area that holds the x1..x4 row and the aspect ratios.
  function findPanel() {
    for (const a of findAllByText('x1')) {
      let n = a.parentElement;
      for (let d = 0; n && d < 4; d++, n = n.parentElement) {
        if (!findAllByText('x4', n).length) continue;
        let p = n;
        for (let k = 0; p && k < 8; k++, p = p.parentElement) {
          if (findAllByText('16:9', p).length || findAllByText('9:16', p).length) return { root: p, row: n };
        }
        return { root: n, row: n };
      }
    }
    return null;
  }

  // The chip near the send arrow shows model and count, e.g. "Nano Banana 2.1  x2".
  function findChip() {
    const cands = [...document.querySelectorAll('button,[role="button"],div,span')].filter((el) => {
      if (!visible(el)) return false;
      const t = norm(el.textContent);
      return t.length < 60 && /x[1-4]\b/.test(t) && /nano banana|veo|omni|video|image/.test(t);
    });
    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    const isBtn = (el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
    cands.sort((a, b) => (isBtn(b) - isBtn(a)) || (area(a) - area(b)));
    return cands[0] || null;
  }

  const flatTxt = (s) => norm(s).replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const modelTrigger = (root) => root.querySelector('button[aria-label="Select model family"]') ||
    [...root.querySelectorAll('button,[role="button"],[role="combobox"]')].filter((el) => visible(el) && el.textContent.length < 40 && /^(nano banana|veo|omni)/.test(cleanText(el)))
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;
  // The model Flow shows on the model button in the panel (the chip does not show it in video mode).
  function readModelText() {
    const p = findPanel();
    const t = p && modelTrigger(p.root);
    return t ? flatTxt(t.textContent).replace(/ arrow drop down$/, '') : '';
  }

  async function chooseModel(name) {
    const panel = findPanel();
    if (!panel) return false;
    const trig = modelTrigger(panel.root);
    if (!trig) return false;
    await clickEl(trig);
    await sleep(600);
    const want = flatTxt(name);
    const wds = want.split(' ');
    const items = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],.mat-mdc-menu-item,.mat-mdc-option')].filter((el) => shown(el) && !trig.contains(el));
    let opt = items.find((el) => flatTxt(el.textContent).endsWith(want)) || items.find((el) => wds.every((w) => flatTxt(el.textContent).includes(w)));
    if (!opt) opt = findAllByText(name).find((el) => el !== trig && !trig.contains(el) && !el.contains(trig));
    if (!opt) { await cdp('escape', {}); return false; }
    await clickEl(opt);
    await sleep(600);
    const now = readModelText();
    return !now || wds.every((w) => now.includes(w));
  }


  const BTN_SEL = 'button,[role="radio"],[role="button"],[role="tab"]';
  const ASPECTS = ['16:9', '4:3', '1:1', '3:4', '9:16'];

  // Wait until the panel stops moving (it animates open), so click coordinates are right.
  async function settle() {
    let last = '';
    for (let i = 0; i < 12; i++) {
      const p = findPanel();
      const r = p ? JSON.stringify(p.root.getBoundingClientRect()) : '';
      if (r && r === last) return;
      last = r;
      await sleep(150);
    }
  }

  // The aspect ratios are Angular Material toggle buttons (role=radio, aria-checked).
  // Each holds an icon ligature plus a label such as "16:9", so match on the label element.
  function aspectRadios(root) {
    const out = {};
    for (const r of root.querySelectorAll('[role="radio"]')) {
      const leaves = [...r.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => norm(e.textContent));
      const label = ASPECTS.find((l) => leaves.includes(l));
      if (label && !out[label]) out[label] = r;
    }
    return out;
  }

  function aspectState() {
    const p = findPanel();
    if (!p) return null;
    const radios = aspectRadios(p.root);
    const present = ASPECTS.filter((l) => radios[l]);
    if (present.length < 2) return null;
    const on = (b) => b.getAttribute('aria-checked') === 'true' || /mat-button-toggle-checked/.test((b.closest('.mat-button-toggle') || {}).className || '');
    const hit = present.find((l) => on(radios[l]));
    return hit || '';
  }

  function dumpState() {
    const lines = [];
    const chip = findChip();
    lines.push('chip: ' + (chip ? chip.textContent.replace(/\s+/g, ' ').trim() : 'none'));
    lines.push('parsed: ' + JSON.stringify(readFlowSettings()));
    const p = findPanel();
    if (!p) return lines.concat('panel not open').join('\n');
    const radios = aspectRadios(p.root);
    for (const l of ASPECTS) {
      const b = radios[l];
      if (!b) { lines.push(l + ': missing'); continue; }
      const attrs = [...b.attributes].map((a) => `${a.name}=${a.value.slice(0, 40)}`).join(' ');
      lines.push(`${l}: <${b.tagName.toLowerCase()} ${attrs}> bg=${getComputedStyle(b).backgroundColor} text="${b.textContent.replace(/\s+/g, ' ').trim()}"`);
    }
    return lines.join('\n');
  }

  async function parkMouse() {
    const p = findPanel();
    if (!p) return;
    const r = p.root.getBoundingClientRect();
    await cdp('move', { x: Math.max(2, r.left - 40), y: Math.max(2, r.top - 40) });
  }

  // Click an aspect ratio and check that it took; retries with other click methods.
  async function setAspect(a) {
    await settle();
    for (let attempt = 0; attempt < 4; attempt++) {
      const p = findPanel();
      if (!p) return { ok: false };
      const btn = aspectRadios(p.root)[a];
      if (!btn) return { ok: false };
      if (attempt === 0) await clickEl(btn);
      else if (attempt === 1) btn.click();
      else if (attempt === 2) realClick(btn);
      else { btn.focus(); await cdp('space', {}); }
      await sleep(400);
      await parkMouse();
      await sleep(150);
      const now = aspectState();
      if (now === a) return { ok: true, verified: true };
      if (now === null) return { ok: true, verified: false };
    }
    return { ok: false };
  }


  // Generic option picker for the video panel (mode, Ingredients/Frames, resolution, duration).
  const optOn = (b) => {
    const t = b.closest('.mat-button-toggle') || b;
    return b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-selected') === 'true' || b.getAttribute('aria-pressed') === 'true' ||
      /mat-button-toggle-checked|\bselected\b|\bactive\b|\bchecked\b/.test(t.className || '');
  };
  const optState = (b) => (optOn(b) ? true : (['aria-checked', 'aria-selected', 'aria-pressed'].some((a) => b.hasAttribute(a)) ? false : null));
  const chipHas = (label) => { const ch = findChip(); return !!ch && new RegExp('(^|[\\s·•|])' + label + '($|[\\s·•|])').test(norm(ch.textContent)); };
  async function setOption(label, viaChip) {
    if (viaChip && chipHas(label)) return { ok: true, verified: true };
    await settle();
    for (let attempt = 0; attempt < 4; attempt++) {
      const p = findPanel();
      if (!p) return { ok: false };
      const el = findAllByText(label, p.root).map((e) => e.closest(BTN_SEL) || e)[0];
      if (!el) return { ok: false };
      if (optOn(el) || (viaChip && chipHas(label))) return { ok: true, verified: true };
      if (attempt === 0) await clickEl(el); else if (attempt === 1) el.click(); else if (attempt === 2) realClick(el); else { el.focus(); await cdp('space', {}); }
      await sleep(500);
      await parkMouse();
      await sleep(150);
      const p2 = findPanel();
      const el2 = p2 && findAllByText(label, p2.root).map((e) => e.closest(BTN_SEL) || e)[0];
      if ((el2 && optOn(el2)) || (viaChip && chipHas(label))) return { ok: true, verified: true };
      if (el2 && optState(el2) === null && attempt >= 1) return { ok: true, verified: false };
    }
    return { ok: false };
  }
  const isVideoChip = () => { const c = findChip(); return !!c && /^[^a-z0-9]*video/.test(norm(c.textContent)); };

  // Dump what is on the page for a video tile, plus the settings panel, so the capture code can be written from real markup.
  async function dumpVideo() {
    const out = [];
    const short = (t, n) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n || 80);
    const desc = (el) => {
      const a = [...el.attributes].filter((x) => !/^(style|d|viewbox)$/i.test(x.name)).map((x) => `${x.name}=${x.value.slice(0, 60)}`).join(' ');
      return `<${el.tagName.toLowerCase()} ${a}>`;
    };
    out.push('url: ' + location.href);
    const chip = findChip();
    out.push('chip: ' + (chip ? short(chip.textContent, 120) : 'none'));
    out.push('');
    const vids = [...document.querySelectorAll('video')];
    out.push(`== ${vids.length} <video> element(s) ==`);
    vids.forEach((v, n) => {
      out.push(`#${n} ${desc(v)}`);
      out.push(`   src=${(v.currentSrc || v.src || '').slice(0, 160)} poster=${(v.poster || '').slice(0, 160)} readyState=${v.readyState} duration=${v.duration} paused=${v.paused} size=${v.videoWidth}x${v.videoHeight} shown=${shown(v)}`);
      const srcs = [...v.querySelectorAll('source')].map((s) => s.src.slice(0, 120));
      if (srcs.length) out.push('   sources: ' + srcs.join(' | '));
      let node = v.parentElement;
      for (let d = 1; node && node !== document.body && d <= 8; d++, node = node.parentElement) {
        out.push(`   up${d} ${desc(node)} text="${short(node.innerText, 70)}"`);
      }
      const r = v.getBoundingClientRect();
      out.push(`   rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    out.push('');
    const imgs = [...document.querySelectorAll('img')].filter((i) => shown(i) && i.naturalWidth > 100);
    out.push(`== ${imgs.length} large <img> element(s) (could be video posters) ==`);
    imgs.slice(0, 12).forEach((i, n) => out.push(`#${n} ${desc(i)} nat=${i.naturalWidth}x${i.naturalHeight} in-video-tile=${!!(i.parentElement && i.parentElement.querySelector('video'))}`));
    out.push('');
    const thumbs = [...document.querySelectorAll('img')].filter((i) => /video thumbnail/i.test(i.alt || ''));
    out.push(`== ${thumbs.length} video thumbnail(s) (img alt "Generated video thumbnail") ==`);
    thumbs.slice(0, 3).forEach((im, n) => {
      const r = im.getBoundingClientRect();
      out.push(`#${n} ${desc(im)} nat=${im.naturalWidth}x${im.naturalHeight} rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} shown=${shown(im)}`);
      let node = im.parentElement;
      for (let d = 1; node && node !== document.body && d <= 12; d++, node = node.parentElement) {
        out.push(`   up${d} ${desc(node).slice(0, 220)} text="${short(node.innerText, 110)}"`);
      }
    });
    out.push('');
    const tiles = [...document.querySelectorAll('flow-grid-tile-container')];
    out.push(`== ${tiles.length} tile container(s) ==`);
    tiles.slice(0, 20).forEach((t, n) => {
      const kids = [...t.querySelectorAll('*')].map((x) => x.tagName.toLowerCase()).filter((x) => x.startsWith('flow-'));
      const inner = [...new Set(kids)].join(',');
      out.push(`#${n} label="${short(t.getAttribute('aria-label'), 80)}" inner=[${inner}] video=${t.querySelectorAll('video').length} img=${t.querySelectorAll('img').length} text="${short(t.innerText, 60)}"`);
    });
    out.push('');
    out.push('== fetch probe (reads 1 byte of each, to see if the file URLs can be fetched) ==');
    const probe = async (label, url) => {
      if (!url) return;
      out.push(`${label} url(${url.length} chars)=${url.slice(0, 300)}`);
      try {
        const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include' });
        out.push(`   page fetch: status=${r.status} type=${r.headers.get('content-type')} range=${r.headers.get('content-range')} length=${r.headers.get('content-length')}`);
      } catch (err) { out.push('   page fetch failed: ' + err); }
      out.push('   background probe: ' + JSON.stringify(await bg({ type: 'probe', url })));
    };
    if (vids[0]) await probe('video', vids[0].currentSrc || vids[0].src);
    const th0 = thumbs[0];
    if (th0) { await probe('thumbnail', th0.currentSrc || th0.src); await probe('thumbnail + video suffix (guess)', (th0.currentSrc || th0.src).replace(SUFFIX_RE, '') + '=mm,22,15'); }
    if (vids[0] && th0) out.push('thumbnail url equals video url: ' + ((th0.currentSrc || th0.src) === (vids[0].currentSrc || vids[0].src)));
    out.push('');
    const busy = [...document.querySelectorAll('div,span,p')].filter((e) => e.children.length < 4 && shown(e) && /\b\d{1,3}\s?%|generating|queued|in progress|processing/i.test(e.textContent) && e.textContent.length < 40);
    out.push(`== ${busy.length} progress-looking element(s) ==`);
    busy.slice(0, 10).forEach((e) => out.push(`${desc(e)} text="${short(e.textContent, 40)}" parent=${e.parentElement ? desc(e.parentElement).slice(0, 140) : ''}`));
    out.push('');
    const dl = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,li')].filter((e) => /download|more_vert|save|share/i.test((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')) && e.textContent.length < 60);
    out.push(`== ${dl.length} download/menu-looking control(s) ==`);
    dl.slice(0, 15).forEach((e) => out.push(`${desc(e)} text="${short(e.textContent, 40)}" visible=${shown(e)}`));
    out.push('');
    const p = findPanel();
    out.push('== settings panel ==');
    if (!p) out.push('panel not open (open the settings chip in Flow, then press the button again)');
    else {
      out.push('credits text: ' + ((/(\d+)\s*credits?/i.exec(p.root.textContent) || [])[0] || 'none'));
      const ctl = [...p.root.querySelectorAll('button,[role="radio"],[role="tab"],[role="combobox"],[role="option"],[role="menuitemradio"]')].filter(shown);
      ctl.slice(0, 50).forEach((e) => out.push(`${desc(e).slice(0, 200)} text="${short(e.textContent, 40)}" on=${optOn(e)}`));
    }
    return out.join('\n');
  }


  // Opens the model menu and a video tile's "More options" menu, lists their items without clicking any, and closes them again.
  async function dumpMenus() {
    const out = [];
    const short = (t, n) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n || 80);
    const desc = (el) => `<${el.tagName.toLowerCase()} ${[...el.attributes].filter((x) => !/^(style|d|viewbox|_ngcontent.*|_nghost.*)$/i.test(x.name)).map((x) => `${x.name}=${x.value.slice(0, 50)}`).join(' ')}>`;
    const menuItems = () => [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],.mat-mdc-menu-item,.mat-mdc-option')].filter(shown);
    const list = (title) => {
      const its = menuItems();
      out.push(`-- ${title}: ${its.length} item(s) --`);
      its.slice(0, 40).forEach((e) => out.push(`${desc(e).slice(0, 190)} text="${short(e.textContent, 60)}"`));
      const panes = [...document.querySelectorAll('.cdk-overlay-pane,[role="menu"],[role="listbox"]')].filter(shown);
      panes.slice(0, 4).forEach((e) => out.push(`pane ${desc(e).slice(0, 120)} text="${short(e.innerText, 200)}"`));
    };
    const closeAll = async () => { await cdp('escape', {}); await sleep(350); };

    // 1. model menu
    let panel = findPanel();
    if (!panel) { const ch = findChip(); if (ch) { await clickEl(ch); for (let t = 0; t < 8 && !panel; t++) { await sleep(250); panel = findPanel(); } } }
    out.push('chip: ' + (findChip() ? short(findChip().textContent, 100) : 'none'));
    if (!panel) out.push('settings panel would not open');
    else {
      await settle();
      const trig = panel.root.querySelector('button[aria-label="Select model family"]') ||
        [...panel.root.querySelectorAll('button,[role="button"],[role="combobox"]')].filter((e) => shown(e) && /^(nano banana|veo|omni)/.test(cleanText(e)))[0];
      if (!trig) out.push('model trigger not found');
      else {
        out.push('model trigger: ' + short(trig.textContent, 60));
        await clickEl(trig);
        await sleep(700);
        list('model menu');
        // If a family opens a second choice, show that too: hover/click nothing, only report.
        await closeAll();
      }
    }
    if (findPanel()) { const ch = findChip(); if (ch) { await clickEl(ch); await sleep(350); } }
    if (findPanel()) await closeAll();

    // 2. a video tile: hover it, then open its Download (and More options) menu
    const anchor = [...document.querySelectorAll('flow-video-tile,video,img')].find((i) => shown(i) && (i.tagName === 'FLOW-VIDEO-TILE' || i.tagName === 'VIDEO' || /video thumbnail/i.test(i.alt || '')));
    if (!anchor) out.push('no video tile on screen; make a video first');
    else {
      const tile = anchor.closest('flow-grid-tile-container') || anchor.parentElement;
      out.push('tile: ' + desc(tile).slice(0, 160));
      tile.scrollIntoView({ block: 'center' });
      await sleep(250);
      const r = tile.getBoundingClientRect();
      await cdp('move', { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      await sleep(600);
      const ctl = [...tile.querySelectorAll('button,a,[role="button"]')].filter(shown);
      out.push(`-- ${ctl.length} visible control(s) on the tile after hover --`);
      ctl.slice(0, 25).forEach((e2) => out.push(`${desc(e2).slice(0, 190)} text="${short(e2.textContent, 40)}"`));
      for (const lab of ['Download', 'More options']) {
        const b = [...tile.querySelectorAll(`button[aria-label="${lab}"]`)].find(shown);
        if (!b) { out.push(`no visible "${lab}" button on the tile`); continue; }
        await cdp('move', { x: r.left + r.width / 2, y: r.top + r.height / 2 });
        await sleep(300);
        await clickEl(b);
        await sleep(700);
        list(`"${lab}" menu`);
        await closeAll();
      }
    }
    await parkMouse();
    cdp('detach', {});
    return out.join('\n');
  }

  // What Flow is currently set to, read from the chip (e.g. "Nano Banana 2.1 crop_square x2").
  const ICON_ASPECT = { crop_16_9: '16:9', crop_landscape: '4:3', crop_square: '1:1', crop_portrait: '3:4', crop_9_16: '9:16' };
  function readFlowSettings() {
    const chip = findChip();
    if (!chip) return null;
    const t = norm(chip.textContent);
    // Video chip, e.g. "Video · 360p · 4s crop_16_9 x2" (no model name is shown)
    const v = /^[^a-z0-9]*video\s*[·•|-]?\s*(\d+p)\s*[·•|-]?\s*(\d+s)(?:\s+(crop_\w+))?\s+x([1-4])\b/.exec(t);
    if (v) return { mode: 'video', model: '', res: v[1], dur: v[2], aspect: ICON_ASPECT[v[3]] || '', count: Number(v[4]) };
    const m = /^[^a-z0-9]*(.*?)(?:\s+(crop_\w+))?\s+x([1-4])\b/.exec(t);
    if (!m || /^video/.test(m[1])) return null;
    return { mode: 'image', model: m[1].trim(), aspect: ICON_ASPECT[m[2]] || '', count: Number(m[3]) };
  }

  // Compares what Flow shows now (chip) with what we wanted. Returns a list of problems, or null if unreadable.
  function settingsMismatch(w) {
    const cur = readFlowSettings();
    if (!cur) return null;
    const bad = [];
    if (w.aspect && cur.aspect && cur.aspect !== w.aspect) bad.push(`ratio ${cur.aspect} (wanted ${w.aspect})`);
    if (w.count && cur.count !== w.count) bad.push(`x${cur.count} (wanted x${w.count})`);
    if (w.mode && cur.mode && cur.mode !== w.mode) bad.push(`${cur.mode} mode (wanted ${w.mode})`);
    if (cur.mode === 'video') {
      if (w.res && cur.res !== w.res) bad.push(`${cur.res} (wanted ${w.res})`);
      if (w.dur && cur.dur !== w.dur) bad.push(`${cur.dur} (wanted ${w.dur})`);
    }
    if (w.model && cur.model && !(cur.model.includes(w.model) || w.model.includes(cur.model))) bad.push(`model ${cur.model} (wanted ${w.model})`);
    return bad;
  }

  let curAspect = '';
  // want: { aspect, model, count }. Returns { warn?, error?, credits? }.
  async function applyFlowSettings(want, allowCredits) {
    let panel = findPanel();
    let chip = findChip();
    if (!panel) {
      if (!chip) return { warn: 'Could not find the Flow settings control. Using the current settings.' };
      await clickEl(chip);
      for (let t = 0; t < 8 && !panel; t++) { await sleep(250); panel = findPanel(); }
      if (!panel) return { warn: 'Could not open the Flow settings panel. Using the current settings.' };
    }
    chip = chip || findChip();
    const chipText = () => (findChip() ? norm(findChip().textContent) : '');
    if (want.vmode === 'frames') return { error: 'Frames mode is not supported yet. Use Ingredients.' };
    const problems = [];
    const unverified = [];
    const videoNow = () => /^[^a-z0-9]*video/.test(chipText());
    if (want.mode && (want.mode === 'video') !== videoNow()) {
      const r0 = await setOption(want.mode);
      await sleep(400);
      if (!r0.ok || (want.mode === 'video') !== videoNow()) problems.push('mode ' + want.mode);
    }
    let note = '';
    if (videoNow()) {
      // The model decides which other controls exist (Veo has no resolution or length choice), so pick it first.
      if (want.model && /^(veo|omni)/.test(want.model)) {
        const wds0 = flatTxt(want.model).split(' ');
        if (!wds0.every((w) => flatTxt(readModelText()).includes(w))) {
          if (!(await chooseModel(want.model))) problems.push('model ' + want.model);
          await sleep(300);
        }
      }
      await settle();
      const skipped = [];
      for (const [key, label] of [['vmode', want.vmode || 'ingredients'], ['res', want.res], ['dur', want.dur]]) {
        if (!label) continue;
        const pn = findPanel();
        if ((key === 'res' || key === 'dur') && pn && !findAllByText(label, pn.root).length) { skipped.push(label); want[key] = ''; continue; }
        const r1 = await setOption(label, key === 'res' || key === 'dur');
        if (!r1.ok) problems.push(label); else if (!r1.verified) unverified.push(label);
      }
      if (skipped.length) note = `${readModelText() || 'this model'} has no ${skipped.join('/')} choice, so it was skipped`;
    }
    const nowS = readFlowSettings();
    if (want.aspect && (!nowS || nowS.aspect !== want.aspect)) {
      const r = await setAspect(want.aspect);
      if (r.ok) { curAspect = want.aspect; if (!r.verified) problems.push('aspect ' + want.aspect + ' (clicked, but could not confirm it)'); }
      else problems.push('aspect ' + want.aspect);
    }
    if (want.count && !new RegExp('x' + want.count + '\\b').test(chipText())) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await settle();
        const p = findPanel();
        const el = p && findAllByText('x' + want.count, p.row)[0];
        if (!el) break;
        const btn = el.closest(BTN_SEL) || el;
        if (attempt === 0) await clickEl(btn); else if (attempt === 1) btn.click(); else if (attempt === 2) realClick(btn); else { btn.focus(); await cdp('space', {}); }
        await sleep(400);
        if (new RegExp('x' + want.count + '\\b').test(chipText())) break;
      }
      if (!new RegExp('x' + want.count + '\\b').test(chipText())) problems.push('x' + want.count);
    }
    const words = want.model ? flatTxt(want.model).split(' ') : [];
    const modelNow = () => flatTxt(readModelText() || chipText());
    if (want.model && !words.every((w) => modelNow().includes(w))) {
      if (!(await chooseModel(want.model))) problems.push('model ' + want.model);
    }

    let credits = null;
    const p2 = findPanel();
    if (p2) {
      const m = /(\d+)\s*credits?/i.exec(p2.root.textContent);
      if (m) credits = Number(m[1]);
    }
    await parkMouse();
    await sleep(250);
    const seen = aspectState();
    const debug = dumpState();
    // Close the panel again so it does not cover the prompt box.
    await cdp('escape', {});
    await sleep(300);
    if (findPanel()) { const ch = findChip(); if (ch) { await clickEl(ch); await sleep(300); } }

    if (credits > 0 && !allowCredits) return { error: `These settings will use ${credits} credits. Tick "Allow credit use" in the panel to continue.` };
    if (problems.length) return { warn: 'Could not set: ' + problems.join(', ') + '. Check the Flow settings.', credits, aspectSeen: seen, debug, note };
    if (unverified.length) return { warn: 'Clicked ' + unverified.join(', ') + ' but could not confirm it took. Check the Flow settings.', credits, aspectSeen: seen, debug, note };
    return { credits, aspectSeen: seen, debug, note };
  }

  // ---------- video capture ----------
  // A video tile is <flow-grid-tile-container> holding <flow-video-tile>. While generating it also holds <flow-pending-tile>
  // (with the full prompt text and a percentage). When finished it holds a thumbnail <img> (and a <video> once Flow loads it).
  const knownVid = new Set();
  const claimsByLabel = new Map();
  let claimsByEl = new WeakMap();
  let oldTiles = new WeakSet();
  let videoSuffix = '';
  const SUFFIX_RE = /=[a-z]+(,\d+)+$/;

  function scanVideoTiles() {
    const out = [];
    for (const el of document.querySelectorAll('flow-grid-tile-container')) {
      if (!el.querySelector('flow-video-tile')) continue;
      const pendingEl = el.querySelector('flow-pending-tile, .loading-percentage');
      const thumbEl = el.querySelector('img.thumbnail, img[alt*="video thumbnail" i]');
      const videoEl = el.querySelector('video');
      const raw = (videoEl && (videoEl.currentSrc || videoEl.src)) || (thumbEl && (thumbEl.currentSrc || thumbEl.src)) || '';
      const base = raw.replace(SUFFIX_RE, '').split('?')[0];
      out.push({ el, label: norm(el.getAttribute('aria-label')), pendingEl, thumbEl, videoEl, base, key: base, done: !pendingEl && !!base });
    }
    return out;
  }

  function ownerByText(text, entries) {
    const hits = entries.filter((e) => e.needle && text.includes(e.needle));
    if (!hits.length) return null;
    const distinct = hits.filter((h) => !hits.some((o) => o !== h && o.needle.length > h.needle.length && o.needle.includes(h.needle)));
    return new Set(distinct.map((h) => h.idx)).size === 1 ? distinct[0] : null;
  }

  // After a video finishes its tile only keeps a short title (aria-label), so use what we learned while it was pending.
  function labelOwner(label) {
    const open = (e) => e.video && e.images < (e.want || perPrompt);
    const claimed = (claimsByLabel.get(label) || []).filter(open);
    if (claimed.length) return claimed[0];
    const words = label.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (!words.length) return null;
    const c2 = submittedEntries.filter((e) => open(e) && words.every((w) => e.needle.includes(w)));
    return c2.length === 1 ? c2[0] : null;
  }

  // Flow only puts the <video> (with its real file URL) in the tile once it is hovered, so hover it and read the URL.
  async function resolveVideoUrl(t) {
    const fromVideo = () => { const v = t.el.querySelector('video'); return v ? (v.currentSrc || v.src || '') : ''; };
    let url = fromVideo();
    if (!url) {
      const r0 = t.el.getBoundingClientRect();
      if (r0.bottom < 0 || r0.top > innerHeight) { t.el.scrollIntoView({ block: 'center' }); await sleep(250); }
      const r = t.el.getBoundingClientRect();
      await cdp('move', { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      for (let i = 0; i < 14 && !url; i++) { await sleep(250); url = fromVideo(); }
    }
    let guessed = false;
    if (url) { const m = SUFFIX_RE.exec(url); if (m) videoSuffix = m[0]; }
    else if (t.base) { url = t.base + (videoSuffix || '=mm,22,15'); guessed = true; }
    return { url, guessed };
  }

  async function videoTick() {
    const vEntries = submittedEntries.filter((e) => e.video);
    if (!vEntries.length) return;
    for (const t of scanVideoTiles()) {
      if (t.pendingEl) {
        if (oldTiles.has(t.el) || claimsByEl.has(t.el)) continue;
        const owner = ownerByText(norm(t.el.innerText), vEntries);
        if (owner) {
          claimsByEl.set(t.el, owner);
          const arr = claimsByLabel.get(t.label) || [];
          arr.push(owner);
          claimsByLabel.set(t.label, arr);
        }
        continue;
      }
      if (!t.done || knownVid.has(t.key)) continue;
      knownVid.add(t.key);
      if (oldTiles.has(t.el)) continue;
      let by = 'text';
      let entry = claimsByEl.get(t.el);
      if (!entry) entry = labelOwner(t.label);
      if (!entry) { entry = pending.find((e) => e.video); by = 'order'; }
      if (!entry) continue;
      const { url, guessed } = await resolveVideoUrl(t);
      let pr = null;
      if (url) pr = await bg({ type: 'probe', url });
      let thumb = null;
      const tb = await getBlob(t.base, t.thumbEl);
      if (tb) { try { thumb = await makeThumb(tb); } catch (_) {} }
      let hint = '';
      try { if (pr && pr.final) hint = new URL(pr.final).origin; } catch (_) {}
      const probe = pr ? (pr.ok ? (pr.type || 'ok') : (pr.error || 'HTTP ' + pr.status)) : '';
      await saveResult(entry, { src: url || t.base, thumb: thumb || '', by, kind: 'video', guessed, hint, probe });
      entry.images += 1;
      entry.lastImgAt = Date.now();
      pending = pending.filter((e) => e.images < (e.want || perPrompt));
    }
  }

  async function watcherTick() {
    if (watcherBusy) return;
    if (!alive() || !ctxOk()) return stopWatcher();
    watcherBusy = true;
    try {
      // Give up on a prompt that got some images but nothing more for a while.
      const head = pending[0];
      const gapMs = head && head.video ? 300000 : 40000;
      const failMs = head && head.video ? 1200000 : 300000;
      if (head && head.images > 0 && Date.now() - head.lastImgAt > gapMs) pending.shift();
      else if (head && head.images === 0 && Date.now() - head.submittedAt > failMs) pending.shift(); // generation failed or never arrived

      for (const img of scanImages()) {
        if (known.has(img.key)) continue;
        known.add(img.key);
        const owner = findOwner(img.el, submittedEntries);
        const entry = owner || pending[0];
        if (!entry) continue;
        const by = owner ? 'text' : 'order';
        const blob = await getBlob(img.src, img.el);
        let thumb = null;
        if (blob) { try { thumb = await makeThumb(blob); } catch (_) {} }
        let full = img.src;
        if (blob && /^blob:/.test(img.src)) {
          try { full = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); }); } catch (_) {}
        }
        await saveResult(entry, { src: full, thumb: thumb || img.src, by });
        entry.images += 1;
        entry.lastImgAt = Date.now();
        pending = pending.filter((e) => e.images < (e.want || perPrompt));
      }
      await videoTick();
      const idleMs = pending.some((e) => e.video) ? 1500000 : 240000;
      if (!running && (!pending.length || Date.now() - lastSubmitAt > idleMs)) stopWatcher();
    } finally {
      watcherBusy = false;
    }
  }

  function startWatcher() { if (!watcher) watcher = setInterval(watcherTick, 1500); }
  function stopWatcher() { if (watcher) { clearInterval(watcher); watcher = null; } }

  // ---------- zip + download ----------
  

  // ---------- queue runner ----------
  async function run(opts = {}) {
    if (running) return;
    running = true;
    stopRequested = false;
    try {
      const s = await store.get(['prompts', 'prefix', 'suffix', 'delay', 'startAt', 'perPrompt', 'promptTarget', 'btnTarget', 'useManual', 'applySettings', 'aspect', 'model', 'allowCredits', 'mode', 'res', 'dur', 'vmodel']);
      const items = parseAll(s.prompts);
      const prompts = items.map((it) => it.text);
      if (!prompts.length) return setStatus({ state: 'error', msg: 'Add at least one prompt.' });
      const getBox = () => (s.useManual && resolve(s.promptTarget)) || autoBox();
      const getBtn = () => (s.useManual && resolve(s.btnTarget)) || autoBtn(getBox());

      const delayMs = Math.max(5, Number(s.delay) || 25) * 1000;
      const first = Math.max(1, Number(s.startAt) || 1) - 1;
      perPrompt = Math.max(1, Number(s.perPrompt) || 2);
      const order = Array.isArray(opts.only) && opts.only.length
        ? [...new Set(opts.only)].filter((n) => n >= 0 && n < prompts.length).sort((a, b) => a - b)
        : prompts.map((_, n) => n).filter((n) => n >= first);
      if (!order.length) return setStatus({ state: 'error', msg: 'Nothing to run: the start number is past the last prompt.' });

      // Everything already on the page is "old"; only new images get captured.
      curAspect = '';
      await cdp('attach', {});
      await sleep(1200); // the debugger infobar shifts the page; let it settle before any coordinates are used
      // Remember what Flow was set to now, so [reset] and one-prompt overrides can go back to it.
      let baseline = null;
      let touched = false;
      if (s.applySettings || items.some((it) => Object.keys(it.opts).length)) {
        baseline = readFlowSettings();
        if (baseline && baseline.aspect) curAspect = baseline.aspect;
      }
      known.clear();
      scanImages().forEach((i) => known.add(i.key));
      knownVid.clear(); claimsByLabel.clear(); claimsByEl = new WeakMap(); oldTiles = new WeakSet();
      for (const vt of scanVideoTiles()) { if (vt.done) knownVid.add(vt.key); else oldTiles.add(vt.el); }
      pending = [];
      submittedEntries = [];
      if (opts.fresh) await store.set({ results: {} });
      startWatcher();

      for (let k = 0; k < order.length; k++) {
        const i = order[k];
        if (halted()) break;
        const box = getBox();
        const btn = getBtn();
        if (!box || !btn) {
          await setStatus({ state: 'error', msg: 'Could not find the prompt box or generate button. Try Test detection, or pick them manually.', index: i + 1, total: prompts.length });
          badge('');
          return;
        }
        const text = [s.prefix, prompts[i], s.suffix].map((t) => (t || '').trim()).filter(Boolean).join(' ');
        badge(`Flow Queue: ${i + 1} / ${prompts.length}`);
        await setStatus({ state: 'running', msg: `Generating ${i + 1} of ${prompts.length}`, index: i + 1, total: prompts.length });

        const o = items[i].opts;
        const apply = !!s.applySettings;
        const base = touched && baseline ? baseline : {};
        const wantS = {
          aspect: o.aspect || (apply ? s.aspect : '') || base.aspect || '',
          model: o.model || (apply ? s.model : '') || base.model || '',
          count: o.count || (apply ? Math.min(4, perPrompt) : 0) || base.count || 0,
          mode: o.mode || (apply ? s.mode : '') || base.mode || '',
          res: o.res || (apply ? s.res : '') || (base.mode === 'video' ? base.res : '') || '',
          dur: o.dur || (apply ? s.dur : '') || (base.mode === 'video' ? base.dur : '') || '',
          vmode: o.vmode || '',
        };
        // Settings that do not exist in the target mode are dropped, so image values never leak into a video prompt and the reverse.
        const nowCfg = readFlowSettings();
        const curMode = (nowCfg && nowCfg.mode) || (isVideoChip() ? 'video' : 'image');
        const tMode = wantS.mode || curMode;
        const modelOk = (m) => (tMode === 'video' ? /^(veo|omni)/.test(m) : /^nano banana/.test(m));
        if (!wantS.model || !modelOk(wantS.model)) {
          const fromPanel = apply ? (tMode === 'video' ? s.vmodel : s.model) : '';
          wantS.model = (o.model && modelOk(o.model) ? o.model : '') || (fromPanel && modelOk(fromPanel) ? fromPanel : '') || (base.model && modelOk(base.model) ? base.model : '') || '';
        }
        if (tMode === 'video') {
          if (wantS.aspect && !['16:9', '9:16'].includes(wantS.aspect)) {
            await setStatus({ msg: `Prompt ${i + 1}: video only has 16:9 and 9:16, so ${wantS.aspect} was skipped.` });
            wantS.aspect = '';
          }
        } else { wantS.res = ''; wantS.dur = ''; wantS.vmode = ''; }
        if (Object.keys(o).length) touched = true;
        var entryWant = wantS.count || perPrompt;
        if (wantS.aspect || wantS.model || wantS.count || wantS.mode || wantS.res || wantS.dur || wantS.vmode) {
          let r = {};
          let bad = [];
          for (let attempt = 0; attempt < 3; attempt++) {
            r = await applyFlowSettings(wantS, !!s.allowCredits);
            if (r.error) break;
            await sleep(300);
            bad = settingsMismatch(wantS) || [];
            if (!bad.length) break;
            curAspect = '';
          }
          if (r.error) { await setStatus({ state: 'error', msg: r.error, index: i + 1, total: prompts.length }); badge(''); return; }
          if (bad.length) {
            await setStatus({ state: 'error', msg: `Flow did not keep these settings for prompt ${i + 1}: ${bad.join(', ')}. Fix them in Flow, then press Resume.`, index: i + 1, total: prompts.length });
            badge('');
            return;
          }
          await setStatus({ msg: `Flow settings applied for prompt ${i + 1}${r.note ? ' (' + r.note + ')' : ''}` });
        }
        await setPrompt(getBox() || box, text);
        await sleep(700);
        let go = getBtn() || btn;
        if (!isEnabled(go)) await waitForEnabled(getBtn, 300, 10000);
        go = getBtn() || go;
        const how = await submit(getBox() || box, go);
        await setStatus({ msg: `${tMode === 'video' ? 'Video' : 'Image'} ${i + 1} of ${prompts.length} submitted via ${how}`, ...(opts.only ? {} : { nextIndex: i + 2 }) });
        try {
          const { submitted } = await store.get('submitted');
          await store.set({ submitted: [...new Set([...(submitted || []), i])] });
        } catch (_) {}
        if (how !== 'unknown') {
          const e = { idx: i, prompt: prompts[i], needle: norm(prompts[i]), want: entryWant, images: 0, lastImgAt: 0, submittedAt: Date.now(), video: tMode === 'video' };
          pending.push(e);
          submittedEntries.push(e);
          lastSubmitAt = Date.now();
        }
        if (k < order.length - 1) await countdown(delayMs, i + 1, prompts.length);
      }

      if (!ctxOk()) { badge('Flow Queue: extension was reloaded. Refresh this page.'); return; }
      const stopped = stopRequested || !alive();
      await setStatus({ state: stopped ? 'stopped' : 'done', msg: stopped ? 'Stopped.' : 'Queue finished. Collecting the last images...' });
    } catch (err) {
      await setStatus({ state: 'error', msg: String(err && err.message ? err.message : err) });
    } finally {
      running = false;
      cdp('detach', {});
      setTimeout(() => badge(''), 4000);
    }
  }

  store.get('status').then(({ status }) => {
    if (status && status.state === 'running') setStatus({ state: 'stopped', msg: 'Interrupted because the page was reloaded. Use Resume to continue.' });
  }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!alive()) return false;
    if (msg.type === 'ping') reply({ ok: true });
    if (msg.type === 'pick') {
      pick(msg.which).then((target) => {
        if (target) store.set({ [msg.which === 'prompt' ? 'promptTarget' : 'btnTarget']: target, useManual: true });
      });
      reply({ ok: true });
    }
    if (msg.type === 'start') { run({ only: msg.only, fresh: !!msg.fresh }); reply({ ok: true }); }
    if (msg.type === 'testSettings') {
      curAspect = '';
      const w = { ...msg.want };
      const cm = (readFlowSettings() || {}).mode || (isVideoChip() ? 'video' : 'image');
      const tm = w.mode || cm;
      w.model = tm === 'video' ? (w.vmodel || '') : (w.model || '');
      if (tm === 'video' && w.aspect && !['16:9', '9:16'].includes(w.aspect)) w.aspect = '';
      if (tm !== 'video') { w.res = ''; w.dur = ''; }
      applyFlowSettings(w, !!msg.allowCredits).then(reply).catch((e) => reply({ warn: String(e) }));
      return true;
    }
    if (msg.type === 'stop') { stopRequested = true; reply({ ok: true }); }
    if (msg.type === 'dumpVideo') { dumpVideo().then((d) => reply({ dump: d })).catch((e) => reply({ dump: 'Failed: ' + e })); return true; }
    if (msg.type === 'dumpMenus') { dumpMenus().then((d) => reply({ dump: d })).catch((e) => reply({ dump: 'Failed: ' + e })); return true; }
    if (msg.type === 'detect') {
      store.get(['promptTarget', 'btnTarget', 'useManual']).then((s) => {
        const box = (s.useManual && resolve(s.promptTarget)) || autoBox();
        const btn = (s.useManual && resolve(s.btnTarget)) || autoBtn(box);
        [box, btn].forEach((el) => {
          if (!el) return;
          const old = el.style.outline;
          el.style.outline = '3px solid #7aa2ff';
          setTimeout(() => { el.style.outline = old; }, 2500);
        });
        reply({ box: !!box, btn: !!btn, images: scanImages().length, videos: scanVideoTiles().filter((t) => t.done).length });
      });
      return true;
    }
    return false;
  });
})();
