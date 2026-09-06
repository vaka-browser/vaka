'use strict';
/*
 * Vaka – demo (Electron/Chromium)
 * Arkitektur: varje FÖNSTER är en BrowserWindow som renderar "chrome"
 * (flikar/verktygsrad/startsida/varning) som HTML. Varje fliks webbsida är en
 * WebContentsView som huvudprocessen placerar i fönstrets innehållsyta.
 * Allt fönster-tillstånd (flikar, synlig flik, mått, Krypto-panel) ligger i ett
 * per-fönster "ctx"-objekt i `wins`, nycklat på skalets webContents-id. IPC
 * routas till rätt fönster via `event.sender`.
 */
const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, clipboard, dialog, shell, safeStorage, components, screen, net } = require('electron');
app.setName('Vaka');  // egen datamapp, skild från Vaka
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const QRCode = require('qrcode');

const { SKOLL, EXTRACT_JS, analyzeContent, verdictFromReport, checkUrl } = require('./scanner');
const auth = require('./auth');

// Auto-uppdatering
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

// Riktig filtermotor (EasyList + EasyPrivacy) för nätverks-/kosmetisk blockering.
const { BraveAdblock, registerScheme: registerAdblockScheme } = require('./adblock-brave');   // Braves adblock-rust via adblock-rs (native)
registerAdblockScheme();   // före app.ready

const KRYPTO_W = 400;
const NET_H = 340;          // nätverksinspektörens dockade höjd
const NET_MAX = 800;        // max antal requests i bufferten per fönster
const wins = new Map();                 // skalets webContents-id -> ctx

/* ────────── Minnesbesparing (Memory Saver) ──────────
 * Chromium drar mycket RAM eftersom varje flik får en egen renderer-process.
 * 1) Vi stänger av oanvända delsystem (översättning, mediarouter, hints).
 * 2) Inaktiva bakgrundsflikar "kastas" efter en stund: renderer-processen rivs
 *    och endast URL:en sparas; fliken återuppstår vid klick (discardTab/sweep). */
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints');
// Linux: kör mot Wayland när sessionen är Wayland. Utan hinten väljer Electron
// X11 (XWayland), och där krympte/flyttade ett maximerat fönster när fokus
// gick till en annan skärm (Cetto 2026-09-04). Startad med hinten stod det kvar.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
const DISCARD_MS = Number(process.env.TAB_DISCARD_MS) || 10 * 60 * 1000;  // kasta flik efter 10 min ledig
const DISCARD_SWEEP_MS = 60 * 1000;                                       // svep varje minut

function makeCtx(win, incognito) {
  return {
    win, incognito: !!incognito,
    views: new Map(),                   // tabId -> WebContentsView
    incognitoTabs: new Set(),           // tabId:er som kör efemär (inkognito) session
    discarded: new Map(),               // tabId -> url för kastade (RAM-frigjorda) flikar
    lastActive: new Map(),              // tabId -> tidsstämpel senast synlig (för discard-svep)
    visibleTab: null,
    bounds: { x: 0, y: 96, width: 1280, height: 700 },
    topInset: 0, leftInset: 0, defaultZoom: 1,
    kryptoView: null, kryptoOpen: false, kryptoFull: false, vakaToken: null,
    net: null, netOpen: false,          // nätverksinspektör (Wireshark-lik, via CDP)
    htmlFull: false, _wasFull: false,   // HTML5-video/element i helskärm
  };
}
function ctxFor(event) { return wins.get(event.sender.id); }

/* Helskärm lämnas BARA på begäran: F11, menyn eller sidans egen knapp.
 * GNOME på Wayland släpper helskärmsflaggan när fönstret tappar fokus till en
 * annan skärm, och Chromium lyder. fullWanted är vad användaren vill; allt som
 * avviker från det utan att vara begärt sätts tillbaka (se leave-full-screen). */
function setFull(ctx, want) {
  ctx.fullWanted = !!want;
  // macOS: fönstret är normalt inte "fullscreenable" (gröna knappen maximerar då). Helskärm på
  // begäran (F11/meny/sidans video) slår på det tillfälligt; leave-full-screen stänger av igen.
  if (want && process.platform === 'darwin') { try { ctx.win.setFullScreenable(true); } catch {} }
  try { ctx.win.setFullScreen(!!want); } catch {}
}
function toggleFull(ctx) { setFull(ctx, !ctx.win.isFullScreen()); }
function sendTo(ctx, ...a) { if (ctx && ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(...a); }
function broadcast(...a) { wins.forEach((ctx) => sendTo(ctx, ...a)); if (a[0] === 'download-update') pushDownloadPopups(); }
/* Nedladdnings-popup = WebContentsView OVANPÅ fliken (ej separat fönster: Wayland kan ej
 * positionera fönster; ej DOM-overlay: flikens native-vy ritas ovanpå skalets HTML och skulle
 * dölja den). En child-vy positioneras med setBounds relativt fönstret → funkar på Wayland. */
const DL_W = 392;
function pushDownloadPopups() {
  wins.forEach((ctx) => { if (ctx.dlView && !ctx.dlView.webContents.isDestroyed()) ctx.dlView.webContents.send('dl-data', downloads); });
}
function positionDlPopup(ctx, h) {
  if (!ctx || !ctx.dlView || !ctx.win || ctx.win.isDestroyed()) return;
  const cb = ctx.win.getContentBounds();
  if (typeof h === 'number') ctx._dlH = h;
  const top = Math.max(0, Math.round((ctx.topInset || 92) + 6));
  const height = Math.max(70, Math.min(ctx._dlH || 200, cb.height - top - 12));
  try { ctx.dlView.setBounds({ x: Math.round(cb.width - DL_W - 8), y: top, width: DL_W, height }); } catch {}
}
function closeDlPopup(ctx) {
  if (!ctx || !ctx.dlView) return;
  try { ctx.win.contentView.removeChildView(ctx.dlView); } catch {}
  try { ctx.dlView.webContents.close(); } catch {}
  if (ctx._dlRepos) { try { ctx.win.removeListener('resize', ctx._dlRepos); ctx.win.removeListener('move', ctx._dlRepos); } catch {} ctx._dlRepos = null; }
  ctx.dlView = null;
}
function openDlPopup(ctx) {
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
  if (ctx.dlView) { try { ctx.win.contentView.addChildView(ctx.dlView); } catch {} positionDlPopup(ctx); ctx.dlView.webContents.send('dl-data', downloads); return; }  // redan öppen → höj + uppdatera
  const view = new WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false, transparent: true } });   // transparent: bara kortet syns, inte vyns rektangel
  try { view.setBackgroundColor('#00000000'); } catch {}
  ctx.dlView = view;
  ctx._dlH = 200;
  ctx.win.contentView.addChildView(view);
  positionDlPopup(ctx);
  const repos = () => positionDlPopup(ctx);
  ctx._dlRepos = repos;
  ctx.win.on('resize', repos); ctx.win.on('move', repos);
  view.webContents.loadFile(path.join(__dirname, 'ui', 'downloads.html'));
  view.webContents.on('did-finish-load', () => { view.webContents.send('dl-data', downloads); });
}

/* ────────── Adblocker (kurerad värdlista – demo) ────────── */
const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.com', 'pagead2.googlesyndication.com',
  'connect.facebook.net', 'ads-twitter.com', 'scorecardresearch.com', 'quantserve.com', 'adnxs.com',
  'rubiconproject.com', 'pubmatic.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
  'amazon-adsystem.com', 'adsafeprotected.com', 'moatads.com', 'bidswitch.net', 'casalemedia.com',
  'openx.net', 'yieldmo.com', 'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io', 'fullstory.com',
  'clarity.ms', 'bat.bing.com', 'branch.io', 'appsflyer.com', 'adcolony.com', 'inmobi.com',
];
// Spårare (analys/spårning) skiljs från rena annonser så startsidan kan visa dem separat.
const TRACKER_HOSTS = new Set([
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'connect.facebook.net',
  'ads-twitter.com', 'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'mixpanel.com',
  'segment.com', 'segment.io', 'fullstory.com', 'clarity.ms', 'bat.bing.com', 'branch.io', 'appsflyer.com',
]);
let adblockOn = true;
let adblockCount = 0;
function hostCategory(url) {
  try {
    const h = new URL(url).hostname;
    const hit = AD_HOSTS.find((a) => h === a || h.endsWith('.' + a));
    if (!hit) return null;
    return TRACKER_HOSTS.has(hit) ? 'tracker' : 'ad';
  } catch { return null; }
}
// ── Filtermotor: Braves adblock-rust (adblock-brave.js) – laddas en gång, aktiveras per session ──
let engine = null;                       // sätts till motorn när den är laddad (används som "är igång"-flagga)
const blockedSessions = new Set();
// Allowlist: blockera ALDRIG anrop till inloggnings-/konto-domäner (annars kan 2FA-verifiering m.m. hänga)
const ADBLOCK_ALLOW = /(^|\.)(github\.com|githubusercontent\.com|githubassets\.com|github\.io|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|okta\.com|auth0\.com|duosecurity\.com)$/i;
function adblockAllowHost(url) { try { return ADBLOCK_ALLOW.test(new URL(url).hostname); } catch { return false; } }
const adblock = new BraveAdblock({
  filtersDir: path.join(__dirname, 'filters'),
  cacheDir: () => app.getPath('userData'),
  preloadPath: path.join(__dirname, 'adblock-preload.js'),
  allowHost: (u) => adblockAllowHost(u),
  isOn: () => adblockOn,
  onBlocked: (url) => { adblockCount++; broadcast('adblock:count', adblockCount); broadcast('adblock:hit', hostCategory(url) === 'tracker' ? 'tracker' : 'ad'); },
});
function loadEngine() { return adblock.load().then((ok) => { if (ok) engine = adblock; return ok; }); }
function enableEngineOn(sess) { adblock.enableOn(sess); }
function disableEngineOn(sess) { adblock.disableOn(sess); }
// Kosmetik för adblock-preload.js (synkront – måste vara klart innan sidans skript kör)
ipcMain.on('adblock:cosmetics', (e, url) => { e.returnValue = adblock.cosmeticsFor(String(url || '')); });
ipcMain.on('adblock:classid', (e, classes, ids, exceptions) => { e.returnValue = adblock.classIdSelectors(classes, ids, exceptions); });

function installAdblockOn(sess) {
  blockedSessions.add(sess);
  adblock.install(sess);
  if (!engine) loadEngine();
}

// Popup-fönster som får öppnas på riktigt trots att de är korsdomän: inloggning/betalning.
const POPUP_TRUSTED = /(^|\.)(accounts\.google\.com|google\.com|appleid\.apple\.com|apple\.com|login\.microsoftonline\.com|login\.live\.com|microsoft\.com|facebook\.com|github\.com|bankid\.com|stripe\.com|paypal\.com|klarna\.com|yahoo\.com|twitch\.tv|discord\.com|auth0\.com|okta\.com|linkedin\.com|x\.com|twitter\.com|slack\.com|zoom\.us|adyen\.com|swish\.nu|trustly\.com|vipps\.no|mobilepay\.dk|spotify\.com|amazon\.com|amazon\.se|steamcommunity\.com|steampowered\.com|epicgames\.com|battle\.net|dropbox\.com|atlassian\.com|gitlab\.com|bitbucket\.org|shopify\.com|frejaeid\.com|signicat\.com|criipto\.com|nets\.eu|paypalobjects\.com|duosecurity\.com)$/i;
function popupTrustedHost(url) { try { return POPUP_TRUSTED.test(new URL(url).hostname); } catch { return false; } }
function siteOf(url) {
  try { const p = new URL(url).hostname.toLowerCase().split('.'); return (p.length > 2 && /^(co|com|org|net|gov|edu|ac)$/.test(p[p.length - 2])) ? p.slice(-3).join('.') : p.slice(-2).join('.'); } catch { return ''; }
}
function sameSite(a, b) { const x = siteOf(a); return !!x && x === siteOf(b); }
// Ska den här navigeringen/popupen dödas direkt? (annons/tracker/skräp-schema)
function isBlockedTarget(url, sourceUrl) {
  if (!/^https?:/i.test(url)) return true;            // javascript:, data:, blob:, about:blank-kedjor
  try {
    if (adblock.checkTarget(url, sourceUrl)) return true;   // main_frame- och $popup-regler (Braves motor)
  } catch {}
  return !!hostCategory(url);
}
// När vi ersätter user-agent-strängen slutar Chromium skicka Sec-CH-UA-client hints.
// En "Chrome" utan client hints ser bot-aktig ut för Google → vi återinför dem så de
// matchar vår UA (Chrome-version ur UA, plattform ur process.platform).
function chMajor() { return (app.userAgentFallback.match(/Chrome\/(\d+)/) || [])[1] || '130'; }
function chPlatform() {
  return process.platform === 'win32' ? 'Windows'
       : process.platform === 'darwin' ? 'macOS' : 'Linux';
}
function applyClientHints(sess) {
  try {
    const v = chMajor();
    const brand = `"Not;A=Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`;
    const plat = `"${chPlatform()}"`;
    sess.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      h['sec-ch-ua'] = brand;
      h['sec-ch-ua-mobile'] = '?0';
      h['sec-ch-ua-platform'] = plat;
      cb({ requestHeaders: h });
    });
  } catch {}
}

let incognitoAdblockDone = false;
function ensureIncognitoAdblock() {
  if (incognitoAdblockDone) return;
  incognitoAdblockDone = true;
  try { const s = session.fromPartition('skoll-incognito'); applyClientHints(s); installAdblockOn(s); trackDownloads(s); } catch {}
}

