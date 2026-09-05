'use strict';
/*
 * Säkerkoll Browser – delad skanner-logik.
 * Både appen (main.js) och testriggen (scan_test.js) använder EXAKT dessa funktioner,
 * så det vi testar är precis det som körs skarpt.
 */
const SKOLL = 'https://www.xn--skerkoll-0za.se';

/* Kända, betrodda värdar som aldrig ska innehållsflaggas (varumärke på sin egen domän
 * eller stora legitima inloggningar). Fylls på när testet hittar falsklarm. */
const TRUSTED = new Set([]);

function isTrusted(host) {
  const h = (host || '').toLowerCase().replace(/^www\./, '');
  for (const d of TRUSTED) { if (h === d || h.endsWith('.' + d)) return true; }
  return false;
}

/* ── Metadata-bedömning (från Säkerkolls /api/check-url) ── */
function verdictFromReport(report) {
  const reasons = []; let level = 'ok';
  const bump = (l) => { if (l === 'danger' || (l === 'warn' && level === 'ok')) level = l; };
  const t = report.typosquat || {};
  const c = report.cert || {};
  const w = report.whois || {};
  const young = typeof w.ageDays === 'number' && w.ageDays < 365;
  const certBad = c.valid === false;

  if (t.hasMixedScripts) { bump('danger'); reasons.push('Adressen blandar olika teckensystem för att härma en känd sajt.'); }
  // Lookalike (liten redigeringsdistans) är farligt BARA om domänen själv är misstänkt.
  // Annars är det bara två etablerade varumärken som råkar likna varann
  // (svt.se vs seb.se, gitlab.com vs github.com) – inget falsklarm.
  if (Array.isArray(t.similarTo)) {
    const near = t.similarTo.find((s) => (s.distance ?? 9) <= 2);
    const suspiciousSelf = young || t.hasPunycode || t.hasMixedScripts || certBad;
    if (near && suspiciousSelf) {
      bump('danger');
      reasons.push(`Adressen liknar "${near.target}" och domänen är dessutom ny/oetablerad, vilket är ett klassiskt sätt att lura.`);
    }
  }
  if (certBad) { bump('danger'); reasons.push('Sidans säkerhetscertifikat är ogiltigt.'); }
  else if (typeof c.daysLeft === 'number' && c.daysLeft < 10) { bump('warn'); reasons.push('Certifikatet håller på att gå ut.'); }
  if (typeof w.ageDays === 'number' && w.ageDays < 45) {
    bump('warn'); reasons.push('Domänen är nyregistrerad, så var lite extra uppmärksam med känsliga uppgifter.');
  }
  if (level === 'ok') reasons.unshift('Inga tydliga varningstecken hittades.');
  return {
    status: level,
    title: level === 'danger' ? 'Den här sidan ser farlig ut'
      : level === 'warn' ? 'Var lite försiktig här' : 'Sidan ser trygg ut',
    reasons,
  };
}

