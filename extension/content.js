// Finds manga pictures on the page, has them translated and swaps in the redrawn picture.
(() => {
  if (window.__mtLoaded) return;
  window.__mtLoaded = true;

  const records = new WeakMap(); // img -> { status, src, blobUrl, orig }
  const tracked = new Set();     // imgs we have swapped (to restore on disable)
  const queue = [];
  const MAX_ACTIVE = 2;
  let active = 0;
  let done = 0;
  let enabled = false;
  let settings = null;
  let io = null;
  let mo = null;

  // ---- status toast --------------------------------------------------------

  let toastEl = null;
  let toastTimer = 0;
  function toast(text, kind = 'info', sticky = false) {
    if (!toastEl) {
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        div{font:13px/1.5 "Microsoft JhengHei",system-ui,sans-serif;color:#fff;background:#1f2430e6;
          padding:8px 12px;border-radius:8px;box-shadow:0 4px 16px #0005;max-width:320px;
          border-left:4px solid #5b9cff;transition:opacity .2s}
        div.error{border-left-color:#ff6b6b} div.ok{border-left-color:#4cc38a} div[hidden]{display:none}
      </style><div hidden></div>`;
      document.documentElement.appendChild(host);
      toastEl = root.querySelector('div');
    }
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.className = kind;
    toastEl.hidden = false;
    if (!sticky) toastTimer = setTimeout(() => { toastEl.hidden = true; }, kind === 'error' ? 7000 : 2500);
  }

  function progress() {
    const pending = active + queue.length;
    if (pending > 0) toast(`漫畫翻譯中…（剩 ${pending} 張，已完成 ${done} 張）`, 'info', true);
    else if (done > 0) toast(`翻譯完成，共 ${done} 張`, 'ok');
  }

  // ---- translating one picture ---------------------------------------------

  const send = (message) => chrome.runtime.sendMessage(message);

  async function localDataUrl(src) {
    // blob:/data: pictures only exist inside this page, so read them here.
    const blob = await (await fetch(src)).blob();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function currentSrc(img) {
    return img.currentSrc || img.src || '';
  }

  function eligible(img, force) {
    if (!img.isConnected || !img.complete || !img.naturalWidth) return false;
    if (force) return true;
    if (img.naturalWidth < settings.minSize || img.naturalHeight < settings.minSize) return false;
    const r = img.getBoundingClientRect();
    return r.width >= 120 && r.height >= 120;
  }

  function swapIn(img, rec, blobUrl) {
    const sources = img.parentElement?.tagName === 'PICTURE' ? [...img.parentElement.querySelectorAll('source')] : [];
    rec.orig = {
      src: img.getAttribute('src'),
      srcset: img.getAttribute('srcset'),
      sources: sources.map((s) => [s, s.getAttribute('srcset')]),
    };
    rec.blobUrl = blobUrl;
    rec.applying = true;
    sources.forEach((s) => s.removeAttribute('srcset'));
    img.removeAttribute('srcset');
    img.src = blobUrl;
    tracked.add(img);
    queueMicrotask(() => { rec.applying = false; });
  }

  function restore(img) {
    const rec = records.get(img);
    if (!rec?.orig) return;
    rec.applying = true;
    rec.orig.sources.forEach(([s, v]) => { if (v != null) s.setAttribute('srcset', v); });
    if (rec.orig.srcset != null) img.setAttribute('srcset', rec.orig.srcset);
    if (rec.orig.src != null) img.setAttribute('src', rec.orig.src); else img.removeAttribute('src');
    URL.revokeObjectURL(rec.blobUrl);
    records.delete(img);
    tracked.delete(img);
  }

  async function translate(img, force) {
    const src = currentSrc(img);
    const rec = { status: 'working', src };
    records.set(img, rec);
    try {
      const msg = { type: 'translateImage', src, pageUrl: location.href };
      if (/^(blob|data):/.test(src)) msg.dataUrl = await localDataUrl(src);
      const res = await send(msg);
      if (!res?.ok) throw Object.assign(new Error(res?.error || '翻譯失敗'), { code: res?.code });
      if (!enabled && !force) return;
      if (records.get(img) !== rec || currentSrc(img) !== src) return; // the page changed the picture meanwhile
      if (!res.result.blocks.some((b) => b.translation)) { rec.status = 'empty'; return; }
      const canvas = await mtRender(res.dataUrl, res.result, settings);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (records.get(img) !== rec || currentSrc(img) !== src) return;
      swapIn(img, rec, URL.createObjectURL(blob));
      rec.status = 'done';
      done++;
    } catch (e) {
      rec.status = 'error';
      if (e.code === 'offline') {
        // No point hammering a server that is not running. Switch the page off so that pressing
        // "翻譯此頁" again after starting the server retries every picture.
        if (enabled) stop(true);
        else records.delete(img);
        toast(e.message, 'error');
      } else {
        toast(`翻譯失敗：${e.message}`, 'error');
      }
      throw e;
    }
  }

  function pump() {
    while (active < MAX_ACTIVE && queue.length) {
      const { img, force } = queue.shift();
      if (records.get(img)?.status !== 'queued') continue;
      if (!eligible(img, force)) { records.delete(img); continue; }
      active++;
      let failed = false;
      translate(img, force)
        .catch(() => { failed = true; })
        .finally(() => { active--; if (!failed) progress(); pump(); });
    }
  }

  function enqueue(img, force = false) {
    if (records.has(img)) return;
    records.set(img, { status: 'queued' });
    queue.push({ img, force });
    progress();
    pump();
  }

  // ---- watching the page ---------------------------------------------------

  function watch(img) {
    if (records.has(img)) return;
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener('load', () => enabled && watch(img), { once: true });
      return;
    }
    if (eligible(img, false)) io.observe(img);
  }

  function start() {
    if (enabled) return;
    enabled = true;
    done = 0;
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { io.unobserve(e.target); enqueue(e.target); }
      }
    }, { rootMargin: '1500px 400px' });
    mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') {
          const img = m.target;
          const rec = records.get(img);
          if (rec?.applying) continue;
          if (rec && img.src !== rec.blobUrl) {
            // The site swapped in another picture (lazy loading, page turn): start over.
            if (rec.blobUrl) URL.revokeObjectURL(rec.blobUrl);
            records.delete(img);
            tracked.delete(img);
          }
          if (!records.has(img)) watch(img);
        } else {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'IMG') watch(n);
            else n.querySelectorAll?.('img').forEach(watch);
          }
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    document.querySelectorAll('img').forEach(watch);
    if (!document.querySelector('img')) toast('這一頁沒有找到圖片；若漫畫是畫在 canvas 上，請改用截圖模式', 'info');
  }

  function stop(quiet = false) {
    enabled = false;
    io?.disconnect();
    mo?.disconnect();
    queue.length = 0;
    [...tracked].forEach(restore);
    document.querySelectorAll('img').forEach((img) => { if (records.get(img)?.status !== 'working') records.delete(img); });
    if (!quiet) toast('已還原原圖', 'ok');
  }

  // ---- screenshot mode -----------------------------------------------------

  let shotLayer = null;
  function screenshotMode() {
    if (shotLayer) return;
    const layer = shotLayer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:#0003;';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px dashed #5b9cff;background:#5b9cff22;display:none;';
    layer.appendChild(box);
    document.documentElement.appendChild(layer);
    toast('拖曳框選要翻譯的區域（Esc 取消）', 'info', true);
    let x0 = 0, y0 = 0, dragging = false;
    const close = () => { layer.remove(); shotLayer = null; removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { close(); toast('已取消', 'info'); } };
    addEventListener('keydown', onKey, true);
    layer.addEventListener('mousedown', (e) => {
      dragging = true; x0 = e.clientX; y0 = e.clientY;
      box.style.display = 'block';
      e.preventDefault();
    });
    layer.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      box.style.left = Math.min(x0, e.clientX) + 'px';
      box.style.top = Math.min(y0, e.clientY) + 'px';
      box.style.width = Math.abs(e.clientX - x0) + 'px';
      box.style.height = Math.abs(e.clientY - y0) + 'px';
    });
    layer.addEventListener('mouseup', async (e) => {
      if (!dragging) return;
      const rect = { x: Math.min(x0, e.clientX), y: Math.min(y0, e.clientY), w: Math.abs(e.clientX - x0), h: Math.abs(e.clientY - y0) };
      close();
      if (rect.w < 40 || rect.h < 40) { toast('框選範圍太小', 'error'); return; }
      toastEl.hidden = true; // keep the toast out of the capture
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        await translateArea(rect);
      } catch (err) {
        toast(`截圖翻譯失敗：${err.message}`, 'error');
      }
    });
  }

  async function translateArea(rect) {
    const cap = await send({ type: 'capture' });
    if (!cap?.ok) throw new Error(cap?.error || '無法擷取畫面');
    toast('截圖翻譯中…', 'info', true);
    const shot = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('截圖載入失敗'));
      im.src = cap.dataUrl;
    });
    const k = shot.naturalWidth / innerWidth; // device pixel ratio incl. zoom
    const crop = document.createElement('canvas');
    crop.width = Math.round(rect.w * k);
    crop.height = Math.round(rect.h * k);
    crop.getContext('2d').drawImage(shot, rect.x * k, rect.y * k, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const dataUrl = crop.toDataURL('image/png');
    const res = await send({ type: 'translateImage', dataUrl, pageUrl: location.href });
    if (!res?.ok) throw new Error(res?.error || '翻譯失敗');
    if (!res.result.blocks.some((b) => b.translation)) { toast('這個區域沒有偵測到文字', 'info'); return; }
    const canvas = await mtRender(dataUrl, res.result, settings);
    canvas.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;` +
      'z-index:2147483645;box-shadow:0 0 0 2px #5b9cff,0 6px 24px #0006;cursor:pointer;';
    canvas.title = '點一下或捲動頁面即可關閉';
    document.documentElement.appendChild(canvas);
    const dismiss = () => { canvas.remove(); removeEventListener('scroll', dismiss, true); removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    canvas.addEventListener('click', dismiss);
    addEventListener('scroll', dismiss, true);
    addEventListener('keydown', onKey, true);
    toast('完成（點一下譯圖或捲動即可關閉）', 'ok');
  }

  // ---- messages & startup --------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'state') { sendResponse({ enabled, done, pending: active + queue.length }); return; }
    if (msg.type === 'toggle' || msg.type === 'setEnabled') {
      const want = msg.type === 'toggle' ? !enabled : msg.enabled;
      mtGetSettings().then((s) => {
        settings = s;
        if (want) start(); else if (enabled) stop();
        sendResponse({ enabled });
      });
      return true;
    }
    if (msg.type === 'screenshot') {
      if (window !== top) return; // captures are of the top-level viewport
      mtGetSettings().then((s) => { settings = s; screenshotMode(); });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'translateSrc') {
      mtGetSettings().then((s) => {
        settings = s;
        const img = [...document.querySelectorAll('img')].find((i) => i.src === msg.src || i.currentSrc === msg.src);
        if (!img) return;
        if (records.get(img)?.status === 'done') { restore(img); return; } // second click: back to the original
        records.delete(img);
        enqueue(img, true);
      });
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !settings) return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    // Language, engine or look changed: redo the pictures already translated.
    if (enabled && Object.keys(changes).some((k) => k !== 'autoSites' && k !== 'serverUrl')) {
      stop();
      start();
    }
  });

  mtGetSettings().then((s) => {
    settings = s;
    if (window === top && s.autoSites.includes(location.hostname)) start();
  });
})();
