const $ = (id) => document.getElementById(id);

function fill(select, map) {
  for (const [value, label] of Object.entries(map)) select.add(new Option(label, value));
}

async function toTab(tabId, message) {
  const r = await chrome.runtime.sendMessage({ type: 'toTab', tabId, message });
  if (!r?.ok) throw new Error(r?.error || 'no response');
  return r.response;
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await mtGetSettings();
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (e) { /* chrome:// etc. */ }
  const usable = /^(https?|file):/.test(tab?.url || '');

  fill($('sourceLang'), MT_SOURCE_LANGS);
  fill($('targetLang'), MT_TARGET_LANGS);
  for (const key of ['sourceLang', 'targetLang', 'engine']) {
    $(key).value = settings[key];
    $(key).addEventListener('change', () => chrome.storage.local.set({ [key]: $(key).value }));
  }

  function show(state) {
    $('toggle').textContent = state.enabled ? '還原原圖' : '翻譯此頁';
    $('toggle').classList.toggle('primary', !state.enabled);
    $('pageState').textContent = state.enabled
      ? `翻譯已開啟：完成 ${state.done} 張` + (state.pending ? `，處理中 ${state.pending} 張` : '')
      : '';
  }

  if (!usable) {
    $('toggle').disabled = $('shot').disabled = $('autoSite').disabled = true;
    $('pageState').textContent = '這個頁面無法使用（瀏覽器內建頁面）';
  } else {
    try { show(await toTab(tab.id, { type: 'state' })); } catch (e) { $('pageState').textContent = '請重新整理此頁後再試'; }
    $('toggle').addEventListener('click', async () => {
      await toTab(tab.id, { type: 'toggle' });
      show(await toTab(tab.id, { type: 'state' }));
    });
    $('shot').addEventListener('click', async () => {
      await toTab(tab.id, { type: 'screenshot' });
      window.close();
    });
    $('autoSite').checked = settings.autoSites.includes(host);
    $('autoSite').addEventListener('change', async () => {
      const { autoSites } = await mtGetSettings();
      const next = autoSites.filter((h) => h !== host);
      if ($('autoSite').checked) next.push(host);
      await chrome.storage.local.set({ autoSites: next });
      if ($('autoSite').checked) show(await toTab(tab.id, { type: 'setEnabled', enabled: true }));
    });
  }

  $('options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  const { health } = await chrome.runtime.sendMessage({ type: 'health' });
  $('serverDot').classList.add(health?.ok ? 'ok' : 'bad');
  $('serverText').textContent = health?.ok
    ? `本機伺服器已連線（${health.gpu ? 'GPU' : 'CPU'}）`
    : '本機伺服器未啟動：請執行 start-server.bat';
  const ol = health?.ollama;
  const hasModel = ol?.models?.some((m) => m === settings.ollamaModel || m.startsWith(settings.ollamaModel + ':'));
  $('ollamaDot').classList.add(ol?.running && hasModel ? 'ok' : 'bad');
  $('ollamaText').textContent = !health?.ok ? 'Ollama：未知'
    : !ol.running ? 'Ollama 未啟動'
    : hasModel ? `Ollama 就緒（${settings.ollamaModel}）`
    : `Ollama 缺少模型 ${settings.ollamaModel}`;
})();
