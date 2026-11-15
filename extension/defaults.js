// Shared by the service worker, content script, popup and options page.
const MT_DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8765',
  sourceLang: 'ja',
  targetLang: 'zh-TW',
  engine: 'google', // google | ollama
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'killgfat/sakura-7b-qwen2.5-v1.0',
  fontFamily: '"Microsoft JhengHei", "Noto Sans TC", "PingFang TC", sans-serif',
  fontScale: 1,
  bold: true,
  bgOpacity: 1,
  vertical: 'auto', // auto | off
  minSize: 250,
  autoSites: [],
};

const MT_SOURCE_LANGS = { ja: '日文', zh: '中文', ko: '韓文', en: '英文' };

const MT_TARGET_LANGS = {
  'zh-TW': '繁體中文', 'zh-CN': '简体中文', en: 'English', ja: '日本語', ko: '한국어',
  es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', pt: 'Português',
  ru: 'Русский', pl: 'Polski', tr: 'Türkçe', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu',
  vi: 'Tiếng Việt', th: 'ไทย', ar: 'العربية',
};

// Ollama models with a friendly label; any other installed model is listed under its own name.
const MT_KNOWN_MODELS = {
  'killgfat/sakura-7b-qwen2.5-v1.0': 'Sakura 7B（日翻中）',
  'qwen3.5:9b': 'Qwen3.5 9B（多語）',
  'qwen2.5:7b': 'Qwen2.5 7B（最快）',
};
const MT_CUSTOM_MODEL = '__custom__';

// Ollama reports "name:latest" for untagged pulls; settings store the short form.
const mtModelKey = (name) => name.replace(/:latest$/, '');

// Fills a <select> with installed + known models. `installed` is null when Ollama could not be
// asked, in which case nothing is marked as missing.
function mtFillModels(select, installed, current, { custom = false } = {}) {
  const have = installed ? new Set(installed.map(mtModelKey)) : null;
  const names = [...new Set([...Object.keys(MT_KNOWN_MODELS), ...(have || []), current].filter(Boolean))];
  names.sort((a, b) => {
    const ka = a in MT_KNOWN_MODELS ? 0 : 1, kb = b in MT_KNOWN_MODELS ? 0 : 1;
    return ka - kb || (ka ? a.localeCompare(b) : 0);
  });
  select.replaceChildren();
  for (const name of names) {
    let label = MT_KNOWN_MODELS[name] || name;
    if (have && !have.has(mtModelKey(name))) label += '（未安裝）';
    select.add(new Option(label, name));
  }
  if (custom) select.add(new Option('其他（自行輸入）…', MT_CUSTOM_MODEL));
  select.value = current;
}

function mtGetSettings() {
  return chrome.storage.local.get(MT_DEFAULTS);
}