/* ── Tor (oanvänd – behållen som referens) ── */
const TOR_DIR = path.join(__dirname, 'tor');
const TOR_SOCKS = 9250;
let torProc = null;
let torState = 'off';
function setTorState(s) { torState = s; broadcast('tor-state', s); }
ipcMain.handle('tor:state', () => torState);

/* Metadata-bedömning + checkUrl finns i scanner.js (delas med testriggen). */
async function dailyImage() {
  try {
    const res = await fetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=sv-SE',
      { signal: AbortSignal.timeout(6000) });
    const j = await res.json(); const img = j?.images?.[0];
    if (img?.url) return { url: 'https://www.bing.com' + img.url, credit: img.copyright || '' };
  } catch {}
  return { url: null, credit: '' };
}

/* ────────── Vy-hantering (per fönster) ────────── */
function canGo(wc, dir) {
  try { return dir < 0 ? wc.navigationHistory.canGoBack() : wc.navigationHistory.canGoForward(); }
  catch { return dir < 0 ? wc.canGoBack() : wc.canGoForward(); }
}
function applyBounds(ctx) {
  if (!ctx) return;
  const b = ctx.bounds;
  if (ctx.htmlFull && ctx.visibleTab && ctx.views.has(ctx.visibleTab)) {   // video/element i helskärm → täck HELA fönstret (över verktygsrad + flikar)
    const cb = ctx.win.getContentBounds();
    ctx.views.get(ctx.visibleTab).setBounds({ x: 0, y: 0, width: Math.round(cb.width), height: Math.round(cb.height) });
    if (ctx.kryptoView) ctx.kryptoView.setVisible(false);
    return;
  }
  const full = ctx.kryptoOpen && ctx.kryptoFull;              // Krypto i helskärm (täcker webbytan)
  const kw = (ctx.kryptoOpen && !full) ? KRYPTO_W : 0;        // sidopanelens bredd (0 i helskärm – panelen ligger ovanpå)
  const nh = ctx.netOpen ? NET_H : 0;                         // nätverksinspektörens höjd (dockad längst ner)
  const R = Math.round;
  if (ctx.visibleTab && ctx.views.has(ctx.visibleTab)) {
    ctx.views.get(ctx.visibleTab).setBounds({ x: R(b.x + ctx.leftInset), y: R(b.y + ctx.topInset), width: R(b.width - kw - ctx.leftInset), height: R(b.height - ctx.topInset - nh) });
  }
  if (ctx.kryptoView) {
    ctx.kryptoView.setVisible(ctx.kryptoOpen);
    if (ctx.kryptoOpen) {
      if (full) ctx.kryptoView.setBounds({ x: R(b.x + ctx.leftInset), y: R(b.y), width: R(b.width - ctx.leftInset), height: R(b.height) });
      else ctx.kryptoView.setBounds({ x: R(b.x + b.width - KRYPTO_W), y: R(b.y), width: KRYPTO_W, height: R(b.height) });
    }
  }
}
function raiseKrypto(ctx) { if (ctx && ctx.kryptoView) ctx.win.contentView.addChildView(ctx.kryptoView); }
function showOnly(ctx, tabId) {
  const now = Date.now();
  if (ctx.visibleTab && ctx.visibleTab !== tabId) ctx.lastActive.set(ctx.visibleTab, now); // starta ledig-klockan för fliken vi lämnar
  ctx.visibleTab = tabId;
  ctx.lastActive.set(tabId, now);
  ctx.views.forEach((v, id) => v.setVisible(id === tabId));
  applyBounds(ctx); raiseKrypto(ctx);
}
/* Kasta en dold, oanvänd flik: riv WebContentsView (frigör renderer-processen)
 * och minns bara URL:en. Ljudande flikar och inkognito lämnas ifred. */
function discardTab(ctx, tabId) {
  const v = ctx.views.get(tabId);
  if (!v || tabId === ctx.visibleTab || ctx.incognitoTabs.has(tabId)) return;
  const wc = v.webContents;
  try { if (wc.isCurrentlyAudible()) return; } catch {}   // spelar ljud (musik/video) → lämna ifred
  let url = ''; try { url = wc.getURL() || ''; } catch {}
  if (!/^https?:/i.test(url)) return;                      // bara riktiga webbsidor kan återuppstå
  ctx.discarded.set(tabId, url);
  try { ctx.win.contentView.removeChildView(v); } catch {}
  try { wc.close(); } catch {}
  ctx.views.delete(tabId); ctx.lastActive.delete(tabId);
  sendTo(ctx, 'tab-discarded', tabId);                     // skalet kan grå-markera fliken (valfritt)
}
/* Återuppliva en kastad flik: skapa vyn igen och ladda om sparad URL. */
function rehydrate(ctx, tabId) {
  const url = ctx.discarded.get(tabId);
  ctx.discarded.delete(tabId);
  const view = ensureView(ctx, tabId);
  if (url) { try { view.webContents.loadURL(url).catch(() => {}); } catch {} }
  return view;
}
/* Svep: kasta varje dold flik som legat oanvänd längre än DISCARD_MS. */
function sweepIdleTabs() {
  const now = Date.now();
  wins.forEach((ctx) => {
    if (!ctx || !ctx.views) return;
    ctx.views.forEach((_v, id) => {
      if (id === ctx.visibleTab) return;
      const last = ctx.lastActive.get(id) || now;
      if (now - last >= DISCARD_MS) discardTab(ctx, id);
    });
  });
}
/* ── Högerklicksmeny (Chromium-lik) ── */
async function savePage(ctx, wc) {
  const r = await dialog.showSaveDialog(ctx.win, { defaultPath: 'sida.html', filters: [{ name: 'Webbsida', extensions: ['html'] }] });
  if (!r.canceled && r.filePath) { try { await wc.savePage(r.filePath, 'HTMLComplete'); } catch {} }
}
async function showQR(ctx, url) {
  try { const dataUrl = await QRCode.toDataURL(url, { width: 260, margin: 1, color: { dark: '#0e2a47', light: '#ffffff' } }); sendTo(ctx, 'show-qr', url, dataUrl); } catch {}
}
/* Skriv ut: finns en skrivare → systemets utskriftsdialog. Annars faller vi
 * tillbaka på PDF (som Chromes "Spara som PDF") så knappen ALLTID gör något. */
async function makePdf(ctx, wc) {
  try {
    const data = await wc.printToPDF({ printBackground: true });
    let name = 'utskrift';
    try { name = (new URL(wc.getURL()).hostname.replace(/^www\./, '') || 'utskrift'); } catch {}
    const file = path.join(app.getPath('downloads'), name + '-' + Date.now() + '.pdf');
    fs.writeFileSync(file, data);
    await shell.openPath(file);
    sendTo(ctx, 'toast', 'Ingen skrivare hittades – sparade sidan som PDF och öppnade den.');
  } catch { sendTo(ctx, 'toast', 'Kunde inte skriva ut sidan.'); }
}
async function printPage(ctx, wc) {
  let printers = [];
  try { printers = await wc.getPrintersAsync(); } catch {}
  if (printers && printers.length) { try { wc.print({}); return; } catch {} }
  await makePdf(ctx, wc);
}
function buildContextMenu(ctx, wc, params) {
  const nav = wc.navigationHistory;
  const url = wc.getURL();
  const t = [];
  t.push({ label: T('Tillbaka'), enabled: nav.canGoBack(), click: () => { try { nav.goBack(); } catch { wc.goBack(); } } });
  t.push({ label: T('Framåt'), enabled: nav.canGoForward(), click: () => { try { nav.goForward(); } catch { wc.goForward(); } } });
  t.push({ label: T('Läs in igen'), click: () => wc.reload() });
  t.push({ type: 'separator' });
  if (params.linkURL) {
    t.push({ label: T('Öppna länk i ny flik'), click: () => sendTo(ctx, 'open-new-tab', params.linkURL) });
    t.push({ label: T('Kopiera länkadress'), click: () => clipboard.writeText(params.linkURL) });
    t.push({ type: 'separator' });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    t.push({ label: T('Spara bild som…'), click: () => wc.downloadURL(params.srcURL) });
    t.push({ label: T('Kopiera bildadress'), click: () => clipboard.writeText(params.srcURL) });
    t.push({ type: 'separator' });
  }
  if (params.isEditable) {
    t.push({ label: T('Klipp ut'), role: 'cut', enabled: params.editFlags.canCut });
    t.push({ label: T('Kopiera'), role: 'copy', enabled: params.editFlags.canCopy });
    t.push({ label: T('Klistra in'), role: 'paste', enabled: params.editFlags.canPaste });
    t.push({ type: 'separator' });
  } else if (params.selectionText && params.selectionText.trim()) {
    const sel = params.selectionText.trim();
    const short = sel.length > 24 ? sel.slice(0, 24) + '…' : sel;
    t.push({ label: T('Kopiera'), role: 'copy' });
    t.push({ label: T('Sök på Google efter') + ` "${short}"`, click: () => sendTo(ctx, 'open-new-tab', 'https://www.google.com/search?q=' + encodeURIComponent(sel)) });
    t.push({ type: 'separator' });
  }
  t.push({ label: T('Spara som…'), click: () => savePage(ctx, wc) });
  t.push({ label: T('Skriv ut…'), click: () => printPage(ctx, wc) });
  t.push({ label: T('Skapa QR-kod för sidan'), click: () => showQR(ctx, url) });
  t.push({ label: T('Översätt till svenska'), click: () => sendTo(ctx, 'open-new-tab', 'https://translate.google.com/translate?sl=auto&tl=sv&u=' + encodeURIComponent(url)) });
  t.push({ type: 'separator' });
  t.push({ label: T('Visa sidans källa'), click: () => sendTo(ctx, 'open-tab-raw', 'view-source:' + url) });
  t.push({ label: T('Inspektera'), click: () => { try { wc.inspectElement(params.x, params.y); } catch {} } });
  Menu.buildFromTemplate(t).popup({ window: ctx.win });
}

/* Högerklicksmeny på skalet (startsida, verktygsrad, adressfält) – native-vyerna
 * har sin egen (buildContextMenu); skalets webContents hade ingen alls. */
function buildShellMenu(ctx, wc, params) {
  const t = [];
  if (params.isEditable) {
    t.push({ label: T('Klipp ut'), role: 'cut', enabled: params.editFlags.canCut });
    t.push({ label: T('Kopiera'), role: 'copy', enabled: params.editFlags.canCopy });
    t.push({ label: T('Klistra in'), role: 'paste', enabled: params.editFlags.canPaste });
    t.push({ type: 'separator' });
    t.push({ label: T('Markera allt'), role: 'selectAll' });
  } else if (params.selectionText && params.selectionText.trim()) {
    t.push({ label: T('Kopiera'), role: 'copy' });
  } else {
    t.push({ label: T('Ny flik'), click: () => sendTo(ctx, 'open-new-tab') });
    t.push({ label: T('Nytt fönster'), click: () => createWindow(false) });
    t.push({ label: T('Ny inkognitoflik'), click: () => sendTo(ctx, 'new-incognito') });
    const clip = (clipboard.readText() || '').trim();
    if (clip) {
      const short = clip.length > 32 ? clip.slice(0, 32) + '…' : clip;
      t.push({ type: 'separator' });
      t.push({ label: T('Klistra in och gå till') + ` "${short}"`, click: () => sendTo(ctx, 'open-new-tab', clip) });
    }
    t.push({ type: 'separator' });
    t.push({ label: T('Historik'), click: () => sendTo(ctx, 'open-history') });
    t.push({ label: T('Inställningar'), click: () => sendTo(ctx, 'open-settings') });
  }
  if (t.length) Menu.buildFromTemplate(t).popup({ window: ctx.win });
}

