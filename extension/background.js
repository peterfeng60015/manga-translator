importScripts('defaults.js');

// ---- helpers ---------------------------------------------------------------

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

async function fetchImage(src) {
  const r = await fetch(src, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  if (blob.type && !blob.type.startsWith('image/')) throw new Error(`not an image (${blob.type})`);
  return blobToDataUrl(blob);
}

async function callServer(settings, payload) {
  let r;
  // Any extension API call resets the worker's 30 s idle timer while a slow translation runs.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    r = await fetch(settings.serverUrl.replace(/\/+$/, '') + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_lang: settings.sourceLang,
        target_lang: settings.targetLang,
        engine: settings.engine,
        ollama_url: settings.ollamaUrl,
        ollama_model: settings.ollamaModel,
        ...payload,
      }),
    });
  } catch (e) {
    clearInterval(keepAlive);
    throw Object.assign(new Error('連不上本機伺服器，請先執行 start-server.bat'), { code: 'offline' });
  }
  // The server streams whitespace while it works and reports failures inside the body.
  const body = await r.json().catch(() => ({})).finally(() => clearInterval(keepAlive));
  if (body.error) throw new Error(body.error);
  if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `伺服器錯誤 HTTP ${r.status}`);
  return body;
}

async function translateImage({ src, dataUrl, pageUrl }) {
  const settings = await mtGetSettings();
  let image = dataUrl;
  if (!image && src) {
    try {
      image = await fetchImage(src);
    } catch (e) {
      image = null; // hotlink protection etc.: let the server fetch it with a Referer
    }
  }
  const result = await callServer(settings, image ? { image } : { url: src, referer: pageUrl });
  if (!image) image = result.image;
  delete result.image;
  return { result, dataUrl: image };
}

async function health() {
  const settings = await mtGetSettings();
  try {
    const u = settings.serverUrl.replace(/\/+$/, '') + '/health?ollama_url=' + encodeURIComponent(settings.ollamaUrl);
    const r = await fetch(u, { signal: AbortSignal.timeout(4000) });
    return await r.json();
  } catch (e) {
    return { ok: false };
  }
}

// Talk to the tab's content script, injecting it first if the tab predates the install.
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['defaults.js', 'typeset.js', 'content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// ---- wiring ----------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => p.then(
    (value) => sendResponse({ ok: true, ...value }),
    (e) => sendResponse({ ok: false, error: e.message, code: e.code }),
  );
  if (msg.type === 'translateImage') {
    reply(translateImage(msg));
    return true;
  }
  if (msg.type === 'capture') {
    reply(chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }).then((dataUrl) => ({ dataUrl })));
    return true;
  }
  if (msg.type === 'health') {
    reply(health().then((h) => ({ health: h })));
    return true;
  }
  if (msg.type === 'toTab') {
    reply(sendToTab(msg.tabId, msg.message).then((r) => ({ response: r })));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'mt-image', title: '翻譯這張圖片', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'mt-page', title: '翻譯此頁的漫畫（開／關）', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'mt-shot', title: '截圖翻譯：框選區域', contexts: ['page', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'mt-image') sendToTab(tab.id, { type: 'translateSrc', src: info.srcUrl });
  if (info.menuItemId === 'mt-page') sendToTab(tab.id, { type: 'toggle' });
  if (info.menuItemId === 'mt-shot') sendToTab(tab.id, { type: 'screenshot' });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab?.id) return;
  if (command === 'toggle-page') sendToTab(tab.id, { type: 'toggle' });
  if (command === 'screenshot') sendToTab(tab.id, { type: 'screenshot' });
});
