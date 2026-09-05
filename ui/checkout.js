/* Egen kassa i Krypto-panelen (Stripe Payment Element), samma upplägg som
 * Skribias /checkout. Huvudprocessen (window.billing) pratar med backend och
 * lägger på kontots token; den här sidan ser aldrig nyckeln eller kortet
 * (kortfälten är Stripes egna iframes). Bara kort – inga omdirigeringar. */
(function () {
  const $ = (id) => document.getElementById(id);
  const brand = document.querySelector('[data-brand]');
  const BRAND = (brand && brand.textContent.trim()) || 'Vaka';
  const fmt = (amount, currency) => {
    try { return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: (currency || 'sek').toUpperCase(), maximumFractionDigits: 0 }).format(amount / 100); }
    catch { return Math.round(amount / 100) + ' kr'; }
  };
  const APPEARANCE = {
    theme: 'night',
    variables: {
      colorPrimary: '#e08a62', colorBackground: '#1b1b1e', colorText: '#f2f2f4', colorTextSecondary: '#9a9ca3',
      colorTextPlaceholder: '#5d5d64', colorDanger: '#ff8a84', fontFamily: '-apple-system, "Segoe UI", Roboto, system-ui, sans-serif',
      fontSizeBase: '14px', borderRadius: '12px', spacingUnit: '4px',
    },
    rules: {
      '.Input': { border: '1px solid #2e2e33', boxShadow: 'none', padding: '11px 12px' },
      '.Input:focus': { border: '1px solid #e08a62', boxShadow: '0 0 0 3px rgba(224,138,98,.18)' },
      '.Input--invalid': { border: '1px solid #ff8a84' },
      '.Label': { color: '#8d8f97', fontSize: '11.5px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '6px' },
      '.Tab': { border: '1px solid #2e2e33', backgroundColor: '#1b1b1e' },
      '.Tab--selected': { border: '1px solid #e08a62', boxShadow: 'inset 0 0 0 1px #e08a62', backgroundColor: '#241a15' },
      '.TabLabel': { color: '#9a9ca3', fontWeight: '600' }, '.TabIcon': { fill: '#9a9ca3' },
      '.TabLabel--selected': { color: '#f2f2f4' }, '.TabIcon--selected': { fill: '#e08a62' },
      '.Block': { border: '1px solid #26262a', backgroundColor: '#151517' },
    },
  };

  let plan = (location.hash || '').replace('#', '') || 'pro_month';
  if (!/^(pro_month|pro_year|credits)$/.test(plan)) plan = 'pro_month';
  let stripe = null, elements = null, current = null, seq = 0;

  function setError(msg) { const e = $('err'); if (!msg) { e.textContent = ''; e.classList.remove('on'); return; } e.textContent = msg; e.classList.add('on'); }
  function applyPlanUi() {
    document.querySelectorAll('.plan').forEach((b) => b.classList.toggle('on', b.dataset.plan === plan));
    const credits = plan === 'credits';
    $('plans').style.display = credits ? 'none' : '';
    $('credits-note').style.display = credits ? '' : 'none';
    const ss = $('secure-sub'); if (ss) ss.style.display = credits ? 'none' : '';
    $('title').textContent = credits ? 'Köp extra credits' : 'Skaffa ' + BRAND + ' Pro';
    $('lead').textContent = credits ? 'Betalas en gång. Fylls på direkt efter betalningen.' : 'Krypto och allt annat i Pro låses upp på ditt konto direkt efter betalningen.';
  }

  async function prepare() {
    const my = ++seq;
    setError(''); $('pay').disabled = true; $('loading').style.display = ''; $('sum').style.display = 'none';
    if (elements) { try { const pe = elements.getElement('payment'); pe && pe.unmount(); } catch {} elements = null; }
    let r;
    try { r = await window.billing.intent(plan); } catch { r = { ok: false, error: 'unreachable' }; }
    if (my !== seq) return;
    if (!r || !r.ok) {
      $('loading').style.display = 'none';
      if (r && r.error === 'already_pro') { setError('Du har redan Pro på det här kontot. Tryck på tillbaka och sedan "Jag har aktiverat Pro".'); return; }
      if (r && r.needLogin) { setError('Logga in först (kontoknappen uppe till höger).'); return; }
      setError((r && r.message) || 'Kunde inte förbereda betalningen. Kontrollera uppkopplingen och försök igen.');
      return;
    }
    current = r;
    if (!stripe) { try { stripe = Stripe(r.publishable_key, { locale: 'sv' }); } catch { setError('Stripe kunde inte laddas. Kontrollera uppkopplingen.'); $('loading').style.display = 'none'; return; } }
    elements = stripe.elements({ clientSecret: r.client_secret, appearance: APPEARANCE, locale: 'sv' });
    const pe = elements.create('payment', { layout: 'tabs', terms: { card: 'never' } });
    pe.mount('#payment-element');
    pe.on('ready', () => { if (my !== seq) return; $('loading').style.display = 'none'; $('pay').disabled = false; });
    pe.on('change', (ev) => { if (ev.error) setError(ev.error.message); else setError(''); });
    const amount = fmt(r.amount, r.currency);
    $('sum').style.display = '';
    $('sum-label').textContent = r.kind === 'subscription' ? (r.interval === 'year' ? 'Att betala nu, sedan per år' : 'Att betala nu, sedan per månad') : 'Att betala';
    $('sum-amount').textContent = amount;
    $('pay-label').textContent = 'Betala ' + amount;
  }

  async function pay() {
    if (!stripe || !elements || !current) return;
    setError(''); $('pay').disabled = true; $('pay-label').textContent = 'Betalar …';
    const { error, paymentIntent } = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: 'https://vaka-web-lovat.vercel.app/' } });
    if (error) { setError(error.message || 'Betalningen gick inte igenom.'); $('pay').disabled = false; $('pay-label').textContent = 'Betala ' + fmt(current.amount, current.currency); return; }
    if (paymentIntent && paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'processing') { setError('Betalningen är inte klar (' + paymentIntent.status + ').'); $('pay').disabled = false; $('pay-label').textContent = 'Försök igen'; return; }
    let c;
    try { c = await window.billing.confirm(current.kind === 'subscription' ? { subscription: current.subscription } : { payment_intent: current.payment_intent }); } catch { c = null; }
    if (current.kind === 'payment') {
      $('done-title').textContent = 'Credits påfyllda';
      $('done-text').textContent = c && c.ok && c.credits != null ? 'Tack! Du har nu ' + c.credits.toLocaleString('sv-SE') + ' tokens i credits.' : 'Tack! Betalningen är genomförd. Dina credits fylls på inom kort.';
    } else if (!(c && c.ok && c.pro)) {
      $('done-text').textContent = 'Betalningen är genomförd. Pro aktiveras på kontot inom någon minut – tryck "Jag har aktiverat Pro" om det dröjer.';
    }
    document.body.classList.add('paid');
  }

  document.querySelectorAll('.plan').forEach((b) => b.addEventListener('click', () => { if (b.dataset.plan === plan) return; plan = b.dataset.plan; applyPlanUi(); prepare(); }));
  $('pay').addEventListener('click', pay);
  applyPlanUi();
  prepare();
})();