function ensureView(ctx, tabId) {
  if (ctx.views.has(tabId)) return ctx.views.get(tabId);
  const incognito = ctx.incognito || ctx.incognitoTabs.has(tabId);
  if (incognito) ensureIncognitoAdblock();
  // nodeIntegrationInSubFrames: kortväljaren måste nå fälten i kassornas iframes
  // (Stripe/PayPal/Klarna lägger varje fält i en egen ram). Preloaden är isolerad
  // från sidans JS (contextIsolation) och exponerar inget till sidan.
  const wp = { preload: path.join(__dirname, 'content-preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false, nodeIntegrationInSubFrames: true };
  if (incognito) wp.partition = 'skoll-incognito';
  const view = new WebContentsView({ webPreferences: wp });
  view.setVisible(false);
  ctx.win.contentView.addChildView(view);
  const wc = view.webContents;
  wc.__ctx = ctx;                       // för routing av innehålls-IPC (t.ex. pw:capture)
  // Brave-stil popup-hantering: filtermotorn (EasyLists popup-/annons-regler) avgör.
  // Nedladdningar rörs ALDRIG av det här — en download går via session.will-download,
  // aldrig genom window.open/navigering. Därför är även window.open-nedladdningar säkra.
  wc.setWindowOpenHandler((details) => {
    const url = details.url || '';
    const from = wc.getURL();
    // Popup-storm: Chrome/Brave tillåter EXAKT ett fönster per klick. Fler window.open inom
    // två sekunder från samma sida är en annonsflod (piratsajter) → allt utom det första dör.
    const st = wc.__popups || (wc.__popups = { t: 0, n: 0 }); const now = Date.now();
    st.n = (now - st.t < 2000) ? st.n + 1 : 1; st.t = now;
    if (st.n > 1) return { action: 'deny' };
    if (adblockOn && (!/^https?:/i.test(url) || isBlockedTarget(url, from))) {
      return { action: 'deny' };                                  // annons/pop-under/skräp-schema → död
    }
    // Äkta popup (t.ex. "Logga in med Google"/OAuth) öppnas med window.open + fönster-features och
    // måste vara ett RIKTIGT fönster med window.opener + delad session. Men det får BARA gälla
    // samma sajt eller kända inloggnings-/betaltjänster – allt annat är popunder-mönstret från
    // annonssajter (popunder) och dödas helt.
    if (details.disposition === 'new-window' || (details.features && details.features.length)) {
      if (sameSite(url, from) || popupTrustedHost(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, resizable: true, autoHideMenuBar: true } };
      }
      // Korsdomän-fönster från en okänd sajt = popunder. Dör helt – blir inte ens en flik.
      // (Vanliga länkar med target=_blank har inga fönster-features och blir flik som vanligt.)
      return { action: 'deny' };
    }
    // Popunder-vakt: en ny flik till en ANNAN sajt får bara öppnas om användarens senaste klick
    // satt på en riktig länk dit (target=_blank, mitten-/Ctrl-klick). Piratsajternas trick –
    // klick var som helst → a.click()/window.open mot en annonsdomän – stoppas här.
    if (url && !sameSite(url, from) && !popupTrustedHost(url)) {
      const lc = wc.__lastClick; const viaLink = !!(lc && Date.now() - lc.t < 3000 && lc.href && sameSite(lc.href, url));
      if (!viaLink) return { action: 'deny' };
    }
    if (url) sendTo(ctx, 'open-new-tab', url);                     // vanlig ny flik (Ctrl/mitten-klick, target=_blank)
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    // Ad/tracker-mål → blockera helt.
    if (adblockOn && isBlockedTarget(url, wc.getURL())) { e.preventDefault(); return; }
    // Samma origin (formulär-POST, 2FA-kod, fler-stegs-inloggning) → låt navigeringen ske NATIVT så POST-datan
    // bevaras. preventDefault + omladdning via loadURL blir en GET → koden/formuläret tappas (GitHub-2FA-buggen).
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === new URL(wc.getURL()).origin; } catch {}
    if (sameOrigin) return;
    // Korsdomän-länkklick → scanna först via guardedNavigate (som förut).
    e.preventDefault();
    sendTo(ctx, 'link-navigate', tabId, url);
  });
  wc.on('will-redirect', (e, url) => {
    if (adblockOn && isBlockedTarget(url, wc.getURL())) { try { e.preventDefault(); } catch {} }
  });
  wc.on('did-navigate', (_e, url) => sendTo(ctx, 'did-navigate', tabId, url, canGo(wc, -1), canGo(wc, 1)));
  wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) sendTo(ctx, 'did-navigate', tabId, url, canGo(wc, -1), canGo(wc, 1)); });
  wc.on('page-title-updated', (_e, title) => sendTo(ctx, 'title', tabId, title));
  wc.on('page-favicon-updated', (_e, favs) => sendTo(ctx, 'favicon', tabId, (favs || [])[0] || null));
  wc.on('did-start-loading', () => sendTo(ctx, 'loading', tabId, true));
  wc.on('did-stop-loading', () => sendTo(ctx, 'loading', tabId, false));
  wc.on('dom-ready', () => { try { if (ctx.defaultZoom !== 1) wc.setZoomFactor(ctx.defaultZoom); } catch {} });
  // Video/element går i helskärm (sidans egen fullscreen-knapp) → täck HELA skärmen
  wc.on('enter-html-full-screen', () => { ctx._wasFull = ctx.win.isFullScreen(); ctx.htmlFull = true; setFull(ctx, true); applyBounds(ctx); });
  wc.on('leave-html-full-screen', () => {
    // Ofrivilligt = fönstret har just tappat fokus (klick på en annan skärm).
    // Då bad ingen om att lämna: sätt tillbaka fönstrets helskärm och be sidan
    // gå in i sin igen. Esc eller sidans egen knapp sker med fokus kvar.
    const involuntary = ctx.htmlFull && (!ctx.win.isFocused() || Date.now() - (ctx._blurAt || 0) < 1500);
    if (involuntary) {
      setFull(ctx, true);
      setTimeout(() => {
        try { wc.executeJavaScriptInIsolatedWorld(999, [{ code: 'window.__vakaRefull && window.__vakaRefull()' }], true); } catch {}
        // Gick sidan inte tillbaka i helskärm (ingen gest godkänd) får fönstret
        // inte stå kvar utan flikrad. Då gäller vanlig exit.
        setTimeout(async () => {
          let inFs = false;
          try { inFs = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: '!!document.fullscreenElement' }]); } catch {}
          if (!inFs) { ctx.htmlFull = false; setFull(ctx, ctx._wasFull); applyBounds(ctx); }
        }, 600);
      }, 120);
      return;
    }
    ctx.htmlFull = false; setFull(ctx, ctx._wasFull); applyBounds(ctx);
  });
  wc.on('context-menu', (_e, params) => { try { buildContextMenu(ctx, wc, params); } catch {} });
  wc.on('did-finish-load', async () => {
    try {
      const url = wc.getURL();
      if (!/^https?:/i.test(url)) return;
      const feats = await wc.executeJavaScript(EXTRACT_JS).catch(() => null);
      const res = analyzeContent(feats);
      if (res) sendTo(ctx, 'content-warning', tabId, url, res);
    } catch {}
  });
  ctx.views.set(tabId, view);
  if (ctx.netOpen) attachNet(ctx, wc);   // fånga trafik direkt om inspektören är öppen
  raiseKrypto(ctx);
  return view;
}

/* ────────── IPC – globala tjänster (fönsteroberoende) ────────── */
ipcMain.handle('skoll:check-url', (_e, url) => checkUrl(url));
ipcMain.handle('skoll:daily-image', () => dailyImage());
ipcMain.handle('skoll:adblock-toggle', async (_e, on) => {
  adblockOn = !!on;
  await loadEngine();
  for (const s of blockedSessions) {
    try { adblockOn ? enableEngineOn(s) : disableEngineOn(s); } catch {}
  }
  return adblockOn;
});
ipcMain.handle('skoll:adblock-state', () => ({ on: adblockOn, count: adblockCount }));
/* Vaka mejl-inloggning: proxar till backend (send-code/verify-code/session/logout). */
async function vakaAuthCall(pathname, body) {
  try {
    const r = await fetch(SKOLL + '/api/sakerkoll/vaka/auth/' + pathname, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) j.error = 'http_' + r.status;
    return j;
  } catch (e) { return { ok: false, error: 'unreachable', message: 'Kunde inte nå servern. Kontrollera din uppkoppling.' }; }
}
ipcMain.handle('auth:login', (_e, d) => vakaAuthCall('login', { email: d && d.email, password: d && d.password }));
ipcMain.handle('auth:signup', (_e, d) => vakaAuthCall('signup', { email: d && d.email, password: d && d.password, name: d && d.name }));
ipcMain.handle('auth:verify-code', (_e, d) => vakaAuthCall('verify-code', { email: d && d.email, code: d && d.code }));
ipcMain.handle('auth:reset-request', (_e, d) => vakaAuthCall('reset-request', { email: d && d.email }));
ipcMain.handle('auth:reset-confirm', (_e, d) => vakaAuthCall('reset-confirm', { email: d && d.email, code: d && d.code, password: d && d.password }));
ipcMain.handle('auth:session', (_e, d) => vakaAuthCall('session', { token: d && d.token }));
ipcMain.handle('auth:logout', (_e, d) => vakaAuthCall('logout', { token: d && d.token }));
ipcMain.handle('auth:delete', (_e, d) => vakaAuthCall('delete', { token: d && d.token }));
/* Session speglas krypterat i OS-nyckelringen (safeStorage) så inloggningen överlever
 * även om skalets localStorage skulle tömmas. Bara token+profil, aldrig lösenord. */
const SESSION_FILE = path.join(app.getPath('userData'), 'vaka-session.dat');
ipcMain.handle('auth:remember', (_e, acc) => {
  try {
    if (!acc || !acc.token) return { ok: false };
    const str = JSON.stringify(acc);
    const out = (safeStorage && safeStorage.isEncryptionAvailable()) ? safeStorage.encryptString(str) : Buffer.from(str, 'utf8');
    fs.writeFileSync(SESSION_FILE, out, { mode: 0o600 });
    return { ok: true };
  } catch { return { ok: false }; }
});
ipcMain.handle('auth:recall', () => {
  try {
    if (!fs.existsSync(SESSION_FILE)) return { ok: false };
    const blob = fs.readFileSync(SESSION_FILE);
    let str; try { str = (safeStorage && safeStorage.isEncryptionAvailable()) ? safeStorage.decryptString(blob) : blob.toString('utf8'); }
    catch { str = blob.toString('utf8'); }
    const acc = JSON.parse(str);
    return (acc && acc.token) ? { ok: true, account: acc } : { ok: false };
  } catch { return { ok: false }; }
});
ipcMain.handle('auth:forget', () => { try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {} return { ok: true }; });
/* Vaka Familj: förälder skapar barnkonto (kod), barn loggar in med kod, blocklist-synk. */
async function familyCall(pathname, body) {
  try {
    const r = await fetch(SKOLL + '/api/sakerkoll/family/' + pathname, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) j.error = 'http_' + r.status;
    return j;
  } catch (e) { return { ok: false, error: 'unreachable', message: 'Kunde inte nå servern. Kontrollera din uppkoppling.' }; }
}
ipcMain.handle('family:child', (_e, d) => familyCall('child', { token: d && d.token, name: d && d.name, age: d && d.age }));
ipcMain.handle('family:join', (_e, d) => familyCall('join', { code: d && d.code }));
ipcMain.handle('family:children', (_e, d) => familyCall('children', { token: d && d.token }));
ipcMain.handle('family:blocklist', (_e, d) => familyCall('blocklist', { token: d && d.token, child_id: d && d.child_id, blocklist: d && d.blocklist }));
ipcMain.handle('family:me', (_e, d) => familyCall('me', { token: d && d.token }));
ipcMain.handle('family:allow', (_e, d) => familyCall('allow', { token: d && d.token, child_id: d && d.child_id, host: d && d.host, minutes: d && d.minutes }));
ipcMain.handle('family:history-add', (_e, d) => familyCall('history/add', { token: d && d.token, url: d && d.url, title: d && d.title }));
ipcMain.handle('family:history', (_e, d) => familyCall('history', { token: d && d.token, child_id: d && d.child_id }));
ipcMain.handle('family:logout-child', (_e, d) => familyCall('logout-child', { token: d && d.token, child_id: d && d.child_id }));
ipcMain.handle('family:rotate-code', (_e, d) => familyCall('rotate-code', { token: d && d.token, child_id: d && d.child_id }));
ipcMain.handle('family:sessions', (_e, d) => familyCall('sessions', { token: d && d.token, child_id: d && d.child_id }));
ipcMain.handle('family:logout-session', (_e, d) => familyCall('logout-session', { token: d && d.token, child_id: d && d.child_id, sid: d && d.sid }));
/* Vaka Socialt: profil (användarnamn+bild), vänner, chatt. */
async function socialCall(pathname, body) {
  try {
    const r = await fetch(SKOLL + '/api/sakerkoll/social/' + pathname, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) j.error = 'http_' + r.status;
    return j;
  } catch (e) { return { ok: false, error: 'unreachable', message: 'Kunde inte nå servern.' }; }
}
ipcMain.handle('social:me', (_e, d) => socialCall('me', { token: d && d.token }));
ipcMain.handle('social:profile', (_e, d) => socialCall('profile', { token: d && d.token, username: d && d.username, avatar: d && d.avatar }));
ipcMain.handle('social:friend-request', (_e, d) => socialCall('friend/request', { token: d && d.token, username: d && d.username }));
ipcMain.handle('social:friend-respond', (_e, d) => socialCall('friend/respond', { token: d && d.token, username: d && d.username, accept: d && d.accept }));
ipcMain.handle('social:friends', (_e, d) => socialCall('friends', { token: d && d.token }));
ipcMain.handle('social:messages', (_e, d) => socialCall('messages', { token: d && d.token, chat: d && d.chat, since: d && d.since }));
ipcMain.handle('social:send', (_e, d) => socialCall('send', { token: d && d.token, chat: d && d.chat, body: d && d.body }));
ipcMain.handle('social:edit', (_e, d) => socialCall('edit', { token: d && d.token, id: d && d.id, body: d && d.body }));
ipcMain.handle('social:chatavatar', (_e, d) => socialCall('chatavatar', { token: d && d.token, chat: d && d.chat, avatar: d && d.avatar }));

