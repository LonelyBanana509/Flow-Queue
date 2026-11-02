// Flow Queue - background worker.
// 1) Shows the side panel only on Flow tabs.
// 2) Sends trusted input (typing, clicks, Enter) via the Chrome debugger API.
// 3) Fetches images the page itself cannot read.

const FLOW_RE = /^https:\/\/(flow\.google|labs\.google)(\.com)?\//;

async function gate(tabId, url) {
  try {
    if (url && FLOW_RE.test(url)) await chrome.sidePanel.setOptions({ tabId, path: 'panel.html', enabled: true });
    else await chrome.sidePanel.setOptions({ tabId, enabled: false });
  } catch (_) { /* tab may be gone */ }
}

async function init() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.sidePanel.setOptions({ enabled: false });
    const tabs = await chrome.tabs.query({});
    tabs.forEach((t) => gate(t.id, t.url));
  } catch (_) {}
}
init();
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (info.url || info.status === 'complete') gate(id, tab.url); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const t = await chrome.tabs.get(tabId); gate(tabId, t.url); } catch (_) {}
});

// ---------- trusted input via debugger ----------
const attached = new Set();

async function ensure(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(String(e && e.message))) throw e;
  }
  attached.add(tabId);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

async function handleInput(tabId, msg) {
  if (msg.action === 'detach') {
    if (attached.has(tabId)) { await chrome.debugger.detach({ tabId }).catch(() => {}); attached.delete(tabId); }
    return;
  }
  await ensure(tabId);
  if (msg.action === 'attach') return;
  if (msg.action === 'type') {
    const key = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, commands: ['selectAll'], ...key });
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, ...key });
    await cmd(tabId, 'Input.insertText', { text: msg.text });
  } else if (msg.action === 'click') {
    const p = { x: msg.x, y: msg.y, button: 'left', clickCount: 1 };
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: msg.x, y: msg.y });
    await wait(90);
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...p });
    await wait(90);
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...p });
  } else if (msg.action === 'space') {
    const k = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', ...k });
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  } else if (msg.action === 'move') {
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: msg.x, y: msg.y });
  } else if (msg.action === 'escape') {
    const k = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  } else if (msg.action === 'enter') {
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...k });
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'cdp' && sender.tab) {
    handleInput(sender.tab.id, msg)
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'probe') {
    fetch(msg.url, { headers: { Range: 'bytes=0-0' }, credentials: 'include' })
      .then((r) => reply({ ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', final: r.url, redirected: r.redirected, total: (r.headers.get('content-range') || '').split('/')[1] || '' }))
      .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'fetchimg') {
    fetch(msg.url, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const type = r.headers.get('content-type') || 'image/png';
        reply({ ok: true, type, b64: toBase64(await r.arrayBuffer()) });
      })
      .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  return false;
});
