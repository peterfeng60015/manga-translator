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

  function showHealth(health) {
    $('serverDot').className = 'dot ' + (health?.ok ? 'ok' : 'bad');
    $('serverText').textContent = health?.ok
      ? `本機伺服器已連線（${health.gpu ? 'GPU' : 'CPU'}）`
      : '本機伺服器未啟動';
    $('startServer').hidden = !!health?.ok;
    $('stopServer').hidden = !health?.ok;
    const ol = health?.ollama;
    const hasModel = ol?.models?.some((m) => m === settings.ollamaModel || m.startsWith(settings.ollamaModel + ':'));
    $('ollamaDot').className = 'dot ' + (ol?.running && hasModel ? 'ok' : 'bad');
    $('ollamaText').textContent = !health?.ok ? 'Ollama：未知'
      : !ol.running ? 'Ollama 未啟動'
      : hasModel ? `Ollama 就緒（${settings.ollamaModel}）`
      : `Ollama 缺少模型 ${settings.ollamaModel}`;
  }

  const getHealth = async () => (await chrome.runtime.sendMessage({ type: 'health' })).health;
  showHealth(await getHealth());

  // One control flow for both buttons: send the command, then wait until /health agrees.
  async function control(kind) {
    const start = kind === 'start';
    const btn = $(start ? 'startServer' : 'stopServer'), hint = $('startHint');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = start ? '啟動中…' : '關閉中…';
    hint.hidden = true;
    const done = () => { btn.disabled = false; btn.textContent = label; };
    const res = await chrome.runtime.sendMessage({ type: start ? 'startServer' : 'stopServer' });
    if (!res?.ok) {
      done();
      hint.textContent = res?.error || (start ? '啟動失敗' : '關閉失敗');
      hint.hidden = false;
      return;
    }
    if (start) {
      hint.textContent = res.status === 'installing'
        ? '第一次啟動：已開啟視窗安裝套件，需要數分鐘，完成後這裡會自動更新'
        : '伺服器在背景啟動中…';
      hint.hidden = false;
    }
    // The first run may still be installing packages, so allow a long wait when starting.
    const deadline = Date.now() + (start ? 10 * 60 * 1000 : 15 * 1000);
    while (Date.now() < deadline) {
      const h = await getHealth();
      if (!!h?.ok === start) {
        showHealth(h);
        hint.hidden = true;
        done();
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    done();
    hint.textContent = start
      ? '等候逾時，請查看 server\server.log 的錯誤訊息'
      : '伺服器仍在回應，請再試一次';
    hint.hidden = false;
  }

  $('startServer').addEventListener('click', () => control('start'));
  $('stopServer').addEventListener('click', () => control('stop'));
})();