/* ── Lösenord — PER KONTO, låsta när man är utloggad ── */
const PW_FILE = path.join(app.getPath('userData'), 'skoll-passwords.json');   // legacy (migreras in i kontot vid första inlogg)
const PW_DIR = path.join(app.getPath('userData'), 'passwords');
let currentAcctKey = null;                                                    // vilket Vaka-konto som är inloggat (kaka-valv + lösenord)
function keyHash(k) { return crypto.createHash('sha1').update(String(k || '')).digest('hex'); }
function pwFileFor(key) { return path.join(PW_DIR, 'pw-' + keyHash(key) + '.json'); }
function loadPw() {
  if (!currentAcctKey) return [];                                             // utloggad → lösenord låsta
  let buf; try { buf = fs.readFileSync(pwFileFor(currentAcctKey)); } catch { return []; }
  try { return JSON.parse(walletDecrypt(buf)); } catch {}                     // E2E-krypterat valv (nytt format)
  try { const l = JSON.parse(buf.toString('utf8')); savePwList(l); return l; } catch {}  // legacy klartext → migrera till krypterat direkt
  return [];
}
function savePwList(l) {
  if (!currentAcctKey) return;
  // E2E-krypterat på enheten (AES-256-GCM med samma nyckelrings-nyckel som plånboken)
  try { fs.mkdirSync(PW_DIR, { recursive: true }); fs.writeFileSync(pwFileFor(currentAcctKey), walletEncrypt(JSON.stringify(l)), { mode: 0o600 }); } catch {}
}
ipcMain.handle('pw:list', () => loadPw());
ipcMain.handle('pw:get', (_e, origin) => loadPw().find((p) => p.origin === origin) || null);
ipcMain.handle('pw:save', (_e, c) => {
  const l = loadPw();
  const i = l.findIndex((p) => p.origin === c.origin && p.username === c.username);
  const rec = { id: c.id || ('p' + Date.now() + Math.floor(Math.random() * 1000)), origin: c.origin, username: c.username || '', password: c.password || '', autofill: c.autofill !== false };
  if (i >= 0) l[i] = { ...l[i], ...rec }; else l.unshift(rec);
  savePwList(l); return { ok: true };
});
ipcMain.handle('pw:set-autofill', (_e, o) => {
  o = o || {}; const l = loadPw();
  const p = l.find((x) => x.origin === o.origin && (o.username == null || x.username === o.username));
  if (p) { p.autofill = !!o.on; savePwList(l); }
  return { ok: true };
});
ipcMain.handle('pw:delete', (_e, id) => { savePwList(loadPw().filter((p) => p.id !== id)); return { ok: true }; });
ipcMain.on('pw:capture', (e, c) => {
  if (!currentAcctKey) return;             // utloggad → spara/erbjud inte lösenord
  if (!c || !c.password) return;
  const l = loadPw();
  if (l.find((p) => p.origin === c.origin && p.username === c.username && p.password === c.password)) return;
  sendTo(e.sender.__ctx, 'pw-offer', c);   // erbjud i fönstret där sidan ligger
});

/* ── Kaka-valv per konto: logga ut → spara+rensa webbsession; logga in → återställ (samma tjänster tillbaka) ── */
const COOKIE_DIR = path.join(app.getPath('userData'), 'session-cookies');
function cookieFileFor(key) { return path.join(COOKIE_DIR, 'ck-' + keyHash(key) + '.json'); }
async function saveAccountCookies(key) {
  if (!key) return;
  try {
    const cookies = await session.defaultSession.cookies.get({});
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
    fs.writeFileSync(cookieFileFor(key), JSON.stringify(cookies), { mode: 0o600 });
  } catch {}
}
async function restoreAccountCookies(key) {
  if (!key) return;
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(cookieFileFor(key), 'utf8')); } catch { return; }
  for (const c of arr) {
    try {
      const host = (c.domain || '').replace(/^\./, '');
      if (!host || !c.name) continue;
      const set = { url: 'https://' + host + (c.path || '/')/* alltid https: Google m.fl. sätter alla sina cookies över https; http:// skulle binda dem till fel source-scheme (schemeful same-site) och bryta inloggningen */, name: c.name, value: c.value, path: c.path || '/' };
      // __Host-/__Secure-prefix + host-only cookies (t.ex. Googles __Host-GAPS) FÖRKASTAS av Chromium om de får ett Domain-attribut → sätt domain BARA för äkta domän-cookies.
      const isHostOnly = c.hostOnly || /^__Host-/i.test(c.name);
      if (c.domain && !isHostOnly) set.domain = c.domain;
      if (c.secure) set.secure = true;
      if (c.httpOnly) set.httpOnly = true;
      if (typeof c.expirationDate === 'number') set.expirationDate = c.expirationDate;
      if (c.sameSite) set.sameSite = c.sameSite;
      await session.defaultSession.cookies.set(set);
    } catch {}
  }
}
// Rensar BARA webb-cookies (Google m.fl.) — ALDRIG localStorage, där skalets Vaka-inloggning bor.
async function clearWebSession() { try { await session.defaultSession.clearStorageData({ storages: ['cookies'] }); } catch {} }

// Engångsstädning (0.3.50): versioner <=0.3.48 kunde binda Googles icke-Secure auth-cookies
// (SID/HSID/APISID) till fel source-scheme (http/port 80) vid konto-aterstallning -> Google
// visade "problem med dina cookie-installningar". Rensa Google-cookies EN gang sa de satts
// rena vid nasta inloggning. Ror bara google-doman + snapshots, ALDRIG localStorage/Vaka-inlogg.
async function migrateGoogleCookieFix() {
  try {
    const marker = path.join(app.getPath('userData'), 'migr-google-cookies-v1.done');
    if (fs.existsSync(marker)) return;
    const isGoogle = (d) => /(^|\.)google\.[a-z.]{2,}$/i.test(d || '');
    try {
      const all = await session.defaultSession.cookies.get({});
      for (const c of all) {
        if (!isGoogle(c.domain)) continue;
        const host = (c.domain || '').replace(/^\./, '');
        try { await session.defaultSession.cookies.remove('https://' + host + (c.path || '/'), c.name); } catch {}
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(COOKIE_DIR)) {
        if (!f.startsWith('ck-')) continue;
        const p = path.join(COOKIE_DIR, f);
        try { const arr = JSON.parse(fs.readFileSync(p, 'utf8')); fs.writeFileSync(p, JSON.stringify(arr.filter((c) => !isGoogle(c.domain)))); } catch {}
      }
    } catch {}
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
  } catch {}
}

function reloadVisible(ctx) { try { if (ctx && ctx.visibleTab && ctx.views.has(ctx.visibleTab)) ctx.views.get(ctx.visibleTab).webContents.reload(); } catch {} }
function migratePwLegacy(key) {   // första inloggningen: flytta ev. gamla (icke-konto) lösenord in i kontot
  try { if (!fs.existsSync(pwFileFor(key)) && fs.existsSync(PW_FILE)) { fs.mkdirSync(PW_DIR, { recursive: true }); fs.copyFileSync(PW_FILE, pwFileFor(key)); } } catch {}
}
// Sätt inloggat konto UTAN att röra webbsessionen (vid uppstart — sessionen ligger redan kvar på disk)
// Uppstart: sätt kontonyckel utan att röra webbsessionen (cookies ligger redan på disk för rätt konto).
ipcMain.handle('session:setkey', (_e, d) => { currentAcctKey = (d && d.key) || null; if (currentAcctKey) migratePwLegacy(currentAcctKey); return { ok: true }; });
// Inloggning / kontobyte: spara ev. UTGÅENDE kontots cookies, rensa webbsessionen, återställ det NYA kontots cookies.
// → varje konto (förälder/barn) får sina EGNA webb-cookies, isolerade från varandra.
ipcMain.handle('session:login', async (_e, d) => {
  const key = d && d.key;
  if (currentAcctKey && currentAcctKey !== key) { try { await saveAccountCookies(currentAcctKey); } catch {} }
  currentAcctKey = key || null;
  if (key) {
    migratePwLegacy(key);
    try { await clearWebSession(); } catch {}          // börja rent
    try { await restoreAccountCookies(key); } catch {} // lägg tillbaka just det här kontots cookies
  }
  return { ok: true };
});
// Utloggning: spara kontots cookies, rensa sedan webbsessionen (utloggad ur Google m.fl. — inget ligger kvar).
ipcMain.handle('session:logout', async (_e, d) => {
  const key = (d && d.key) || currentAcctKey;
  if (key) { try { await saveAccountCookies(key); } catch {} }
  try { await clearWebSession(); } catch {}
  currentAcctKey = null;
  return { ok: true };
});

/* ── Språk för UI som ritas utanför skalet (t.ex. kortväljaren i sidan) ──
 * Skalet laddar sin ordlista via i18n:load – vi snappar upp språket där och
 * kan sedan översätta enstaka strängar här i huvudprocessen. Svenska = nyckeln. */
