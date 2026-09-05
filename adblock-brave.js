'use strict';
/* Braves adblocker i Vaka.
 *
 * Motorn är Braves egen adblock-rust (MPL-2.0) genom deras officiella Node-bindning
 * adblock-rs, byggd som native modul per plattform (native/adblock/<platform>-<arch>/).
 * Samma listor som Brave Shields använder som standard (filters/), samma scriptlet-
 * resurser och samma kosmetiska modell: dölj-selektorer per sajt vid start, generiska
 * class/id-selektorer i takt med att sidan byggs, scriptlets injicerade före sidans egna
 * skript. Huvudprocessen svarar på nätverksfrågor och kosmetik; adblock-preload.js gör
 * jobbet inne i sidan. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let electron = null; try { electron = require('electron'); } catch {}

const RES_SCHEME = 'vaka-res';
/* Måste anropas FÖRE app.ready: stub-resurser (tomt adsbygoogle.js m.fl.) serveras via eget schema
 * eftersom Chromium vägrar omdirigera nätverksanrop till data:-URL:er. */
function registerScheme() {
  try { electron.protocol.registerSchemesAsPrivileged([{ scheme: RES_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }]); } catch {}
}

const TYPE_MAP = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image',
  font: 'font', object: 'object', xhr: 'xhr', ping: 'ping', cspReport: 'csp_report', media: 'media',
  webSocket: 'websocket', other: 'other',
};

function loadNative() {
  const target = process.platform + '-' + process.arch;
  const local = path.join(__dirname, 'native', 'adblock', target, 'index.js');
  const errors = [];
  for (const cand of [local, 'adblock-rs']) {
    try { const m = require(cand); if (m && m.Engine && m.FilterSet) return { mod: m, from: cand }; } catch (e) { errors.push(cand + ': ' + (e && e.message)); }
  }
  console.warn('[adblock] ingen native motor för ' + target + ' — ' + errors.join(' | '));
  return null;
}

class BraveAdblock {
  constructor(opts) {
    this.filtersDir = opts.filtersDir;
    this.cacheDir = opts.cacheDir;
    this.preloadPath = opts.preloadPath;
    this.allowHost = opts.allowHost || (() => false);
    this.onBlocked = opts.onBlocked || (() => {});
    this.isOn = opts.isOn || (() => true);
    this.native = null; this.engine = null; this.popupEngine = null;
    this.ready = null; this.version = 'adblock-rust';
    this.sessions = new Set();
    this.stubs = new Map();     // hash → { mime, body } för omdirigerade resurser
  }

