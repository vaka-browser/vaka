'use strict';
/* Kosmetisk filtrering i sidan – Vakas motsvarighet till Braves cosmetic_filters.js.
 * Körs i varje ram före sidans egna skript (preload). Frågar huvudprocessen (Braves
 * adblock-rust) om sajtens regler och gör tre saker:
 *   1. döljer element enligt sajtspecifika selektorer (och sätter :style-regler),
 *   2. kör scriptlets (t.ex. nowoif mot popunders) i sidans värld via webFrame,
 *   3. plockar upp nya class/id i takt med att sidan byggs och ber om generiska
 *      dölj-selektorer för dem (batchat, som Brave).
 * Skriver aldrig till sidan förutom ett <style>-element. */
const { ipcRenderer, webFrame } = require('electron');

(function () {
  if (!/^https?:/.test(location.href)) return;
  let c = null;
  try { c = ipcRenderer.sendSync('adblock:cosmetics', location.href); } catch { return; }
  if (!c) return;

  const STYLE_ID = 'vaka-adblock';
  let styleEl = null; let cssBuf = '';
  // Preloaden kör innan <html> finns: buffra CSS och sätt in <style> så fort dokumentroten dyker upp.
  function style() {
    if (styleEl && styleEl.isConnected) return styleEl;
    const root = document.head || document.documentElement;
    if (!root) return null;
    styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = STYLE_ID; }
    styleEl.textContent = cssBuf;
    root.appendChild(styleEl);
    return styleEl;
  }
  function addCss(text) { if (!text) return; cssBuf += text + '\n'; const el = style(); if (el) el.textContent = cssBuf; }
  if (!document.documentElement) {
    const rootMo = new MutationObserver(() => { if (document.documentElement) { rootMo.disconnect(); style(); } });
    try { rootMo.observe(document, { childList: true }); } catch {}
  }
  function hide(selectors) {
    if (!selectors || !selectors.length) return;
    // Många selektorer per regel; en trasig selektor får inte fälla hela blocket → dela upp i grupper.
    for (let i = 0; i < selectors.length; i += 50) addCss(selectors.slice(i, i + 50).join(',\n') + ' { display: none !important; }');
  }

  hide(c.hide_selectors);
  if (c.style_selectors) { for (const sel of Object.keys(c.style_selectors)) { const rules = c.style_selectors[sel]; if (rules && rules.length) addCss(sel + ' { ' + rules.join('; ') + ' }'); } }
  if (c.injected_script) { try { webFrame.executeJavaScript(c.injected_script).catch(() => {}); } catch {} }

  // Håll <style> kvar om sidan städar <head>, och kör generisk dölj-logik.
  const seenClasses = new Set(), seenIds = new Set();
  let pendingC = [], pendingI = [], timer = null;
  function collect(root) {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll ? [root, ...root.querySelectorAll('[class],[id]')] : [root];
    for (const el of nodes) {
      if (!el || el.nodeType !== 1) continue;
      if (el.id && !seenIds.has(el.id)) { seenIds.add(el.id); pendingI.push(el.id); }
      const cl = el.classList; if (cl) for (const k of cl) { if (!seenClasses.has(k)) { seenClasses.add(k); pendingC.push(k); } }
    }
  }
  function flush() {
    timer = null;
    if (!pendingC.length && !pendingI.length) return;
    const classes = pendingC.splice(0, 1500), ids = pendingI.splice(0, 1500);
    let sel = [];
    try { sel = ipcRenderer.sendSync('adblock:classid', classes, ids, c.exceptions || []); } catch { sel = []; }
    hide(sel);
    if (pendingC.length || pendingI.length) schedule();
  }
  function schedule() { if (!timer) timer = setTimeout(flush, 80); }
  function startGeneric() {
    if (c.generichide) return;                                 // sajten har $generichide-undantag
    collect(document.documentElement); flush();
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') collect(m.target);
        else for (const n of m.addedNodes) if (n.nodeType === 1) collect(n);
      }
      if (pendingC.length || pendingI.length) schedule();
      if (styleEl && !styleEl.isConnected) style();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startGeneric, { once: true }); else startGeneric();
})();