let uiLang = 'sv';
const _dicts = new Map();
/* Översätter en sträng i huvudprocessen till skalets språk. Svenska = nyckeln. */
function T(sv) { const d = localeDict(uiLang); const v = d && d[sv]; return v == null ? sv : v; }
function localeDict(code) {
  if (!code || code === 'sv') return {};
  if (_dicts.has(code)) return _dicts.get(code);
  let d = {};
  try { d = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui', 'locales', code + '.json'), 'utf8')); } catch {}
  _dicts.set(code, d);
  return d;
}
function trUi(sv) { const v = localeDict(uiLang)[sv]; return v == null ? sv : v; }

/* ── Vaka Wallet (kort-plånbok, E2E-krypterad på enheten) ──
 * Zero-knowledge: korten lämnar ALDRIG datorn. På disk ligger bara chiffertext
 * (AES-256-GCM). Nyckeln är slumpad per enhet och slås själv in i OS:ets
 * nyckelring via Electrons safeStorage (Keychain/libsecret/DPAPI) – finns ingen
 * nyckelring hamnar den i en chmod 600-fil. Vi (företaget) kan alltså inte läsa
 * korten, och inget kort-nummer syns i klartext på disk. */
const WALLET_FILE = path.join(app.getPath('userData'), 'vaka-wallet.dat');
const WALLET_KEY_FILE = path.join(app.getPath('userData'), 'vaka-wallet.key');
let _walletKey = null;
function walletKey() {
  if (_walletKey) return _walletKey;
  let raw = null;
  try {
    if (fs.existsSync(WALLET_KEY_FILE)) {
      const blob = fs.readFileSync(WALLET_KEY_FILE);
      let b64;
      try { b64 = (safeStorage && safeStorage.isEncryptionAvailable()) ? safeStorage.decryptString(blob) : blob.toString('utf8'); }
      catch { b64 = blob.toString('utf8'); }
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 32) raw = buf;
    }
  } catch {}
  if (!raw) {
    raw = crypto.randomBytes(32);
    const b64 = raw.toString('base64');
    try {
      const out = (safeStorage && safeStorage.isEncryptionAvailable()) ? safeStorage.encryptString(b64) : Buffer.from(b64, 'utf8');
      fs.writeFileSync(WALLET_KEY_FILE, out, { mode: 0o600 });
    } catch {}
  }
  _walletKey = raw;
  return raw;
}
function walletEncrypt(str) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', walletKey(), iv);
  const enc = Buffer.concat([c.update(str, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function walletDecrypt(buf) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', walletKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
function loadCards() { try { return JSON.parse(walletDecrypt(fs.readFileSync(WALLET_FILE))); } catch { return []; } }
function saveCards(l) { try { fs.writeFileSync(WALLET_FILE, walletEncrypt(JSON.stringify(l)), { mode: 0o600 }); } catch {} }
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function cardBrand(num) {
  const n = digits(num);
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'Amex';
  if (/^6(011|5)/.test(n)) return 'Discover';
  return 'Kort';
}
/* Publik vy (för listan) – ALDRIG fullt nummer/CVC. */
function cardPublic(c) { return { id: c.id, brand: c.brand || cardBrand(c.number), holder: c.holder || '', last4: digits(c.number).slice(-4), exp: c.exp || '', nick: c.nick || '' }; }
function normCard(c, id) {
  const num = digits(c.number);
  return { id: id || c.id || ('c' + Date.now() + Math.floor(Math.random() * 1000)), holder: (c.holder || '').trim(), number: num, exp: (c.exp || '').trim(), cvc: digits(c.cvc), nick: (c.nick || '').trim(), brand: cardBrand(num) };
}
ipcMain.handle('wallet:list', () => loadCards().map(cardPublic));
ipcMain.handle('wallet:get', (_e, id) => loadCards().find((c) => c.id === id) || null); // fullt kort – för redigering/autofyll
ipcMain.handle('wallet:save', (_e, c) => {
  const l = loadCards();
  if (c.id) { const i = l.findIndex((x) => x.id === c.id); if (i >= 0) { l[i] = normCard(c, c.id); saveCards(l); return { ok: true, id: c.id }; } }
  const rec = normCard(c);
  const dup = l.findIndex((x) => digits(x.number).slice(-4) === digits(rec.number).slice(-4) && x.exp === rec.exp);
  if (dup >= 0) l[dup] = normCard(c, l[dup].id); else l.unshift(rec);
  saveCards(l); return { ok: true, id: rec.id };
});
ipcMain.handle('wallet:delete', (_e, id) => { saveCards(loadCards().filter((c) => c.id !== id)); return { ok: true }; });
/* Kortväljaren i sidan frågar efter listan (publik vy) + översatta etiketter.
 * Sidans preload har ingen tillgång till skalets språkval, så vi översätter här. */
ipcMain.handle('wallet:menu', () => ({
  cards: loadCards().map(cardPublic),
  labels: { choose: trUi('Välj kort'), manage: trUi('Hantera kort'), exp: trUi('Giltigt till') },
}));
/* Felsökningslogg från kortväljaren (bara när VAKA_WALLET_DEBUG=1 satts). */
ipcMain.on('wallet:debug', (_e, d) => {
  try {
    if (!process.env.VAKA_WALLET_DEBUG) return;
    fs.appendFileSync(path.join(app.getPath('userData'), 'wallet-debug.log'),
      new Date().toISOString() + ' ' + JSON.stringify(d) + '\n');
  } catch {}
});
/* "Hantera kort" i väljaren → öppna Wallet i inställningarna. */
ipcMain.on('wallet:open-manager', (e) => {
  try { const ctx = e.sender.__ctx || ctxFor(e); if (ctx) sendTo(ctx, 'open-settings', 'wallet'); } catch {}
});
/* Sida upptäckte ett kassaformulär → erbjud autofyll (om vi har kort). */
ipcMain.on('wallet:field-detected', (e) => {
  try { if (!loadCards().length) return; const ctx = e.sender.__ctx; if (!ctx) return; ctx._walletFillWc = e.sender; sendTo(ctx, 'wallet-fill-offer', loadCards().map(cardPublic)); } catch {}
});
/* Skalet bad om att fylla i ett visst kort → skicka fullt kort till just den sidan. */
ipcMain.on('wallet:fill-now', (e, id) => {
  try { const ctx = ctxFor(e); if (!ctx || !ctx._walletFillWc || ctx._walletFillWc.isDestroyed()) return; const card = loadCards().find((c) => c.id === id) || loadCards()[0]; if (card) ctx._walletFillWc.send('wallet-do-fill', card); } catch {}
});
/* Sida fångade ett nytt kort i en kassa → erbjud att spara. */
ipcMain.on('wallet:capture', (e, c) => {
  try {
    if (!c || digits(c.number).length < 12) return;
    const num = digits(c.number);
    if (loadCards().some((x) => digits(x.number) === num)) return; // har redan kortet
    sendTo(e.sender.__ctx, 'wallet-offer', { holder: c.holder || '', number: num, exp: c.exp || '', cvc: digits(c.cvc), brand: cardBrand(num), last4: num.slice(-4) });
  } catch {}
});

/* ── Nedladdningar + nedladdningsskydd ──
 * Två lager, precis som Chrome/Brave (fast vårt eget):
 *   1) Moln-hash-rykte — vi räknar filens SHA-256 lokalt och skickar BARA hashen
 *      till vårt Säkerkoll-moln (aldrig själva filen). Molnet slår den mot vår
 *      hotdatabas (1M+ kända skadliga filer, à la Google Safe Browsing) och svarar
 *      farlig/ren. Funkar för alla användare utan lokal antivirus.
 *   2) Lokal ClamAV — extra signaturlager om det råkar finnas installerat.
 * Vid träff i något lager: flytta filen till karantän + varna ("Behåll ändå" finns). */
const CLAMSCAN = ['/usr/bin/clamscan', '/usr/local/bin/clamscan'].find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
const QUARANTINE = path.join(app.getPath('userData'), 'quarantine');
try { fs.mkdirSync(QUARANTINE, { recursive: true }); } catch {}
const downloads = [];
const dlItems = new Map();   // id → DownloadItem (för paus/fortsätt/avbryt medan den pågår)
/* Fingeravtryck (SHA-256) av en färdig fil — det enda som skickas till molnet. */
function sha256File(file) {
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(file);
      s.on('data', (d) => h.update(d));
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}
/* Fråga vårt moln-nedladdningsskydd om filens hash är känd skadlig. */
async function cloudDownloadCheck(rec) {
  const hash = await sha256File(rec.path);
  if (!hash) return null;
  rec.sha256 = hash;
  try {
    const r = await fetch(SKOLL + '/api/sakerkoll/download-check', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sha256: hash, filename: rec.filename, size: rec.total, url: rec.url }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.verdict === 'dangerous') return { threat: j.threat || 'Känd skadlig fil' };
    if (j && j.ok) return { clean: true };
  } catch {}
  return null; // nådde inte molnet → obekräftat
}
/* Lokal ClamAV som extra lager (om installerat). Löser {threat} eller null. */
function clamScanFile(file) {
  return new Promise((resolve) => {
    if (!CLAMSCAN) return resolve(null);
    let out = ''; let p;
    try { p = spawn(CLAMSCAN, ['--no-summary', '--stdout', file]); }
    catch { return resolve(null); }
    if (p.stdout) p.stdout.on('data', (d) => { out += d; });
    if (p.stderr) p.stderr.on('data', () => {});
    p.on('error', () => resolve(null));
    p.on('exit', (code) => {
      if (code === 1) { const m = out.match(/:\s*(.+?)\s+FOUND/); resolve({ threat: (m && m[1]) || 'Okänt hot' }); }
      else resolve(null); // 0 = ren, 2 = fel
    });
  });
}
/* Flytta en farlig fil till karantän och varna renderaren. */
function quarantineThreat(rec, threat) {
  rec.threat = threat;
  let q = path.join(QUARANTINE, rec.id + '__' + rec.filename);
  try { fs.renameSync(rec.path, q); } catch { try { fs.copyFileSync(rec.path, q); fs.unlinkSync(rec.path); } catch { q = null; } }
  rec.quarantine = q; rec.state = 'infected'; rec.scan = 'infected';
  broadcast('download-update', rec);
  broadcast('download-threat', { id: rec.id, filename: rec.filename, threat: rec.threat });
}
/* Skyddar en färdig nedladdning: moln-hash-rykte först, sen lokal ClamAV. */
async function scanDownload(rec) {
  if (!rec.path) { rec.state = 'completed'; rec.scan = 'unscanned'; broadcast('download-update', rec); return; }
  rec.state = 'scanning'; rec.scan = 'scanning'; broadcast('download-update', rec);
  const cloud = await cloudDownloadCheck(rec);          // 1) moln-hash-rykte
  if (cloud && cloud.threat) { quarantineThreat(rec, cloud.threat); return; }
  const local = await clamScanFile(rec.path);           // 2) lokal ClamAV (om finns)
  if (local && local.threat) { quarantineThreat(rec, local.threat); return; }
  rec.state = 'completed';
  rec.scan = ((cloud && cloud.clean) || CLAMSCAN) ? 'clean' : 'unscanned';
  broadcast('download-update', rec);
}
function trackDownloads(sess) {
  sess.on('will-download', (_e, item) => {
    const id = 'd' + Date.now() + Math.floor(Math.random() * 1000);
    const savePath = path.join(app.getPath('downloads'), item.getFilename());
    try { item.setSavePath(savePath); } catch {}
    dlItems.set(id, item);
    const rec = { id, filename: item.getFilename(), url: item.getURL(), path: savePath, total: item.getTotalBytes(), received: 0, state: 'progressing', scan: null };
    downloads.unshift(rec);
    broadcast('download-update', rec);
    try { const fw = BrowserWindow.getFocusedWindow(); let c = fw ? wins.get(fw.webContents.id) : null; if (!c) c = wins.values().next().value; if (c) openDlPopup(c); } catch {}
    item.on('updated', (_e2, state) => { rec.received = item.getReceivedBytes(); rec.total = item.getTotalBytes() || rec.total; rec.state = item.isPaused() ? 'paused' : state; broadcast('download-update', rec); });
    item.once('done', (_e2, state) => {
      dlItems.delete(id);
      rec.received = item.getReceivedBytes();
      if (state === 'completed') scanDownload(rec);
      else { rec.state = state; broadcast('download-update', rec); }
    });
  });
}
ipcMain.handle('dl:list', () => downloads);
/* Paus / fortsätt / avbryt en pågående nedladdning (knappar i popupen och i Inställningar › Nedladdningar). */
ipcMain.on('dl:pause', (_e, id) => { const it = dlItems.get(id), r = downloads.find((d) => d.id === id); if (!it || !r) return; try { if (!it.isPaused()) it.pause(); } catch {} r.state = 'paused'; broadcast('download-update', r); });
ipcMain.on('dl:resume', (_e, id) => { const it = dlItems.get(id), r = downloads.find((d) => d.id === id); if (!it || !r) return; try { if (it.canResume()) it.resume(); } catch {} r.state = 'progressing'; broadcast('download-update', r); });
ipcMain.on('dl:cancel', (_e, id) => { const it = dlItems.get(id), r = downloads.find((d) => d.id === id); if (!r) return; try { if (it) it.cancel(); } catch {} dlItems.delete(id); r.state = 'cancelled'; broadcast('download-update', r); });
ipcMain.on('dl:popup-toggle', (e) => { const ctx = wins.get(e.sender.id); if (!ctx) return; if (ctx.dlView) closeDlPopup(ctx); else openDlPopup(ctx); });
ipcMain.on('dl:popup-close', (e) => { const ctx = [...wins.values()].find((c) => c.dlView && !c.dlView.webContents.isDestroyed() && c.dlView.webContents === e.sender); if (ctx) closeDlPopup(ctx); });
ipcMain.on('dl:popup-size', (e, h) => { const ctx = [...wins.values()].find((c) => c.dlView && !c.dlView.webContents.isDestroyed() && c.dlView.webContents === e.sender); if (ctx && typeof h === 'number') positionDlPopup(ctx, Math.round(h)); });

/* "Spara lösenord"-notisen = flytande kort uppe till höger, som nedladdningsrutan: en
 * WebContentsView OVANPÅ fliken (skalets DOM ligger under sidans native-vy). Tema (ljus/mörk)
 * följer skalet och skickas med som query. */
const PW_W = 372;
function positionPwPopup(ctx, h) {
  if (!ctx || !ctx.pwView || !ctx.win || ctx.win.isDestroyed()) return;
  const cb = ctx.win.getContentBounds();
  if (typeof h === 'number') ctx._pwH = h;
  const top = Math.max(0, Math.round((ctx.topInset || 92) + 6));
  const height = Math.max(60, Math.min(ctx._pwH || 150, cb.height - top - 12));
  try { ctx.pwView.setBounds({ x: Math.round(cb.width - PW_W - 8), y: top, width: PW_W, height }); } catch {}
}
function closePwPopup(ctx) {
  if (!ctx || !ctx.pwView) return;
  try { ctx.win.contentView.removeChildView(ctx.pwView); } catch {}
  try { ctx.pwView.webContents.close(); } catch {}
  if (ctx._pwRepos) { try { ctx.win.removeListener('resize', ctx._pwRepos); ctx.win.removeListener('move', ctx._pwRepos); } catch {} ctx._pwRepos = null; }
  ctx.pwView = null;
}
function openPwPopup(ctx, cred, theme) {
  if (!ctx || !ctx.win || ctx.win.isDestroyed() || !cred) return;
  closePwPopup(ctx);                                   // ny fråga ersätter en ev. gammal
  const view = new WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false, transparent: true } });   // transparent: bara kortet syns, inte vyns rektangel
  try { view.setBackgroundColor('#00000000'); } catch {}
  ctx.pwView = view; ctx._pwH = 150;
  ctx.win.contentView.addChildView(view);
  positionPwPopup(ctx);
  const repos = () => positionPwPopup(ctx);
  ctx._pwRepos = repos;
  ctx.win.on('resize', repos); ctx.win.on('move', repos);
  view.webContents.loadFile(path.join(__dirname, 'ui', 'pwpopup.html'), { query: { theme: theme === 'dark' ? 'dark' : 'light' } });
  view.webContents.on('did-finish-load', () => { try { view.webContents.send('pw-cred', cred); } catch {} });
}
const pwCtxOf = (e) => [...wins.values()].find((c) => c.pwView && !c.pwView.webContents.isDestroyed() && c.pwView.webContents === e.sender);
ipcMain.on('pw:popup-open', (e, d) => { const ctx = ctxFor(e); if (ctx && d && d.cred) openPwPopup(ctx, d.cred, d.theme); });
ipcMain.on('pw:popup-close', (e) => { const ctx = pwCtxOf(e); if (ctx) closePwPopup(ctx); });
ipcMain.on('pw:popup-size', (e, h) => { const ctx = pwCtxOf(e); if (ctx && typeof h === 'number') positionPwPopup(ctx, h); });
ipcMain.on('dl:open', (_e, id) => { const r = downloads.find((d) => d.id === id); if (r && r.state !== 'infected' && r.state !== 'deleted') shell.openPath(r.path).catch(() => {}); });
ipcMain.on('dl:folder', (_e, id) => { const r = downloads.find((d) => d.id === id); if (r && r.state !== 'infected' && r.state !== 'deleted') shell.showItemInFolder(r.path); });
ipcMain.on('dl:remove-threat', (_e, id) => {
  const r = downloads.find((d) => d.id === id); if (!r) return;
  try { if (r.quarantine) fs.unlinkSync(r.quarantine); } catch {}
  r.quarantine = null; r.state = 'deleted'; r.scan = 'deleted'; broadcast('download-update', r);
});
ipcMain.on('dl:keep-anyway', (_e, id) => {
  const r = downloads.find((d) => d.id === id); if (!r) return;
  try { if (r.quarantine) fs.renameSync(r.quarantine, r.path); } catch { try { if (r.quarantine) { fs.copyFileSync(r.quarantine, r.path); fs.unlinkSync(r.quarantine); } } catch {} }
  r.quarantine = null; r.state = 'completed'; r.scan = 'overridden'; broadcast('download-update', r);
});

