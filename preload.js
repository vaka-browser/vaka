'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('defaultBrowser', {
  state: () => ipcRenderer.invoke('defaultbrowser:state'),
  set: () => ipcRenderer.invoke('defaultbrowser:set'),
});

contextBridge.exposeInMainWorld('locale', {
  load: (lang) => { try { return ipcRenderer.sendSync('i18n:load', lang) || {}; } catch { return {}; } },
});

contextBridge.exposeInMainWorld('skoll', {
  checkUrl: (url) => ipcRenderer.invoke('skoll:check-url', url),
  dailyImage: () => ipcRenderer.invoke('skoll:daily-image'),
  adblockToggle: (on) => ipcRenderer.invoke('skoll:adblock-toggle', on),
  adblockState: () => ipcRenderer.invoke('skoll:adblock-state'),
  onAdblockCount: (cb) => ipcRenderer.on('adblock:count', (_e, n) => cb(n)),
  onAdblockHit: (cb) => ipcRenderer.on('adblock:hit', (_e, type) => cb(type)),
});

contextBridge.exposeInMainWorld('auth', {
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  signup: (email, password, name) => ipcRenderer.invoke('auth:signup', { email, password, name }),
  verifyCode: (email, code) => ipcRenderer.invoke('auth:verify-code', { email, code }),
  resetRequest: (email) => ipcRenderer.invoke('auth:reset-request', { email }),
  resetConfirm: (email, code, password) => ipcRenderer.invoke('auth:reset-confirm', { email, code, password }),
  session: (token) => ipcRenderer.invoke('auth:session', { token }),
  logout: (token) => ipcRenderer.invoke('auth:logout', { token }),
  deleteAccount: (token) => ipcRenderer.invoke('auth:delete', { token }),
  remember: (account) => ipcRenderer.invoke('auth:remember', account),
  recall: () => ipcRenderer.invoke('auth:recall'),
  forget: () => ipcRenderer.invoke('auth:forget'),
});

contextBridge.exposeInMainWorld('family', {
  createChild: (token, name, age) => ipcRenderer.invoke('family:child', { token, name, age }),
  join: (code) => ipcRenderer.invoke('family:join', { code }),
  children: (token) => ipcRenderer.invoke('family:children', { token }),
  setBlocklist: (token, child_id, blocklist) => ipcRenderer.invoke('family:blocklist', { token, child_id, blocklist }),
  allow: (token, child_id, host, minutes) => ipcRenderer.invoke('family:allow', { token, child_id, host, minutes }),
  historyAdd: (token, url, title) => ipcRenderer.invoke('family:history-add', { token, url, title }),
  history: (token, child_id) => ipcRenderer.invoke('family:history', { token, child_id }),
  me: (token) => ipcRenderer.invoke('family:me', { token }),
  logoutChild: (token, child_id) => ipcRenderer.invoke('family:logout-child', { token, child_id }),
  rotateCode: (token, child_id) => ipcRenderer.invoke('family:rotate-code', { token, child_id }),
  sessions: (token, child_id) => ipcRenderer.invoke('family:sessions', { token, child_id }),
  logoutSession: (token, child_id, sid) => ipcRenderer.invoke('family:logout-session', { token, child_id, sid }),
});

contextBridge.exposeInMainWorld('social', {
  me: (token) => ipcRenderer.invoke('social:me', { token }),
  profile: (token, username, avatar) => ipcRenderer.invoke('social:profile', { token, username, avatar }),
  friendRequest: (token, username) => ipcRenderer.invoke('social:friend-request', { token, username }),
  friendRespond: (token, username, accept) => ipcRenderer.invoke('social:friend-respond', { token, username, accept }),
  friends: (token) => ipcRenderer.invoke('social:friends', { token }),
  messages: (token, chat, since) => ipcRenderer.invoke('social:messages', { token, chat, since }),
  send: (token, chat, body) => ipcRenderer.invoke('social:send', { token, chat, body }),
  edit: (token, id, body) => ipcRenderer.invoke('social:edit', { token, id, body }),
  chatAvatar: (token, chat, avatar) => ipcRenderer.invoke('social:chatavatar', { token, chat, avatar }),
});