  stubUrlFor(dataUrl) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || ''); if (!m) return null;
    const h = crypto.createHash('sha1').update(dataUrl).digest('hex');
    if (!this.stubs.has(h)) this.stubs.set(h, { mime: m[1], body: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8') });
    return RES_SCHEME + '://r/' + h;
  }
  serveStubsOn(sess) {
    try {
      if (sess.protocol.isProtocolHandled(RES_SCHEME)) return;
      sess.protocol.handle(RES_SCHEME, (req) => {
        const h = (new URL(req.url).pathname || '').replace(/^\//, '');
        const st = this.stubs.get(h);
        if (!st) return new Response('', { status: 404 });
        return new Response(st.body, { status: 200, headers: { 'content-type': st.mime, 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
      });
    } catch (e) { console.warn('[adblock] stub-schema:', String(e)); }
  }

  /* Alla .txt i filters/ är listor. Resurser (scriptlets/omdirigeringar) ligger i resources-*.json. */
  listFiles() {
    try { return fs.readdirSync(this.filtersDir).filter((f) => f.endsWith('.txt')).sort(); } catch { return []; }
  }
  fingerprint(files) {
    const parts = ['adblock-rust', this.version];
    for (const f of files) { try { const st = fs.statSync(path.join(this.filtersDir, f)); parts.push(f + ':' + st.size + ':' + Math.floor(st.mtimeMs)); } catch {} }
    return parts.join('|');
  }
  readLists(files) {
    const chunks = [];
    for (const f of files) { try { chunks.push(fs.readFileSync(path.join(this.filtersDir, f), 'utf8')); } catch {} }
    return chunks.join('\n');
  }
  resources() {
    const out = [];
    for (const f of ['resources-scriptlets.json', 'resources-ubo.json', 'resources-brave.json']) {
      try { const j = JSON.parse(fs.readFileSync(path.join(this.filtersDir, f), 'utf8')); if (Array.isArray(j)) out.push(...j); } catch {}
    }
    return out;
  }

  load() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const n = loadNative(); if (!n) return false;
      this.native = n.mod;
      try { this.version = 'adblock-rust ' + (require(path.join(path.dirname(require.resolve(n.from)), 'package.json')).version || ''); } catch {}
      await new Promise((r) => setImmediate(r));                 // släpp fram fönstrets första målning
      const { Engine, FilterSet, FilterFormat, RuleTypes } = this.native;
      const files = this.listFiles();
      const fp = this.fingerprint(files);
      const cacheDir = typeof this.cacheDir === 'function' ? this.cacheDir() : this.cacheDir;
      const bin = path.join(cacheDir, 'brave-engine.bin'), meta = path.join(cacheDir, 'brave-engine.meta');
      let engine = null;
      try {
        if (fs.existsSync(bin) && fs.readFileSync(meta, 'utf8') === fp) {
          const b = fs.readFileSync(bin);
          engine = new Engine(new FilterSet(false));
          engine.deserialize(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        }
      } catch { engine = null; }
      if (!engine) {
        const t0 = Date.now();
        const set = new FilterSet(false);
        set.addFilters(this.readLists(files), { format: FilterFormat.STANDARD, rule_types: RuleTypes.ALL });
        engine = new Engine(set);
        try { fs.writeFileSync(bin, Buffer.from(engine.serialize())); fs.writeFileSync(meta, fp); } catch {}
        console.log('[adblock] motor byggd från ' + files.length + ' listor på ' + (Date.now() - t0) + ' ms');
      }
      try { engine.useResources(this.resources()); } catch (e) { console.warn('[adblock] resurser:', String(e)); }
      this.engine = engine;
      setImmediate(() => this.buildPopupEngine(files));
      for (const s of this.sessions) { if (this.isOn()) this.enableOn(s); }
      return true;
    })();
    return this.ready;
  }

  /* $popup-regler (EasyList/uBlock: annonsfönster, popunders) matchas mot window.open- och
   * navigeringsmål. Vi plockar ut dem till en egen motor och matchar som main_frame. */
  buildPopupEngine(files) {
    try {
      const { Engine, FilterSet, FilterFormat, RuleTypes } = this.native;
      const rules = [];
      for (const f of files) {
        let txt = ''; try { txt = fs.readFileSync(path.join(this.filtersDir, f), 'utf8'); } catch { continue; }
        for (const line of txt.split('\n')) {
          if (!/\$[^\s]*\bpopup\b/.test(line) || line.startsWith('!') || line.includes('~popup') || line.includes('##')) continue;
          const r = line.replace(/\$([^\s]*)$/, (m, opts) => { const o = opts.split(',').filter((x) => x !== 'popup'); return o.length ? '$' + o.join(',') : ''; });
          if (r) rules.push(r);
        }
      }
      if (!rules.length) return;
      const set = new FilterSet(false);
      set.addFilters(rules.join('\n'), { format: FilterFormat.STANDARD, rule_types: RuleTypes.NETWORK_ONLY });
      this.popupEngine = new Engine(set);
      console.log('[adblock] popup-regler:', rules.length);
    } catch (e) { this.popupEngine = null; console.warn('[adblock] popup-motor:', String(e)); }
  }

  /* Nätverksfråga: true = blockera. Returnerar ev. omdirigering (stub-resurs) i r.redirect. */
  check(url, sourceUrl, type, method) {
    if (!this.engine) return null;
    try { return this.engine.check(url, sourceUrl || url, type || 'other', method || '', true); } catch { return null; }
  }
  /* Ska en navigering/popup dödas? (main_frame-regler + $popup-regler) */
  checkTarget(url, sourceUrl) {
    if (!this.engine) return false;
    try {
      if (this.engine.check(url, sourceUrl || url, 'main_frame', '')) return true;
      if (this.popupEngine) { for (const t of ['main_frame', 'other']) if (this.popupEngine.check(url, sourceUrl || url, t, '')) return true; }
    } catch {}
    return false;
  }
  cosmeticsFor(url) {
    if (!this.engine || !this.isOn()) return null;
    try { return this.engine.urlCosmeticResources(url); } catch { return null; }
  }
  classIdSelectors(classes, ids, exceptions) {
    if (!this.engine || !this.isOn()) return [];
    try { return this.engine.hiddenClassIdSelectors(classes || [], ids || [], exceptions || []); } catch { return []; }
  }

  install(sess) { this.sessions.add(sess); if (this.engine && this.isOn()) this.enableOn(sess); else this.load(); }

  enableOn(sess) {
    if (!this.engine) return;
    this.serveStubsOn(sess);
    try {
      sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
        const type = TYPE_MAP[d.resourceType] || 'other';
        if (type === 'main_frame' || !this.isOn() || this.allowHost(d.url)) { cb({}); return; }
        const src = d.referrer || (d.frame && d.frame.url) || d.url;
        const r = this.check(d.url, src, type, d.method);
        if (r && r.should_block) {
          this.onBlocked(d.url, type);
          const stub = r.redirect ? this.stubUrlFor(r.redirect) : null;
          if (stub) { cb({ redirectURL: stub }); return; }             // stub (t.ex. tomt adsbygoogle.js) så sidan inte kraschar
          cb({ cancel: true }); return;
        }
        cb({});
      });
    } catch {}
    try {
      const p = this.preloadPath; if (!p) return;
      if (sess.registerPreloadScript) {
        if (!sess.__vakaAdblockPreload) sess.__vakaAdblockPreload = sess.registerPreloadScript({ type: 'frame', filePath: p });
      } else {
        const cur = sess.getPreloads() || []; if (!cur.includes(p)) sess.setPreloads([...cur, p]);
      }
    } catch {}
  }
  disableOn(sess) {
    try { sess.webRequest.onBeforeRequest(null); } catch {}
    try {
      if (sess.unregisterPreloadScript) { if (sess.__vakaAdblockPreload) { sess.unregisterPreloadScript(sess.__vakaAdblockPreload); sess.__vakaAdblockPreload = null; } }
      else { const p = this.preloadPath; if (p) sess.setPreloads((sess.getPreloads() || []).filter((x) => x !== p)); }
    } catch {}
  }
}

module.exports = { BraveAdblock, registerScheme };