/* ────────── IPC – per fönster (routas via event.sender) ────────── */
ipcMain.on('view:load', (e, tabId, url) => { const ctx = ctxFor(e); if (!ctx) return; ctx.discarded.delete(tabId); ensureView(ctx, tabId).webContents.loadURL(url).catch(() => {}); showOnly(ctx, tabId); });
ipcMain.on('view:show', (e, tabId) => { const ctx = ctxFor(e); if (!ctx) return; if (ctx.discarded.has(tabId)) rehydrate(ctx, tabId); showOnly(ctx, tabId); });
ipcMain.on('view:hide', (e) => { const ctx = ctxFor(e); if (!ctx) return; ctx.views.forEach((v) => v.setVisible(false)); ctx.visibleTab = null; });
ipcMain.on('view:bounds', (e, r) => { const ctx = ctxFor(e); if (ctx) { ctx.bounds = r; applyBounds(ctx); } });
ipcMain.on('view:inset-top', (e, px) => { const ctx = ctxFor(e); if (ctx) { ctx.topInset = Math.max(0, px | 0); applyBounds(ctx); } });
ipcMain.on('view:inset-left', (e, px) => { const ctx = ctxFor(e); if (ctx) { ctx.leftInset = Math.max(0, px | 0); applyBounds(ctx); } });
ipcMain.on('view:incognito', (e, id) => { const ctx = ctxFor(e); if (ctx) ctx.incognitoTabs.add(id); });
ipcMain.on('view:default-zoom', (e, f) => { const ctx = ctxFor(e); if (!ctx) return; ctx.defaultZoom = f; ctx.views.forEach((v) => { try { v.webContents.setZoomFactor(f); } catch {} }); });
ipcMain.on('view:zoom', (e, id, dir) => {
  const ctx = ctxFor(e); if (!ctx) return;
  const v = ctx.views.get(id); if (!v) return;
  const wc = v.webContents;
  const z = dir === 0 ? 1 : Math.min(3, Math.max(0.4, wc.getZoomFactor() + dir * 0.1));
  wc.setZoomFactor(z);
});
ipcMain.on('view:print', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) printPage(ctx, v.webContents); });
ipcMain.on('view:back', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) try { v.webContents.navigationHistory.goBack(); } catch { v.webContents.goBack(); } });
ipcMain.on('view:forward', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) try { v.webContents.navigationHistory.goForward(); } catch { v.webContents.goForward(); } });
ipcMain.on('view:reload', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) v.webContents.reload(); });
ipcMain.on('view:stop', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) v.webContents.stop(); });
ipcMain.on('view:destroy', (e, id) => {
  const ctx = ctxFor(e); if (!ctx) return;
  const v = ctx.views.get(id);
  if (v) { try { ctx.win.contentView.removeChildView(v); } catch {} try { v.webContents.close(); } catch {} ctx.views.delete(id); }
  ctx.incognitoTabs.delete(id); ctx.discarded.delete(id); ctx.lastActive.delete(id);
  if (ctx.visibleTab === id) ctx.visibleTab = null;
});
ipcMain.on('app:fullscreen', (e) => { const ctx = ctxFor(e); if (ctx) toggleFull(ctx); });
ipcMain.on('app:quit', () => app.quit());
/* ── Sökförslag till adressfältet ──
 * Hämtas här i huvudprocessen (ingen CORS) från den sökmotor användaren valt.
 * Startpage saknar förslags-API → DuckDuckGo, som inte loggar. Svaret är alltid
 * en lista strängar; fel eller timeout ger en tom lista, aldrig ett undantag
 * till skalet. Inkognito frågar aldrig hit (skalet avgör). */
const SUGGEST_URLS = {
  google: (q) => 'https://suggestqueries.google.com/complete/search?client=firefox&hl=sv&q=' + encodeURIComponent(q),
  duckduckgo: (q) => 'https://duckduckgo.com/ac/?type=list&q=' + encodeURIComponent(q),
  vaka: (q) => 'https://vaka-sok.vercel.app/api/suggest?q=' + encodeURIComponent(q),   // inkognito: vår egen, ingen logg
  brave: (q) => 'https://search.brave.com/api/suggest?q=' + encodeURIComponent(q),
  startpage: (q) => 'https://duckduckgo.com/ac/?type=list&q=' + encodeURIComponent(q),
};
ipcMain.handle('omni:suggest', async (_e, arg) => {
  try {
    const q = String((arg && arg.q) || '').trim().slice(0, 200);
    if (!q) return [];
    const mk = SUGGEST_URLS[(arg && arg.engine) || 'google'] || SUGGEST_URLS.google;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1500);
    const res = await net.fetch(mk(q), { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    return list.map((s) => (typeof s === 'string' ? s : (s && s.phrase) || '')).filter(Boolean).slice(0, 6);
  } catch { return []; }
});
ipcMain.on('i18n:load', (e, lang) => {
  try {
    const code = String(lang || '').replace(/[^a-zA-Z-]/g, '');
    e.returnValue = localeDict(code);
    uiLang = code;                        // skalets språkval – används av trUi() för sid-UI (kortväljaren)
  } catch { e.returnValue = {}; }
});
// Skalet färgar om fönsterknapparna (Windows/Linux-overlay) när tema/inkognito byts.
ipcMain.on('page:click', (e, info) => { e.returnValue = 1; try { e.sender.__lastClick = { t: Date.now(), href: info && info.href ? String(info.href) : null }; } catch {} });
ipcMain.on('win:minimize', (e) => { try { BrowserWindow.fromWebContents(e.sender).minimize(); } catch {} });
ipcMain.on('win:toggle-max', (e) => { try { const w = BrowserWindow.fromWebContents(e.sender); if (w.isMaximized()) w.unmaximize(); else w.maximize(); } catch {} });
ipcMain.on('win:close', (e) => { try { BrowserWindow.fromWebContents(e.sender).close(); } catch {} });   // samma väg som systemets kryss (stäng-bekräftelsen sköts som förut)
ipcMain.on('win:titlebar', (e, c) => {
  try { const w = BrowserWindow.fromWebContents(e.sender); if (w && w.setTitleBarOverlay && c) w.setTitleBarOverlay({ color: String(c.color || '#e7edf4'), symbolColor: String(c.symbolColor || '#0e2a47'), height: 44 }); } catch {}
});
ipcMain.on('win:do-close', (e) => {
  const ctx = wins.get(e.sender.id); if (ctx) ctx.forceClose = true;
  const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close();
});
// Öppna den flytande "Stäng alla flikar?"-notisen (eget litet fönster ovanför sidan,
// så inget gråas ut och hela sidan är kvar). Skalet ber om den när flikar > 1.
ipcMain.on('open-close-confirm', (e, count) => {
  const ctx = wins.get(e.sender.id); if (!ctx) return;
  const parent = BrowserWindow.fromWebContents(e.sender); if (!parent) return;
  if (ctx.confirmWin && !ctx.confirmWin.isDestroyed()) { ctx.confirmWin.focus(); return; }
  const cb = parent.getContentBounds();
  const w = 372, h = 210;
  const cx = Math.round(cb.x + cb.width - w - 14), cy = Math.round(cb.y + 92);
  const cw = new BrowserWindow({
    icon: path.join(__dirname, 'build', 'icon.png'),
    parent, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: true, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, show: false, opacity: 0, width: w, height: h,
    x: cx, y: cy,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  ctx.confirmWin = cw;
  cw.loadFile(path.join(__dirname, 'ui', 'confirm.html'), { query: { n: String(count || 0) } });
  // X11/Muffin ignorerar positionen tills fönstret är mappat (annars fastnar det i 0,0 uppe
  // till vänster). Kräver movable:true. Visa dolt, positionera med omförsök och tona in vid
  // stäng-krysset uppe till höger.
  cw.webContents.on('did-finish-load', () => {
    cw.show();
    const place = () => { if (!cw.isDestroyed()) { try { cw.setPosition(cx, cy); } catch {} } };
    place();
    [60, 160, 300].forEach((t) => setTimeout(place, t));
    setTimeout(() => { if (!cw.isDestroyed()) { try { cw.setOpacity(1); } catch {} } }, 300);
  });
  cw.on('closed', () => { if (ctx.confirmWin === cw) ctx.confirmWin = null; });
});
ipcMain.on('close-confirm-done', (e, res) => {
  const cw = BrowserWindow.fromWebContents(e.sender);
  const parent = cw ? cw.getParentWindow() : null;
  if (cw && !cw.isDestroyed()) cw.close();
  if (!parent) return;
  if (res && res.ok) {
    const ctx = wins.get(parent.webContents.id);
    if (res.again) parent.webContents.send('persist-skip-close');
    if (ctx) ctx.forceClose = true;
    parent.close();
  }
});

ipcMain.on('open-app-menu', (e) => {
  const ctx = ctxFor(e); if (!ctx) return;
  const t = [
    { label: T('Ny flik'), accelerator: 'CmdOrCtrl+T', click: () => sendTo(ctx, 'open-new-tab') },
    { label: T('Nytt fönster'), accelerator: 'CmdOrCtrl+N', click: () => createWindow(false) },
    { label: T('Nytt inkognitofönster'), accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow(true) },
    { label: T('Ny inkognitoflik'), click: () => sendTo(ctx, 'new-incognito') },
    { type: 'separator' },
    { label: T('Lösenord och autofyll'), click: () => sendTo(ctx, 'open-passwords') },
    { label: T('Historik'), click: () => sendTo(ctx, 'open-history') },
    { label: T('Bokmärken och listor'), click: () => sendTo(ctx, 'open-bookmarks') },
    { label: T('Nedladdade filer'), click: () => sendTo(ctx, 'open-downloads') },
    { type: 'separator' },
    { label: T('Zooma in'), click: () => sendTo(ctx, 'menu-zoom', 1) },
    { label: T('Zooma ut'), click: () => sendTo(ctx, 'menu-zoom', -1) },
    { label: T('Återställ zoom'), click: () => sendTo(ctx, 'menu-zoom', 0) },
    { label: T('Helskärm'), accelerator: 'F11', click: () => toggleFull(ctx) },
    { label: T('Skriv ut…'), accelerator: 'CmdOrCtrl+P', click: () => sendTo(ctx, 'menu-print') },
    { label: T('Fler verktyg'), submenu: [
      { label: T('Utvecklarverktyg'), accelerator: 'F12', click: () => { const v = ctx.views.get(ctx.visibleTab); if (v) try { v.webContents.openDevTools(); } catch {} } },
      { label: T('Rensa surfdata'), click: () => {
        try { session.defaultSession.clearStorageData(); } catch {}
        try { session.fromPartition('skoll-incognito').clearStorageData(); } catch {}
        sendTo(ctx, 'clear-data');
      } },
    ] },
    { type: 'separator' },
    { label: T('Hjälp & om'), click: () => sendTo(ctx, 'open-settings', 'om') },
    { label: T('Inställningar'), click: () => sendTo(ctx, 'open-settings') },
    { label: T('Avsluta'), accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(t).popup({ window: ctx.win });
});

/* ── Krypto-panel (per fönster) ── */
function loadKrypto(ctx, mode) {
  if (!ctx.kryptoView) return;
  if (ctx.kryptoView._mode === mode) return;   // redan rätt innehåll
  ctx.kryptoView._mode = mode;
  if (mode === 'pro') {
    ctx.kryptoView.webContents.loadFile(path.join(__dirname, 'ui', 'krypto.html')).catch(() => {});
  } else {
    const hash = mode === 'signedout' ? 'signedout' : 'nopro';
    ctx.kryptoView.webContents.loadFile(path.join(__dirname, 'ui', 'krypto-lock.html'), { hash }).catch(() => {});
  }
}
ipcMain.on('krypto:toggle', (e, open, mode, token) => {
  const ctx = ctxFor(e); if (!ctx) return;
  ctx.kryptoOpen = !!open;
  if (token) ctx.vakaToken = token;   // vaka-session-token för Krypto-chattens API-anrop
  if (ctx.kryptoOpen) {
    if (!ctx.kryptoView) {
      ctx.kryptoView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'krypto-preload.js'), contextIsolation: true } });
      ctx.win.contentView.addChildView(ctx.kryptoView);
      const wc = ctx.kryptoView.webContents;
      wc.setWindowOpenHandler(({ url }) => { sendTo(ctx, 'open-new-tab', url); return { action: 'deny' }; });
      // Panelen får ALDRIG navigera till en webbplats – bara våra egna file://-sidor.
      // Allt annat (även säkerkoll.se) öppnas som en ny flik i stället.
      wc.on('will-navigate', (ev, url) => {
        if (url.startsWith('https://krypto.local/')) {
          ev.preventDefault();
          if (url.includes('/checkout')) {          // egen kassa (Stripe Payment Element) i panelen
            const plan = ((url.split('plan=')[1] || 'pro_month').replace(/[^a-z_]/g, '')) || 'pro_month';
            ctx.kryptoView._mode = 'checkout';
            ctx.kryptoView.webContents.loadFile(path.join(__dirname, 'ui', 'checkout.html'), { hash: plan }).catch(() => {});
          }
          else if (url.includes('/back')) { ctx.kryptoView._mode = null; loadKrypto(ctx, ctx.vakaToken ? 'nopro' : 'signedout'); }
          else if (url.includes('login')) sendTo(ctx, 'open-login');
          else if (url.includes('recheck')) sendTo(ctx, 'krypto-recheck');
        } else if (!url.startsWith('file:')) {
          ev.preventDefault(); sendTo(ctx, 'open-new-tab', url);
        }
      });
    }
    ctx.kryptoView.webContents.__ctx = ctx;
    loadKrypto(ctx, mode || 'nopro');
  }
  applyBounds(ctx);
});
// Skicka en färdig fråga (från "Var ska jag börja?"-quizet) in i Krypto-panelen.
ipcMain.on('krypto:prefill', (e, text) => {
  const ctx = ctxFor(e) || e.sender.__ctx; if (!ctx || !ctx.kryptoView) return;
  try { ctx.kryptoView.webContents.send('krypto-prefill', String(text || '')); } catch {}
});
// Krypto helskärm på/av: panelen täcker hela webbytan (enklare att läsa/skriva långa rapporter).
ipcMain.on('krypto:expand', (e, full) => {
  const ctx = ctxFor(e) || e.sender.__ctx; if (!ctx) return;
  ctx.kryptoFull = !!full;
  applyBounds(ctx); raiseKrypto(ctx);
});

/* ────────── Nätverksinspektör (Wireshark-lik, via Chrome DevTools-protokollet) ──────────
 * Kopplar CDP-debuggern till varje fliks webContents och lyssnar på Network-domänen,
 * precis som DevTools Network-fliken. Vi får metod, URL, status, typ, storlek, timing,
 * request-/response-headers, POST-data och (på begäran) response-body. Allt lokalt. */
function netShortHost(u) { try { return new URL(u).host; } catch { return ''; } }
function attachNet(ctx, wc) {
  try {
    if (!wc || wc.isDestroyed() || wc._netAttached) return;
    try { wc.debugger.attach('1.3'); } catch { return; }   // redan attachad (t.ex. DevTools öppen)
    wc._netAttached = true;
    wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 20000000, maxResourceBufferSize: 10000000 }).catch(() => {});
    wc.debugger.on('message', (_e, method, params) => { try { onNetMsg(ctx, wc, method, params); } catch {} });
    wc.debugger.on('detach', () => { wc._netAttached = false; });
    wc.once('destroyed', () => { try { if (wc._netAttached) wc.debugger.detach(); } catch {} });
  } catch {}
}
function onNetMsg(ctx, wc, method, params) {
  const net = ctx.net; if (!net) return;
  if (method === 'Network.requestWillBeSent') {
    const req = params.request || {};
    const r = {
      id: params.requestId, _wc: wc, method: req.method || 'GET', url: req.url || '',
      reqHeaders: req.headers || {}, postData: req.postData || '',
      type: params.type || '', status: 0, mime: '', respHeaders: {}, remoteIP: '', size: 0,
      t0: params.timestamp || 0, t1: 0, done: false, failed: false, errorText: '',
    };
    net.records.set(r.id, r); net.order.push(r.id);
    while (net.order.length > NET_MAX) { const old = net.order.shift(); net.records.delete(old); }
  } else if (method === 'Network.responseReceived') {
    const r = net.records.get(params.requestId); if (!r) return;
    const resp = params.response || {};
    r.status = resp.status || 0; r.mime = resp.mimeType || ''; r.respHeaders = resp.headers || {};
    r.remoteIP = resp.remoteIPAddress || ''; r.type = params.type || r.type;
    sendNetRow(ctx, r);
  } else if (method === 'Network.loadingFinished') {
    const r = net.records.get(params.requestId); if (!r) return;
    r.done = true; r.size = params.encodedDataLength || r.size; r.t1 = params.timestamp || r.t1;
    sendNetRow(ctx, r);
  } else if (method === 'Network.loadingFailed') {
    const r = net.records.get(params.requestId); if (!r) return;
    r.done = true; r.failed = true; r.errorText = params.errorText || ''; r.t1 = params.timestamp || r.t1;
    sendNetRow(ctx, r);
  }
}
function netSummary(r) {
  return { id: r.id, method: r.method, url: r.url, host: netShortHost(r.url), status: r.failed ? 'FAIL' : (r.status || 0), type: r.type || '', mime: r.mime || '', size: r.size || 0, ms: (r.t1 && r.t0) ? Math.round((r.t1 - r.t0) * 1000) : 0, failed: !!r.failed };
}
function sendNetRow(ctx, r) { sendTo(ctx, 'net-row', netSummary(r)); }
ipcMain.on('net:toggle', (e, open) => {
  const ctx = ctxFor(e); if (!ctx) return;
  ctx.netOpen = !!open;
  if (!ctx.net) ctx.net = { records: new Map(), order: [] };
  if (ctx.netOpen) {
    ctx.views.forEach((v) => attachNet(ctx, v.webContents));
    ctx.net.order.forEach((id) => { const r = ctx.net.records.get(id); if (r && (r.status || r.failed)) sendNetRow(ctx, r); });
  }
  applyBounds(ctx);
});
ipcMain.on('net:clear', (e) => { const ctx = ctxFor(e); if (ctx && ctx.net) { ctx.net.records.clear(); ctx.net.order = []; } });
ipcMain.handle('net:detail', async (e, id) => {
  const ctx = ctxFor(e); if (!ctx || !ctx.net) return null;
  const r = ctx.net.records.get(id); if (!r) return null;
  let body = '', base64 = false, bodyErr = '';
  if (!r.failed && r.method !== 'OPTIONS') {
    try { const res = await r._wc.debugger.sendCommand('Network.getResponseBody', { requestId: id }); body = res.body || ''; base64 = !!res.base64Encoded; }
    catch (err) { bodyErr = String((err && err.message) || err || ''); }
  }
  return {
    id, method: r.method, url: r.url, status: r.status, type: r.type, mime: r.mime, remoteIP: r.remoteIP || '',
    reqHeaders: r.reqHeaders || {}, respHeaders: r.respHeaders || {}, postData: r.postData || '',
    body, base64, bodyErr, failed: !!r.failed, errorText: r.errorText || '', size: r.size || 0,
  };
});

