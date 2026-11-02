const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;
const FIELDS = ['prompts', 'prefix', 'suffix', 'delay', 'startAt'];

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function send(msg) {
  const tab = await activeTab();
  const fail = (text) => {
    $('status').className = 'status error';
    $('status').textContent = text;
    return null;
  };
  if (!tab) return fail('No active tab found.');
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (_) {
    // Content script missing (tab was open before install). Inject it and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      return fail('Could not attach to the page: ' + (e && e.message ? e.message : e));
    }
  }
}

function updateCount() {
  const n = $('prompts').value.split('\n').filter((l) => l.trim()).length;
  $('count').textContent = n ? `${n} prompt${n === 1 ? '' : 's'} in the queue` : '';
}

function showTargets(s) {
  const manual = !!s.useManual;
  $('promptState').textContent = manual && s.promptTarget ? 'manual' : 'auto';
  $('buttonState').textContent = manual && s.btnTarget ? 'manual' : 'auto';
  $('promptState').className = 'tag' + (manual ? ' ok' : '');
  $('buttonState').className = 'tag' + (manual ? ' ok' : '');
}

function showStatus(st) {
  const el = $('status');
  el.className = 'status' + (st && st.state === 'error' ? ' error' : '');
  el.textContent = st && st.msg ? st.msg : '';
}

async function load() {
  const s = await store.get([...FIELDS, 'promptTarget', 'btnTarget', 'useManual', 'status']);
  FIELDS.forEach((f) => { if (s[f] !== undefined) $(f).value = s[f]; });
  showTargets(s);
  showStatus(s.status);
  updateCount();
}

FIELDS.forEach((f) => $(f).addEventListener('input', () => {
  store.set({ [f]: $(f).value });
  if (f === 'prompts') updateCount();
}));

$('pickPrompt').onclick = async () => { if (await send({ type: 'pick', which: 'prompt' })) window.close(); };
$('pickButton').onclick = async () => { if (await send({ type: 'pick', which: 'button' })) window.close(); };
$('detect').onclick = async () => {
  const r = await send({ type: 'detect' });
  if (!r) return;
  const el = $('detectState');
  el.className = 'tag' + (r.box && r.btn ? ' ok' : '');
  el.textContent = r.box && r.btn ? 'found both (highlighted)' : `prompt box: ${r.box ? 'found' : 'missing'}, button: ${r.btn ? 'found' : 'missing'}`;
};
$('useAuto').onclick = () => store.set({ useManual: false });
$('start').onclick = async () => {
  await store.set({ status: { state: 'running', msg: 'Starting...' } });
  await send({ type: 'start' });
};
$('stop').onclick = () => send({ type: 'stop' });

chrome.storage.onChanged.addListener((changes) => {
  if (changes.status) showStatus(changes.status.newValue);
  if (changes.promptTarget || changes.btnTarget || changes.useManual) store.get(['promptTarget', 'btnTarget', 'useManual']).then(showTargets);
});

load();
