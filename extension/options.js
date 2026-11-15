const $ = (id) => document.getElementById(id);
const TEXT = ['sourceLang', 'targetLang', 'engine', 'ollamaModel', 'ollamaUrl', 'serverUrl', 'fontFamily', 'vertical'];
const NUM = ['fontScale', 'bgOpacity', 'minSize'];

for (const [v, l] of Object.entries(MT_SOURCE_LANGS)) $('sourceLang').add(new Option(l, v));
for (const [v, l] of Object.entries(MT_TARGET_LANGS)) $('targetLang').add(new Option(l, v));

let savedTimer = 0;
async function save(patch) {
  await chrome.storage.local.set(patch);
  $('saved').textContent = '已儲存';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
  if ('serverUrl' in patch || 'ollamaUrl' in patch || 'ollamaModel' in patch) check();
}

async function load() {
  const s = await mtGetSettings();
  for (const k of [...TEXT, ...NUM]) $(k).value = s[k];
  $('bold').checked = s.bold;
  $('autoSites').value = s.autoSites.join('\n');
}

async function check() {
  const s = await mtGetSettings();
  const { health } = await chrome.runtime.sendMessage({ type: 'health' });
  $('dot').className = 'dot ' + (health?.ok ? 'ok' : 'bad');
  if (!health?.ok) { $('statusText').textContent = '本機伺服器未啟動：請執行專案資料夾裡的 start-server.bat'; return; }
  const ol = health.ollama;
  const hasModel = ol.models.some((m) => m === s.ollamaModel || m.startsWith(s.ollamaModel + ':'));
  $('statusText').textContent = `本機伺服器已連線（${health.gpu ? 'GPU' : 'CPU'}）；` +
    (!ol.running ? 'Ollama 未啟動' : hasModel ? `Ollama 就緒，已安裝：${ol.models.join('、')}` : `Ollama 缺少模型 ${s.ollamaModel}（已安裝：${ol.models.join('、') || '無'}）`);
}

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

load().then(check);