/* Krypto-chatt: proxar till Säkerkolls AI-API med fönstrets kontonummer, så
 * kontonumret aldrig behöver ligga i panelen. Samma /ai/chat som webbens assistent. */
const KRYPTO_LOG = path.join(app.getPath('userData'), 'krypto-chat.log');
function klog(o) { try { fs.appendFileSync(KRYPTO_LOG, new Date().toISOString() + ' ' + JSON.stringify(o) + '\n'); } catch {} }
/* Egen kassa: panelen (ui/checkout.html) ber om en betalningsavsikt och bekräftar
 * köpet via oss – token läggs på här, så sidan ser varken token eller nyckel. */
async function vakaBillingCall(e, pathname, body) {
  const ctx = e.sender.__ctx; const token = ctx && ctx.vakaToken;
  if (!token) return { ok: false, error: 'no_session', needLogin: true };
  try {
    const r = await fetch(SKOLL + '/api/sakerkoll/vaka/billing/' + pathname, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(Object.assign({}, body || {}, { token })), signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) j.error = 'http_' + r.status;
    return j;
  } catch { return { ok: false, error: 'unreachable', message: 'Kunde inte nå servern. Kontrollera din uppkoppling.' }; }
}
ipcMain.handle('billing:intent', (e, plan) => vakaBillingCall(e, 'intent', { plan: String(plan || 'pro_month') }));
ipcMain.handle('billing:confirm', (e, d) => vakaBillingCall(e, 'confirm', { subscription: d && d.subscription, payment_intent: d && d.payment_intent }));
ipcMain.handle('krypto:chat', async (e, messages) => {
  const ctx = e.sender.__ctx;
  const token = ctx && ctx.vakaToken;
  if (!token) { klog({ stage: 'no-token' }); return { ok: false, needLogin: true, message: 'Logga in med din mejl (kontoknappen) för att låsa upp Krypto.' }; }
  const payload = { vaka_token: token, edition: 'vaka', messages: (Array.isArray(messages) ? messages : []).slice(-16) };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(SKOLL + '/api/sakerkoll/ai/chat', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) { klog({ stage: 'http', attempt, status: r.status, error: json.error, msgCount: payload.messages.length }); return { ok: false, error: json.error, message: json.message || 'Något gick fel. Försök igen om en stund.' }; }
      klog({ stage: 'ok', attempt, used: json.used });
      return { ok: true, reply: json.reply };
    } catch (err) {
      klog({ stage: 'throw', attempt, err: String(err && (err.name || err.message || err)) });
      if (attempt === 2) return { ok: false, message: 'Kunde inte nå Krypto just nu. Kontrollera din uppkoppling och försök igen.' };
      await new Promise((r) => setTimeout(r, 800)); // kort backoff, försök igen en gång
    }
  }
});

// Krypto som agent: panelen skickar hit kommandon (t.ex. byt sökmotor, av/på skydd).
// Fönster-/process-actions körs här; UI-inställningar rel:as vidare till skalet.
ipcMain.on('krypto:action', (e, a) => {
  try {
    const ctx = e.sender.__ctx; if (!ctx || !a || !a.name) return;
    const name = String(a.name).toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o');
    if (name === 'inkognito' || name === 'incognito') { createWindow(true); return; }
    if (name === 'nedladdningar' || name === 'downloads') { sendTo(ctx, 'open-downloads'); return; }
    if (name === 'losenord' || name === 'autofyll' || name === 'autofill') { sendTo(ctx, 'open-passwords'); return; }
    if (name === 'wallet' || name === 'planbok' || name === 'kort' || name === 'vaka wallet') { sendTo(ctx, 'open-settings', 'wallet'); return; }
    // sokmotor / adblock / realtidsskydd / minska_rorelse sköts i skalet
    sendTo(ctx, 'krypto-set', a);
  } catch {}
});

/* ────────── Kortkommandon (Chromium-lika) ──────────
 * Acceleratorerna i popup-menyerna är bara etiketter. Riktiga genvägar fångas
 * här via before-input-event på VARJE webContents (skal + flik-vyer + Krypto),
 * så de funkar även när fokus ligger i en webbsida. */
function ctxForWc(wc) { return wins.get(wc.id) || wc.__ctx || null; }
function activeView(ctx) { return ctx && ctx.visibleTab ? ctx.views.get(ctx.visibleTab) : null; }
function handleShortcut(wc, input) {
  if (input.type !== 'keyDown') return false;
  const ctx = ctxForWc(wc);
  if (!ctx) return false;
  const mod = input.control || input.meta;      // Ctrl (eller Cmd på mac)
  const shift = input.shift;
  const k = (input.key || '').toLowerCase();
  if (mod && !shift && k === 't') { sendTo(ctx, 'open-new-tab'); return true; }
  if (mod && !shift && k === 'n') { createWindow(false); return true; }
  if (mod && shift && k === 'n') { createWindow(true); return true; }
  if (mod && !shift && k === 'w') { sendTo(ctx, 'close-tab'); return true; }
  if (mod && !shift && k === 'l') { try { ctx.win.webContents.focus(); } catch {} sendTo(ctx, 'focus-address'); return true; }
  if (mod && shift && k === 'r') { const v = activeView(ctx); if (v) v.webContents.reloadIgnoringCache(); return true; }
  if (mod && !shift && k === 'r') { const v = activeView(ctx); if (v) v.webContents.reload(); return true; }
  if (mod && !shift && k === 'p') { const v = activeView(ctx); if (v) printPage(ctx, v.webContents); return true; }
  if (mod && (k === '+' || k === '=')) { sendTo(ctx, 'menu-zoom', 1); return true; }
  if (mod && (k === '-' || k === '_')) { sendTo(ctx, 'menu-zoom', -1); return true; }
  if (mod && k === '0') { sendTo(ctx, 'menu-zoom', 0); return true; }
  if (mod && !shift && k === 'q') { app.quit(); return true; }
  if (k === 'f11') { toggleFull(ctx); return true; }
  if (k === 'f12' || (mod && shift && k === 'i')) { const v = activeView(ctx); if (v) try { v.webContents.openDevTools(); } catch {} return true; }
  if (k === 'f5') { const v = activeView(ctx); if (v) v.webContents.reload(); return true; }
  return false;
}
app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (ev, input) => { try { if (handleShortcut(wc, input)) ev.preventDefault(); } catch {} });
  // Context-meny: bara för skalets webContents (native flik-vyer har sin egen i ensureView).
  wc.on('context-menu', (_ev, params) => { const ctx = wins.get(wc.id); if (ctx) { try { buildShellMenu(ctx, wc, params); } catch {} } });
});

