// Shared by the service worker, content script, popup and options page.
const MT_DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8765',
  sourceLang: 'ja',
  targetLang: 'zh-TW',
  engine: 'google', // google | ollama
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
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

function mtGetSettings() {
  return chrome.storage.local.get(MT_DEFAULTS);
}
