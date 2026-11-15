const $ = (id) => document.getElementById(id);
const TEXT = ['sourceLang', 'targetLang', 'engine', 'ollamaUrl', 'serverUrl', 'fontFamily', 'vertical'];
const NUM = ['fontScale', 'bgOpacity', 'minSize'];

for (const [v, l] of Object.entries(MT_SOURCE_LANGS)) $('sourceLang').add(new Option(l, v));
for (const [v, l] of Object.entries(MT_TARGET_LANGS)) $('targetLang').add(new Option(l, v));

let savedTimer = 0;
async function save(patch) {
  await chrome.storage.local.set(patch);
  $('saved').textContent = '已儲存';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
  if ('serverUrl' in patch || 'ollamaUrl' in patch) { check(); refreshInstalled(); }
}

async function load() {
  const s = await mtGetSettings();
  for (const k of [...TEXT, ...NUM]) $(k).value = s[k];
  renderModels(s.ollamaModel);
  $('bold').checked = s.bold;
  $('autoSites').value = s.autoSites.join('\n');
}

async function check() {
  const s = await mtGetSettings();
  const { health } = await chrome.runtime.sendMessage({ type: 'health' });
  $('dot').className = 'dot ' + (health?.ok ? 'ok' : 'bad');
  if (!health?.ok) { $('statusText').textContent = '本機伺服器未啟動：請點插件圖示按「啟動本機伺服器」'; return; }
  const ol = health.ollama;
  $('statusText').textContent = `本機伺服器已連線（${health.gpu ? 'GPU' : 'CPU'}）；` +
    (ol.running ? `Ollama 執行中，已安裝：${ol.models.map(mtModelKey).join('、') || '無'}` : 'Ollama 未啟動');
}

// ---- Ollama model picker ---------------------------------------------------
let installed = null;

function renderModels(current) {
  mtFillModels($('ollamaModel'), installed, current, { custom: true });
  $('customRow').hidden = true;
  const missing = installed && !installed.map(mtModelKey).includes(mtModelKey(current));
  $('modelHint').textContent = missing ? `「${current}」尚未安裝，請先執行 ollama pull ${current}` : '';
  $('modelHint').hidden = !missing;
}

async function refreshInstalled() {
  installed = (await chrome.runtime.sendMessage({ type: 'ollamaModels' }))?.models ?? null;
  renderModels((await mtGetSettings()).ollamaModel);
}

$('ollamaModel').addEventListener('change', async () => {
  if ($('ollamaModel').value === MT_CUSTOM_MODEL) {
    $('customRow').hidden = false;
    $('customModel').value = '';
    $('customModel').focus();
    return;
  }
  await save({ ollamaModel: $('ollamaModel').value });
  renderModels($('ollamaModel').value);
});
$('customModel').addEventListener('change', async () => {
  const name = $('customModel').value.trim();
  if (!name) return;
  await save({ ollamaModel: name });
  renderModels(name);
});
// Keep in step with the popup's picker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ollamaModel) renderModels(changes.ollamaModel.newValue);
});

for (const k of TEXT) $(k).addEventListener('change', () => save({ [k]: $(k).value.trim() || MT_DEFAULTS[k] }));
for (const k of NUM) {
  $(k).addEventListener('change', () => {
    const v = Number($(k).value);
    const clamped = Math.min(Number($(k).max), Math.max(Number($(k).min), Number.isFinite(v) ? v : MT_DEFAULTS[k]));
    $(k).value = clamped;
    save({ [k]: clamped });
  });
}
$('bold').addEventListener('change', () => save({ bold: $('bold').checked }));
$('autoSites').addEventListener('change', () => {
  const hosts = $('autoSites').value.split(/\s+/).map((h) => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  save({ autoSites: [...new Set(hosts)] });
});
$('reset').addEventListener('click', async () => { await chrome.storage.local.set(MT_DEFAULTS); await load(); check(); });

load().then(() => { check(); refreshInstalled(); });
