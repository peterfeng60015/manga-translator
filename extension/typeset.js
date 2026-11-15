// Draws translated text blocks over a picture on a canvas.
(() => {
  if (globalThis.mtRender) return;

  const CJK = /[⺀-鿿豈-﫿＀-￯　-ヿ가-힯]/;
  const NO_LINE_START = /[，。、！？：；）」』】〉》…～,.!?:;)\]}’”]/;
  const VERTICAL_SWAP = {
    '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄', '（': '︵', '）': '︶', '(': '︵', ')': '︶',
    '【': '︻', '】': '︼', '《': '︽', '》': '︾', '〈': '︿', '〉': '﹀', '…': '︙',
  };
  const VERTICAL_ROTATE = /[ー—–\-~〜～─]/;
  const VERTICAL_CORNER = /[，。、]/;

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('圖片載入失敗'));
      im.src = dataUrl;
    });
  }

  function tokenize(text) {
    // CJK: one token per character. Latin etc.: one token per word (with its trailing space).
    const out = [];
    let word = '';
    for (const ch of text) {
      if (ch === '\n') { if (word) out.push(word); word = ''; out.push('\n'); continue; }
      if (CJK.test(ch)) { if (word) out.push(word); word = ''; out.push(ch); continue; }
      word += ch;
      if (ch === ' ') { out.push(word); word = ''; }
    }
    if (word) out.push(word);
    return out;
  }

  function wrap(ctx, tokens, maxW) {
    const lines = [];
    let line = '';
    for (const tok of tokens) {
      if (tok === '\n') { lines.push(line); line = ''; continue; }
      const test = line + tok;
      if (line && ctx.measureText(test.trimEnd()).width > maxW && !NO_LINE_START.test(tok[0])) {
        lines.push(line.trimEnd());
        line = tok.trimStart();
      } else {
        line = test;
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
    return lines;
  }

  function fitHorizontal(ctx, text, w, h, maxSize, font) {
    const tokens = tokenize(text);
    let lo = 6, hi = Math.max(6, Math.floor(maxSize)), best = null;
    while (lo <= hi) {
      const size = (lo + hi) >> 1;
      ctx.font = font(size);
      const lines = wrap(ctx, tokens, w);
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
      if (lines.length * size * 1.22 <= h && widest <= w * 1.02) { best = { size, lines }; lo = size + 1; }
      else hi = size - 1;
    }
    if (!best) { ctx.font = font(6); best = { size: 6, lines: wrap(ctx, tokens, w) }; }
    return best;
  }

  function fitVertical(text, w, h, maxSize) {
    const chars = [...text.replace(/\s+/g, '')];
    for (let size = Math.floor(maxSize); size >= 8; size--) {
      const perCol = Math.floor(h / (size * 1.06));
      if (perCol < 2) continue;
      const cols = Math.ceil(chars.length / perCol);
      if (cols * size * 1.18 <= w) {
        const even = Math.ceil(chars.length / cols); // balance the columns
        const columns = [];
        for (let i = 0; i < chars.length; i += even) columns.push(chars.slice(i, i + even));
        // a column must not start with closing punctuation
        for (let c = 1; c < columns.length; c++) {
          if (NO_LINE_START.test(columns[c][0]) && columns[c].length > 1) columns[c - 1].push(columns[c].shift());
        }
        return { size, columns };
      }
    }
    return null;
  }

  const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function drawBlock(ctx, b, s, imgW, targetLang) {
    const text = (b.translation || '').replace(/\.{3,}/g, '…').trim();
    if (!text) return;
    const [x1, y1, x2, y2] = b.box;
    const pad = 1; // the detector's boxes are already loose; more would paint over bubble outlines
    ctx.fillStyle = rgb(b.bg, s.bgOpacity);
    ctx.beginPath();
    ctx.roundRect(x1 - pad, y1 - pad, x2 - x1 + pad * 2, y2 - y1 + pad * 2, Math.min(10, (x2 - x1) / 4, (y2 - y1) / 4));
    ctx.fill();

    const [ax1, ay1, ax2, ay2] = b.area || b.box;
    const w = Math.max(8, ax2 - ax1 - 4), h = Math.max(8, ay2 - ay1 - 4);
    const cx = (ax1 + ax2) / 2, cy = (ay1 + ay2) / 2;
    const font = (size) => `${s.bold ? 700 : 400} ${size}px ${s.fontFamily}`;
    // Cap relative to the page, but never so low that a small crop (screenshot mode) gets tiny text.
    const maxSize = Math.min(Math.max(imgW * 0.05, Math.min(w, h) * 0.22) * s.fontScale, h, w);
    const cjkTarget = /^(zh|ja)/.test(targetLang);
    const latin = (text.match(/[A-Za-z0-9]/g) || []).length;

    ctx.fillStyle = rgb(b.fg);
    ctx.strokeStyle = rgb(b.bg);
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const horiz = fitHorizontal(ctx, text, w, h, maxSize, font);
    let vert = null;
    if (s.vertical === 'auto' && cjkTarget && h > w * 1.25 && latin < text.length * 0.2) {
      vert = fitVertical(text, w, h, maxSize);
    }

    if (vert && vert.size > horiz.size) {
      const { size, columns } = vert;
      ctx.font = font(size);
      ctx.lineWidth = Math.max(2, size * 0.2);
      const colW = size * 1.18, rowH = size * 1.06;
      const longest = Math.max(...columns.map((c) => c.length));
      let x = cx + (colW * (columns.length - 1)) / 2;
      for (const col of columns) {
        let y = cy - (rowH * longest) / 2 + rowH / 2;
        for (let ch of col) {
          ch = VERTICAL_SWAP[ch] || ch;
          ctx.save();
          ctx.translate(x, y);
          if (VERTICAL_ROTATE.test(ch)) ctx.rotate(Math.PI / 2);
          else if (VERTICAL_CORNER.test(ch)) ctx.translate(size * 0.55, -size * 0.5);
          ctx.strokeText(ch, 0, 0);
          ctx.fillText(ch, 0, 0);
          ctx.restore();
          y += rowH;
        }
        x -= colW;
      }
    } else {
      const { size, lines } = horiz;
      ctx.font = font(size);
      ctx.lineWidth = Math.max(2, size * 0.2);
      const lh = size * 1.22;
      let y = cy - (lh * (lines.length - 1)) / 2;
      for (const line of lines) {
        ctx.strokeText(line, cx, y);
        ctx.fillText(line, cx, y);
        y += lh;
      }
    }
  }

  // Returns a canvas with the picture plus the typeset translation.
  globalThis.mtRender = async function mtRender(dataUrl, result, settings) {
    const im = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = im.naturalWidth;
    canvas.height = im.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(im, 0, 0);
    // The server measured the decoded picture; scale in case the sizes differ.
    const sx = canvas.width / result.width, sy = canvas.height / result.height;
    for (const b of result.blocks) {
      const scale = (v) => [v[0] * sx, v[1] * sy, v[2] * sx, v[3] * sy];
      drawBlock(ctx, { ...b, box: scale(b.box), area: scale(b.area || b.box) }, settings, canvas.width, settings.targetLang);
    }
    return canvas;
  };
})();