/* ────────── Fönster ────────── */
function createWindow(incognito) {
  const win = new BrowserWindow({
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: incognito ? '#0a0512' : '#0e2a47',
    title: incognito ? 'Vaka – Inkognito' : 'Vaka',
    // Som Brave/Chrome: ingen egen titelrad – flikarna ligger i samma rad som fönsterknapparna.
    // macOS: trafikljusen ritas av systemet uppe till vänster (skalet lämnar plats). Windows/Linux:
    // Electrons Window Controls Overlay ritar minimera/maximera/stäng uppe till höger i flikraden.
    // Som Brave/Chrome: ingen systemtitelrad. Mac: trafikljusen ritas av systemet uppe till
    // vänster. Windows/Linux: ramlöst fönster – skalet ritar minimera/maximera/stäng själv
    // längst till höger i flikraden (#winctl) och pratar med oss via win:minimize/toggle-max/close.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 }, fullscreenable: false }   // gröna knappen = maximera (zoom), inte helskärm; helskärm bara via F11/sidan (setFull slår på det tillfälligt)
      : { frame: false }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const id = win.webContents.id;
  const ctx = makeCtx(win, incognito);
  wins.set(id, ctx);
  win.loadFile(path.join(__dirname, 'ui', 'shell.html'), incognito ? { query: { incognito: '1' } } : {});
  // Startades Vaka med en länk (t.ex. som standardwebbläsare)? Öppna den när skalet laddat.
  win.webContents.once('did-finish-load', () => {
    if (pendingUrl && !incognito) { sendTo(ctx, 'open-new-tab', pendingUrl); pendingUrl = null; }
  });
  win.on('resize', () => sendTo(ctx, 'window-resized'));
  win.on('maximize', () => sendTo(ctx, 'win-maximized', true));
  win.on('unmaximize', () => sendTo(ctx, 'win-maximized', false));
  win.on('enter-full-screen', () => applyBounds(ctx));   // räkna om vy-bounds när övergången är klar (rätt storlek)
  win.on('blur', () => { ctx._blurAt = Date.now(); });
  // Electron på Wayland ritar fönsterram och skugga själv (CSD). När fönstret
  // blir inaktivt ritas skuggan tunnare, och Chromium krymper då felaktigt
  // själva innehållsytan (electron/electron#48588). Ett maximerat fönster
  // blev 1372x912 på en 1920x1080-skärm i samma ögonblick som fokus gick till
  // den andra skärmen (Cetto 2026-09-04, VAKA_WIN_DEBUG-logg). Vakten: är
  // fönstret maximerat men mindre än skärmens arbetsyta, sätt tillbaka storleken.
  win.on('resize', () => {
    try {
      if (!win.isMaximized() || win.isFullScreen()) return;
      const b = win.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      if (b.width >= wa.width - 4 && b.height >= wa.height - 4) return;
      if (ctx._regrow) return;
      ctx._regrow = setTimeout(() => {
        ctx._regrow = null;
        try {
          if (win.isDestroyed() || !win.isMaximized()) return;
          const nb = win.getBounds();
          if (nb.width >= wa.width - 4 && nb.height >= wa.height - 4) return;
          win.setSize(wa.width, wa.height);
          setTimeout(() => {
            try {
              if (win.isDestroyed() || !win.isMaximized()) return;
              const b2 = win.getBounds();
              if (b2.width < wa.width - 4 || b2.height < wa.height - 4) { win.unmaximize(); win.maximize(); }
            } catch {}
          }, 150);
        } catch {}
      }, 40);
    } catch {}
  });
  // Tillfällig felsökning (VAKA_WIN_DEBUG=1): logga fönstrets läge vid varje händelse.
  if (process.env.VAKA_WIN_DEBUG) {
    const fs = require('fs'); const os = require('os');
    const logf = path.join(os.homedir(), '.config', 'Vaka', 'win-debug.log');
    const log = (ev) => { try { const b = win.getBounds(); fs.appendFileSync(logf, `${new Date().toISOString()} ${ev} bounds=${b.x},${b.y} ${b.width}x${b.height} max=${win.isMaximized()} full=${win.isFullScreen()} focus=${win.isFocused()} htmlFull=${!!ctx.htmlFull} wanted=${!!ctx.fullWanted}\n`); } catch {} };
    for (const ev of ['blur', 'focus', 'resize', 'resized', 'move', 'moved', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'minimize', 'restore', 'show', 'hide']) win.on(ev, () => log(ev));
    log('start');
    if (process.env.VAKA_WIN_DEBUG_MAX) setTimeout(() => { try { win.maximize(); } catch {} }, 2500);
  }
  win.on('leave-full-screen', () => {
    applyBounds(ctx);
    if (process.platform === 'darwin' && !ctx.fullWanted) { try { win.setFullScreenable(false); } catch {} }   // tillbaka: gröna knappen maximerar
    // Begärde ingen det här (F11/meny/sidan sätter fullWanted=false först) och
    // fönstret är utan fokus, så är det skrivbordet som tog helskärmen. Ta
    // tillbaka den. Fördröjningen låter kompositorns konfiguration landa.
    if (ctx.fullWanted && (!win.isFocused() || Date.now() - (ctx._blurAt || 0) < 1500)) {
      setTimeout(() => { try { if (ctx.fullWanted && !win.isDestroyed() && !win.isFullScreen()) win.setFullScreen(true); } catch {} }, 80);
    }
  });
  // Bekräfta innan man stänger ett fönster med flera flikar (Brave-likt). Skalet
  // avgör om dialogen behövs (det vet flik-antalet) och kallar win:do-close när OK.
  win.on('close', (e) => {
    if (ctx.forceClose) return;                    // redan bekräftat → stäng på riktigt
    e.preventDefault();
    if (win.webContents && !win.webContents.isDestroyed()) win.webContents.send('confirm-close');
    else { ctx.forceClose = true; win.destroy(); }
  });
  win.on('closed', () => {
    ctx.views.forEach((v) => { try { v.webContents.close(); } catch {} });
    ctx.views.clear();
    if (ctx.kryptoView) { try { ctx.kryptoView.webContents.close(); } catch {} ctx.kryptoView = null; }
    wins.delete(id);
  });
  return win;
}

/* ── Standardwebbläsare ──
   Registrerar Vaka som hanterare för http/https så att länkar från andra
   program (mejl, chatt, PDF:er) öppnas här. Linux styrs av en .desktop-fil +
   xdg-settings; Windows 10/11 tillåter inte att program sätter sig själva som
   standard, så där öppnas systemets val med Vaka registrerad som alternativ. */
const DESKTOP_ID = 'vaka.desktop';

function urlFromArgv(argv) {
  return (argv || []).find((s) => /^https?:\/\//i.test(String(s))) || null;
}
let pendingUrl = urlFromArgv(process.argv);

// Öppna en länk som kom utifrån (OS:et) i en ny flik i ett vanligt fönster.
function openExternalLink(url) {
  if (!/^https?:\/\//i.test(String(url))) return;
  const ctx = [...wins.values()].find((c) => !c.incognito) || [...wins.values()][0];
  if (!ctx) { pendingUrl = url; return; }
  if (ctx.win.isMinimized()) ctx.win.restore();
  ctx.win.focus();
  sendTo(ctx, 'open-new-tab', url);
}

function xdg(args) {
  return new Promise((res) => {
    try { execFile(args[0], args.slice(1), (err, out) => res(err ? null : String(out || '').trim())); }
    catch { res(null); }
  });
}

function desktopEntry(icon) {
  // Föredra installerarens wrapper ~/.local/bin/vaka (skickar --no-sandbox och
  // överlever uppdateringar). AppImage: peka på .AppImage-filen (mount-sökvägen
  // försvinner vid avslut). OBS: inga citattecken runt sökvägen — xdg-settings
  // parser av Exec tål dem inte.
  const wrapper = path.join(app.getPath('home'), '.local', 'bin', 'vaka');
  const exec = fs.existsSync(wrapper) ? wrapper
    : process.env.APPIMAGE ? `${process.env.APPIMAGE} --no-sandbox`
    : app.isPackaged ? process.execPath
    : `${process.execPath} ${__dirname} --no-sandbox`;
  return [
    '[Desktop Entry]',
    'Name=Vaka',
    'GenericName=Webbläsare',
    'Comment=Den trygga svenska webbläsaren som vakar över dig',
    `Exec=${exec} %U`,
    `Icon=${icon}`,
    'Type=Application',
    'Terminal=false',
    'StartupNotify=true',
    'Categories=Network;WebBrowser;',
    'MimeType=text/html;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;',
    'StartupWMClass=Vaka',
  ].join('\n') + '\n';
}

async function setDefaultBrowserLinux() {
  const home = app.getPath('home');
  const appsDir = path.join(home, '.local', 'share', 'applications');
  let icon = path.join(__dirname, 'build', 'icon.png');
  try {
    const iconDir = path.join(home, '.local', 'share', 'icons');
    fs.mkdirSync(iconDir, { recursive: true });
    const dst = path.join(iconDir, 'vaka.png');
    fs.copyFileSync(icon, dst); icon = dst;
  } catch {}
  fs.mkdirSync(appsDir, { recursive: true });
  fs.writeFileSync(path.join(appsDir, DESKTOP_ID), desktopEntry(icon));
  await xdg(['update-desktop-database', appsDir]);
  await xdg(['xdg-settings', 'set', 'default-web-browser', DESKTOP_ID]);
  // xdg-settings räcker inte på alla skrivbord — sätt mime-defaulterna direkt också.
  await xdg(['xdg-mime', 'default', DESKTOP_ID, 'x-scheme-handler/http', 'x-scheme-handler/https', 'text/html']);
  return isDefaultBrowserLinux();
}

async function isDefaultBrowserLinux() {
  if ((await xdg(['xdg-settings', 'get', 'default-web-browser'])) === DESKTOP_ID) return true;
  return (await xdg(['xdg-mime', 'query', 'default', 'x-scheme-handler/http'])) === DESKTOP_ID;
}

function registerProtocolClient() {
  for (const p of ['http', 'https']) {
    if (app.isPackaged) app.setAsDefaultProtocolClient(p);
    else app.setAsDefaultProtocolClient(p, process.execPath, [__dirname, '--no-sandbox']);
  }
}

ipcMain.handle('defaultbrowser:state', async () => {
  try {
    if (process.platform === 'linux') {
      return { default: await isDefaultBrowserLinux() };
    }
    return { default: app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https') };
  } catch { return { default: false }; }
});

ipcMain.handle('defaultbrowser:set', async () => {
  try {
    if (process.platform === 'linux') {
      const ok = await setDefaultBrowserLinux();
      return { ok };
    }
    registerProtocolClient();
    if (process.platform === 'win32' && !app.isDefaultProtocolClient('http')) {
      shell.openExternal('ms-settings:defaultapps');
      return { ok: false, manual: true };
    }
    return { ok: app.isDefaultProtocolClient('http') };
  } catch { return { ok: false }; }
});

// macOS skickar länkar hit i stället för via argv.
app.on('open-url', (e, url) => { e.preventDefault(); openExternalLink(url); });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = urlFromArgv(argv);
    if (url) { openExternalLink(url); return; }
    const all = BrowserWindow.getAllWindows();
    if (all.length) { const w = all[all.length - 1]; if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

app.whenReady().then(async () => {
  // [widevine-init] Widevine DRM (Netflix/Spotify/HBO m.fl.). castlabs-Electron laddar CDM:en vid start.
  try {
    if (components && components.whenReady) {
      await components.whenReady();
      console.log('[widevine]', components.status && JSON.stringify(components.status()));
    }
  } catch (e) { console.error('[widevine] init misslyckades:', e && e.message); }
  setInterval(sweepIdleTabs, DISCARD_SWEEP_MS).unref();   // kasta lediga bakgrundsflikar löpande
  // Presentera oss som vanlig Chrome — annars ser sajter (t.ex. Google) "Electron"
  // + appnamnet i user-agent och tror att det är en bot ("unusual traffic").
  try {
    app.userAgentFallback = app.userAgentFallback
      .replace(new RegExp(' ' + app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\S+', 'i'), '')
      .replace(/ sakerkoll-browser\/\S+/i, '')
      .replace(/ Electron\/\S+/i, '');
    session.defaultSession.setUserAgent(app.userAgentFallback);
  } catch {}
  applyClientHints(session.defaultSession);
  installAdblockOn(session.defaultSession);
  trackDownloads(session.defaultSession);
  migrateGoogleCookieFix();
  // Ingen OS-menyrad (File/Edit/View…) i fönstret — webbläsaren har sin egen ≡-meny.
  // På macOS behålls en riktig meny (systemets menyrad + Cmd+C/V/A m.m.).
  try {
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    } else {
      Menu.setApplicationMenu(null);
    }
  } catch {}
  createWindow(false);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(false); });
  startAutoUpdate();
});

// Auto-uppdatering (Linux/AppImage): hämtar nya versioner i bakgrunden och
// installerar dem nästa gång Vaka startas om — ingen ominstallation för hand.
function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}
// macOS kan inte tyst-uppdatera osignerad (Squirrel kräver signering) → notifiera i stället.
function checkMacUpdate() {
  const f = globalThis.fetch;
  if (!f) return;
  let toasted = '';                     // en notis per version – aldrig samma tjat varje koll
  const ping = () => f('https://api.github.com/repos/northcrafto/vaka-dl/releases/latest', { headers: { 'User-Agent': 'Vaka' } })
    .then((r) => r.json())
    .then((j) => {
      const latest = ((j && j.tag_name) || '').replace(/^v/, '');
      if (latest && semverGt(latest, app.getVersion()) && latest !== toasted) {
        toasted = latest;
        broadcast('toast', T('En ny version finns') + ' (' + latest + ') — ' + T('ladda ner på') + ' vaka-web-lovat.vercel.app');
      }
    }).catch(() => {});
  setTimeout(ping, 6000);
  setInterval(ping, 30 * 60 * 1000);
}

function startAutoUpdate() {
  if (process.platform === 'darwin') { checkMacUpdate(); return; }  // mac: notis (osignerad)
  if (!autoUpdater) return;
  const log = (m) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), m + '\n'); } catch {} };
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => log('checking @ ' + app.getVersion()));
    autoUpdater.on('update-available', (i) => log('available ' + (i && i.version)));
    autoUpdater.on('update-not-available', (i) => log('up-to-date ' + (i && i.version)));
    autoUpdater.on('update-downloaded', (info) => {
      const v = (info && info.version) || '';
      log('downloaded ' + v);
      if (v && v === updDownloaded) return;     // samma fil igen (cache-träff vid omkoll) – tyst
      updDownloaded = v;
      broadcast('toast', 'Vaka ' + ((info && info.version) || '') + ' ' + T('är hämtad — uppdateras nästa gång du startar om.'));
      broadcast('update-ready', v);
    });
    autoUpdater.on('error', (e) => log('error ' + (e && e.message)));
    runUpdateCheck = () => { try { return autoUpdater.checkForUpdates().catch(() => null); } catch { return Promise.resolve(null); } };
    setTimeout(runUpdateCheck, 5000);
    setInterval(runUpdateCheck, 30 * 60 * 1000);
    // …och när fönstret får fokus igen (högst var 10:e minut) – så att notisen alltid
    // pekar på den senaste släppta versionen, inte den som råkade vara ny vid start.
    let lastFocusCheck = 0;
    app.on('browser-window-focus', () => { const n = Date.now(); if (n - lastFocusCheck > 10 * 60 * 1000) { lastFocusCheck = n; runUpdateCheck(); } });
  } catch {}
}
// Användaren tryckte "Starta om & uppdatera" i banner → installera den hämtade uppdateringen nu.
// Färsk koll först: har en ännu nyare version släppts sedan filen hämtades? Då tas den
// i stället, så att man aldrig startar om till en redan gammal version.
let updDownloaded = '';
let updInstalling = false;
let runUpdateCheck = () => Promise.resolve(null);
ipcMain.on('update:install', async () => {
  if (!autoUpdater || updInstalling) return;
  updInstalling = true;
  try {
    const res = await Promise.race([runUpdateCheck(), new Promise((r) => setTimeout(() => r(null), 8000))]);
    const v = res && res.updateInfo && res.updateInfo.version;
    if (v && res.downloadPromise && (!updDownloaded || semverGt(v, updDownloaded))) {
      if (updDownloaded) broadcast('toast', T('Hämtar nyaste versionen') + ' (' + v + ')…');
      await res.downloadPromise;                 // update-downloaded → updDownloaded = v
    }
  } catch {}
  updInstalling = false;
  try { autoUpdater.quitAndInstall(false, true); } catch {}
});
app.on('will-quit', () => { if (torProc) { try { torProc.kill(); } catch {} } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
