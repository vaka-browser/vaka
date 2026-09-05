'use strict';
/*
 * Riktig Säkerkoll-inloggning – SAMMA krypto som appen/webben (se
 * ~/sakerkoll-app/src/community.ts). Kontonumret är "koden": login_hash och
 * wrapKey härleds ur det med PBKDF2-SHA256 (300k varv, salt = SHA256("skll-v1:"+user)).
 * Servern ser bara login_hash + chiffertext, aldrig numret. Byte-identiskt med
 * appens @noble eftersom den koden byggdes för att matcha WebCrypto.
 */
const SKOLL = 'https://www.xn--skerkoll-0za.se';
const API_BASE = SKOLL + '/api/sakerkoll';
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');

async function sha256(u8) { return new Uint8Array(await subtle.digest('SHA-256', u8)); }

async function deriveSecrets(code, usernameLower) {
  const salt = await sha256(enc.encode('skll-v1:' + usernameLower));
  const km = await subtle.importKey('raw', enc.encode(code), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 300000, hash: 'SHA-256' }, km, 512));
  return { loginHash: b64(bits.slice(0, 32)), wrapKey: bits.slice(32, 64) };
}

function generateAccountNumber() {
  const out = [];
  while (out.length < 16) {
    const buf = globalThis.crypto.getRandomValues(new Uint8Array(32));
    for (let i = 0; i < buf.length && out.length < 16; i++) if (buf[i] < 250) out.push(buf[i] % 10);
  }
  return out.join('');
}

async function genKeypairWrapped(wrapKey) {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));      // 65 byte, okomprimerad
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));     // matchar appens buildPkcs8
  const aes = await subtle.importKey('raw', wrapKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aes, pkcs8));
  const blob = new Uint8Array(12 + ct.length); blob.set(iv, 0); blob.set(ct, 12);
  return { publicKeyB64: b64(pubRaw), encPriv: b64(blob) };
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json && (json.message || json.error) || 'Något gick fel.'); e.status = res.status; throw e; }
  return json;
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path, {
    method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json && (json.message || json.error) || 'Något gick fel.'); e.status = res.status; throw e; }
  return json;
}

async function login({ username, account }) {
  const { loginHash } = await deriveSecrets(account, String(username).toLowerCase());
  const r = await apiPost('/users/login', { username, login_hash: loginHash });
  return { ok: true, token: r.token, id: r.id, username: r.username };
}

/* Hämtar Pro-status för ett kontonummer (samma /trial/status som appen).
 * pro = betald prenumeration (has_subscription) — exakt som appens fetchStatus. */
async function proStatus({ account }) {
  const acct = String(account || '').replace(/\D/g, '');
  const r = await apiGet('/trial/status?account=' + encodeURIComponent(acct));
  const pro = !!(r && r.has_subscription);
  return { ok: true, pro, detail: r };
}

async function signup({ username }) {
  const account = generateAccountNumber();
  const { loginHash, wrapKey } = await deriveSecrets(account, String(username).toLowerCase());
  const { publicKeyB64, encPriv } = await genKeypairWrapped(wrapKey);
  const r = await apiPost('/account/create-full', {
    username, account, login_hash: loginHash, public_key: publicKeyB64, enc_priv: encPriv,
    fingerprint: b64(globalThis.crypto.getRandomValues(new Uint8Array(16))),
  });
  return { ok: true, account, token: r.token, id: r.id, username: r.username || username };
}

module.exports = { login, signup, proStatus, deriveSecrets, generateAccountNumber };