contextBridge.exposeInMainWorld('session', {
  setkey: (key) => ipcRenderer.invoke('session:setkey', { key }),
  login: (key) => ipcRenderer.invoke('session:login', { key }),
  logout: (key) => ipcRenderer.invoke('session:logout', { key }),
});

contextBridge.exposeInMainWorld('net', {
  toggle: (open) => ipcRenderer.send('net:toggle', !!open),
  clear: () => ipcRenderer.send('net:clear'),
  detail: (id) => ipcRenderer.invoke('net:detail', id),
  onRow: (cb) => ipcRenderer.on('net-row', (_e, r) => cb(r)),
});

contextBridge.exposeInMainWorld('tor', {
  state: () => ipcRenderer.invoke('tor:state'),
  onState: (cb) => ipcRenderer.on('tor-state', (_e, s) => cb(s)),
});

contextBridge.exposeInMainWorld('pw', {
  list: () => ipcRenderer.invoke('pw:list'),
  save: (c) => ipcRenderer.invoke('pw:save', c),
  setAutofill: (o) => ipcRenderer.invoke('pw:set-autofill', o),
  del: (id) => ipcRenderer.invoke('pw:delete', id),
  onOffer: (cb) => ipcRenderer.on('pw-offer', (_e, c) => cb(c)),
});
contextBridge.exposeInMainWorld('wallet', {
  list: () => ipcRenderer.invoke('wallet:list'),
  get: (id) => ipcRenderer.invoke('wallet:get', id),
  save: (c) => ipcRenderer.invoke('wallet:save', c),
  del: (id) => ipcRenderer.invoke('wallet:delete', id),
  fillNow: (id) => ipcRenderer.send('wallet:fill-now', id),
  onOffer: (cb) => ipcRenderer.on('wallet-offer', (_e, c) => cb(c)),
  onFillOffer: (cb) => ipcRenderer.on('wallet-fill-offer', (_e, cards) => cb(cards)),
});
contextBridge.exposeInMainWorld('dl', {
  list: () => ipcRenderer.invoke('dl:list'),
  open: (id) => ipcRenderer.send('dl:open', id),
  folder: (id) => ipcRenderer.send('dl:folder', id),
  popupToggle: () => ipcRenderer.send('dl:popup-toggle'),
  removeThreat: (id) => ipcRenderer.send('dl:remove-threat', id),
  keepAnyway: (id) => ipcRenderer.send('dl:keep-anyway', id),
  onUpdate: (cb) => ipcRenderer.on('download-update', (_e, r) => cb(r)),
  onThreat: (cb) => ipcRenderer.on('download-threat', (_e, t) => cb(t)),
});

