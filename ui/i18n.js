/* Lättviktig i18n för skalet. Översätter "per innehåll": de svenska strängarna ÄR nycklarna.
   Språkfilerna (ui/locales/<lang>.json = { "svensk sträng": "översättning" }) laddas synkront
   via preload (window.locale.load). Byte av språk sparas i localStorage och laddar om fönstret. */
(function () {
  const KEY = 'vaka-lang';
  const RTL = new Set(['ar', 'he', 'fa', 'ur']);
  // Språk som visas i väljaren (native namn). Måste ha en genererad fil i ui/locales/ (utom sv).
  const LANGS = [
    ['sv', 'Svenska'], ['en', 'English'], ['no', 'Norsk'], ['nb', 'Norsk bokmål'], ['da', 'Dansk'],
    ['fi', 'Suomi'], ['de', 'Deutsch'], ['nl', 'Nederlands'], ['es', 'Español'], ['pt', 'Português (BR)'],
    ['pt-PT', 'Português (PT)'], ['fr', 'Français'], ['it', 'Italiano'], ['pl', 'Polski'], ['cs', 'Čeština'],
    ['sk', 'Slovenčina'], ['sl', 'Slovenščina'], ['hr', 'Hrvatski'], ['sr', 'Српски'], ['ro', 'Română'],
    ['bg', 'Български'], ['hu', 'Magyar'], ['el', 'Ελληνικά'], ['uk', 'Українська'], ['ru', 'Русский'],
    ['tr', 'Türkçe'], ['ar', 'العربية'], ['he', 'עברית'], ['fa', 'فارسی'], ['ur', 'اردو'],
    ['hi', 'हिन्दी'], ['bn', 'বাংলা'], ['ta', 'தமிழ்'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'],
    ['vi', 'Tiếng Việt'], ['th', 'ไทย'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['ja', '日本語'],
    ['ko', '한국어'], ['sw', 'Kiswahili'], ['af', 'Afrikaans'], ['sq', 'Shqip'], ['mk', 'Македонски'],
    ['lt', 'Lietuvių'], ['lv', 'Latviešu'], ['et', 'Eesti'], ['is', 'Íslenska'], ['ga', 'Gaeilge'],
    ['cy', 'Cymraeg'], ['ka', 'ქართული'], ['hy', 'Հայերեն'], ['az', 'Azərbaycan'], ['kk', 'Қазақша'],
  ];

  let cur = 'sv';
  try { cur = localStorage.getItem(KEY) || 'sv'; } catch {}
  let DICT = {};
  if (cur !== 'sv') {
    try { DICT = (window.locale && window.locale.load(cur)) || {}; } catch { DICT = {}; }
  }

  function trText(node) {
    const raw = node.nodeValue;
    if (!raw) return;
    const k = raw.trim();
    if (!k) return;
    const v = DICT[k];
    if (v != null && v !== k) node.nodeValue = raw.replace(k, v);
  }
  function trAttrs(el) {
    if (!el.getAttribute) return;
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const val = el.getAttribute(a);
      if (!val) continue;
      const k = val.trim();
      const v = DICT[k];
      if (v != null && v !== k) el.setAttribute(a, val.replace(k, v));
    }
  }
  function translateTree(root) {
    if (cur === 'sv' || !root) return;
    if (root.nodeType === 3) { trText(root); return; }
    if (root.nodeType !== 1) return;
    trAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = []; let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(trText);
    if (root.querySelectorAll) root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(trAttrs);
  }

  function apply() {
    try {
      document.documentElement.lang = cur;
      document.documentElement.dir = RTL.has(cur) ? 'rtl' : 'ltr';
    } catch {}
    if (cur !== 'sv') translateTree(document.body);
  }

  window.t = function (sv) { const v = DICT[sv]; return v == null ? sv : v; };
  window.i18n = {
    get lang() { return cur; },
    langs: LANGS,
    set(lang) { try { localStorage.setItem(KEY, lang); } catch {} location.reload(); },
    apply, translateTree,
  };

  function boot() {
    apply();
    if (cur === 'sv') return;               // svenska = originalet, ingen observer behövs
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes) m.addedNodes.forEach((node) => translateTree(node));
        if (m.type === 'attributes' && m.target && m.target.nodeType === 1) trAttrs(m.target);
      }
    });
    try { mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] }); } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
