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
    $(key).addEventListener('change', () => {
      settings[key] = $(key).value;
      chrome.storage.local.set({ [key]: $(key).value });
      updateModelUi();
    });
  }

  // ---- Ollama model picker -------------------------------------------------
  let installed = null;
  let lastHealth; // re-rendered once the model list arrives
  function updateModelUi() {
    $('modelRow').hidden = settings.engine !== 'ollama';
    const hint = $('modelHint');
    const m = settings.ollamaModel;
    let msg = '';
    if (settings.engine === 'ollama') {
      if (installed && !installed.map(mtModelKey).includes(mtModelKey(m))) msg = `尚未安裝，請先執行 ollama pull ${m}`;
      else if (/sakura/i.test(m) && (settings.sourceLang !== 'ja' || !settings.targetLang.startsWith('zh')))
        msg = 'Sakura 只支援日文翻成中文，這個語言組合請改用 Qwen3.5';
    }
    hint.textContent = msg;
    hint.hidden = !msg;
  }
  mtFillModels($('ollamaModel'), null, settings.ollamaModel);
  $('ollamaModel').addEventListener('change', () => {
    settings.ollamaModel = $('ollamaModel').value;
    chrome.storage.local.set({ ollamaModel: settings.ollamaModel });
    updateModelUi();
  });
  updateModelUi();
  chrome.runtime.sendMessage({ type: 'ollamaModels' }).then((r) => {
    installed = r?.models ?? null;
    mtFillModels($('ollamaModel'), installed, settings.ollamaModel);
    updateModelUi();
    if (lastHealth !== undefined) showHealth(lastHealth);
  });

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
    lastHealth = health;
    $('serverDot').className = 'dot ' + (health?.ok ? 'ok' : 'bad');
    $('serverText').textContent = health?.ok
      ? `本機伺服器已連線（${health.gpu ? 'GPU' : 'CPU'}）`
      : '本機伺服器未啟動';
    $('startServer').hidden = !!health?.ok;
    $('stopServer').hidden = !health?.ok;
    // Whether the chosen model is installed is shown under the model picker instead.
    const ol = health?.ollama;
    const running = ol?.running || installed !== null;
    $('ollamaDot').className = 'dot ' + (running ? 'ok' : 'bad');
    $('ollamaText').textContent = running ? 'Ollama 執行中' : health?.ok ? 'Ollama 未啟動' : 'Ollama：未知';
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
