'use strict';
/* Preload för Krypto-sidopanelen (ui/krypto.html). Exponerar bara en säker
 * kanal för att skicka chattmeddelanden — huvudprocessen lägger på kontonumret
 * och pratar med Säkerkoll-API:t, så numret behöver aldrig leva i panelen. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('locale', {
  load: (lang) => { try { return ipcRenderer.sendSync('i18n:load', lang) || {}; } catch { return {}; } },
});
contextBridge.exposeInMainWorld('krypto', {
  chat: (messages) => ipcRenderer.invoke('krypto:chat', messages),
  doAction: (a) => ipcRenderer.send('krypto:action', a),
  expand: (full) => ipcRenderer.send('krypto:expand', !!full),
  onPrefill: (cb) => ipcRenderer.on('krypto-prefill', (_e, t) => cb(t)),
});
/* Kassan (ui/checkout.html): huvudprocessen lägger på kontots token. */
contextBridge.exposeInMainWorld('billing', {
  intent: (plan) => ipcRenderer.invoke('billing:intent', plan),
  confirm: (d) => ipcRenderer.invoke('billing:confirm', d),
});