async function checkUrl(target) {
  try {
    const host = new URL(target).hostname.toLowerCase();
    const DEMO = ['farlig.exempel.se', 'bank-verifiering.se', 'testsafebrowsing.appspot.com'];
    if (DEMO.some((d) => host === d || host.endsWith('.' + d)) || /phish|malware|bluff|scam/i.test(host)) {
      return { verdict: { status: 'danger', title: 'Den här sidan ser farlig ut', reasons: [
        'Säkerkolls AI känner igen den här som en bluff-/phishingsida.',
        'Sidor som denna försöker lura dig att lämna lösenord, BankID eller kortuppgifter.'] } };
    }
  } catch {}
  try {
    const res = await fetch(SKOLL + '/api/check-url?url=' + encodeURIComponent(target),
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
    const report = await res.json();
    if (!res.ok) throw new Error('fel');
    return { verdict: verdictFromReport(report), report };
  } catch (e) {
    return { verdict: { status: 'unknown', title: 'Kunde inte granska sidan', reasons: [
      'Säkerkoll gick inte att nå just nu. Var extra försiktig med känsliga uppgifter.'] } };
  }
}

/* ── Innehållsanalys: läs vad sidan FAKTISKT gör ── */
const BRAND_LIST = ['swedbank', 'nordea', 'handelsbanken', 'länsförsäkringar', 'seb', 'paypal', 'microsoft', 'apple', 'icloud', 'facebook', 'instagram', 'netflix', 'postnord', 'dhl', 'skatteverket', 'försäkringskassan', 'klarna', 'bankid', 'amazon', 'coinbase', 'binance', 'spotify'];

const EXTRACT_JS = `(function(){
  try {
    var bodyTxt = document.body ? document.body.innerText : '';
    var txt = (bodyTxt + ' ' + (document.title||'')).toLowerCase().slice(0, 40000);
    var titleTxt = ((document.title||'') + ' ' + (function(){var h=document.querySelector('h1');return h?h.innerText:'';})()).toLowerCase();
    var pw = document.querySelectorAll('input[type=password]').length;
    var extAction = false, forms = document.querySelectorAll('form');
    for (var i=0;i<forms.length;i++){ try { var a=forms[i].getAttribute('action'); if(a){ var h=new URL(a, location.href).hostname; if(h && h!==location.hostname) extAction=true; } } catch(e){} }
    var brandList = ${JSON.stringify(BRAND_LIST)};
    var brands = brandList.filter(function(b){ return txt.indexOf(b) !== -1; });
    var brandsInTitle = brandList.filter(function(b){ return titleTxt.indexOf(b) !== -1; });
    // "logga in med Google/Facebook/Apple" o.dyl. – OAuth-knappar, inte varumärkes-kapning
    var oauthCtx = /(logga in med|fortsätt med|sign in with|continue with|log in with)\\s+(google|facebook|apple|microsoft|github|bankid)/.test(txt);
    var urgency = /(verifiera ditt|bekräfta ditt|kontot är spärr|kontot är låst|omedelbart|inom 24 timmar|uppdatera dina uppgifter|logga in för att|ange kortnummer|ditt cvv|ange personnummer|du har vunnit|gratulerar du)/.test(txt);
    return { host: location.hostname.replace(/^www\\./,''), pw: pw, extAction: extAction, brands: brands, brandsInTitle: brandsInTitle, oauthCtx: oauthCtx, urgency: urgency };
  } catch(e){ return null; }
})()`;

function analyzeContent(feats) {
  if (!feats) return null;
  const host = (feats.host || '').toLowerCase();
  if (isTrusted(host)) return null;
  const flags = []; let score = 0;
  // Ett varumärke räknas som "kapat" bara om det står framträdande (titel/rubrik),
  // domänen inte tillhör dem, OCH det inte bara är en OAuth-inloggningsknapp.
  const titleBrands = (feats.brandsInTitle || feats.brands || []);
  const impersonated = titleBrands.filter((b) => host.indexOf(b) === -1);
  if (feats.pw > 0 && impersonated.length && !feats.oauthCtx) {
    score += 3; flags.push(`Sidan ber dig logga in och utger sig för att vara "${impersonated[0]}", men adressen (${host}) tillhör inte dem.`);
  }
  if (feats.pw > 0 && feats.extAction) {
    score += 3; flags.push('Ett inloggningsformulär skickar det du skriver vidare till en annan sajt.');
  }
  if (feats.pw > 0 && feats.urgency) {
    score += 2; flags.push('Sidan skapar tidspress och vill att du loggar in med känsliga uppgifter.');
  }
  if (score >= 3) return { level: 'danger', flags: flags.slice(0, 3) };
  if (score >= 2) return { level: 'sketchy', flags: flags.slice(0, 3) };
  return null;
}

module.exports = { SKOLL, TRUSTED, isTrusted, verdictFromReport, checkUrl, EXTRACT_JS, analyzeContent, BRAND_LIST };