contextBridge.exposeInMainWorld('view', {
  load: (id, url) => ipcRenderer.send('view:load', id, url),
  show: (id) => ipcRenderer.send('view:show', id),
  hide: () => ipcRenderer.send('view:hide'),
  suggest: (q, engine) => ipcRenderer.invoke('omni:suggest', { q, engine }),
  bounds: (r) => ipcRenderer.send('view:bounds', r),
  insetTop: (px) => ipcRenderer.send('view:inset-top', px),
  insetLeft: (px) => ipcRenderer.send('view:inset-left', px),
  zoom: (id, dir) => ipcRenderer.send('view:zoom', id, dir),
  defaultZoom: (f) => ipcRenderer.send('view:default-zoom', f),
  print: (id) => ipcRenderer.send('view:print', id),
  openMenu: () => ipcRenderer.send('open-app-menu'),
  markIncognito: (id) => ipcRenderer.send('view:incognito', id),
  onNewIncognito: (cb) => ipcRenderer.on('new-incognito', () => cb()),
  onToast: (cb) => ipcRenderer.on('toast', (_e, m) => cb(m)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, v) => cb(v)),
  installUpdate: () => ipcRenderer.send('update:install'),
  onOpenHistory: (cb) => ipcRenderer.on('open-history', () => cb()),
  onOpenBookmarks: (cb) => ipcRenderer.on('open-bookmarks', () => cb()),
  onOpenDownloads: (cb) => ipcRenderer.on('open-downloads', () => cb()),
  onOpenPasswords: (cb) => ipcRenderer.on('open-passwords', () => cb()),
  onKryptoSet: (cb) => ipcRenderer.on('krypto-set', (_e, a) => cb(a)),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', (_e, cat) => cb(cat)),
  onClearData: (cb) => ipcRenderer.on('clear-data', () => cb()),
  onMenuZoom: (cb) => ipcRenderer.on('menu-zoom', (_e, d) => cb(d)),
  onMenuPrint: (cb) => ipcRenderer.on('menu-print', () => cb()),
  onCloseTab: (cb) => ipcRenderer.on('close-tab', () => cb()),
  onConfirmClose: (cb) => ipcRenderer.on('confirm-close', () => cb()),
  doClose: () => ipcRenderer.send('win:do-close'),
  openCloseConfirm: (n) => ipcRenderer.send('open-close-confirm', n),
  onPersistSkipClose: (cb) => ipcRenderer.on('persist-skip-close', () => cb()),
  onFocusAddress: (cb) => ipcRenderer.on('focus-address', () => cb()),
  back: (id) => ipcRenderer.send('view:back', id),
  forward: (id) => ipcRenderer.send('view:forward', id),
  reload: (id) => ipcRenderer.send('view:reload', id),
  stop: (id) => ipcRenderer.send('view:stop', id),
  destroy: (id) => ipcRenderer.send('view:destroy', id),
  kryptoToggle: (open, mode, account) => ipcRenderer.send('krypto:toggle', open, mode, account),
  kryptoPrefill: (text) => ipcRenderer.send('krypto:prefill', text),
  onOpenLogin: (cb) => ipcRenderer.on('open-login', () => cb()),
  onKryptoRecheck: (cb) => ipcRenderer.on('krypto-recheck', () => cb()),
  platform: process.platform,
  setTitlebar: (c) => ipcRenderer.send('win:titlebar', c),
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winToggleMax: () => ipcRenderer.send('win:toggle-max'),
  winClose: () => ipcRenderer.send('win:close'),
  onWinMaximized: (cb) => ipcRenderer.on('win-maximized', (_e, v) => cb(!!v)),
  onLinkNavigate: (cb) => ipcRenderer.on('link-navigate', (_e, id, url) => cb(id, url)),
  onDidNavigate: (cb) => ipcRenderer.on('did-navigate', (_e, id, url, b, f) => cb(id, url, b, f)),
  onTitle: (cb) => ipcRenderer.on('title', (_e, id, t) => cb(id, t)),
  onFavicon: (cb) => ipcRenderer.on('favicon', (_e, id, f) => cb(id, f)),
  onLoading: (cb) => ipcRenderer.on('loading', (_e, id, l) => cb(id, l)),
  onOpenNewTab: (cb) => ipcRenderer.on('open-new-tab', (_e, url) => cb(url)),
  onOpenTabRaw: (cb) => ipcRenderer.on('open-tab-raw', (_e, url) => cb(url)),
  onShowQR: (cb) => ipcRenderer.on('show-qr', (_e, url, dataUrl) => cb(url, dataUrl)),
  onContentWarning: (cb) => ipcRenderer.on('content-warning', (_e, id, url, res) => cb(id, url, res)),
  onWindowResized: (cb) => ipcRenderer.on('window-resized', () => cb()),
});
