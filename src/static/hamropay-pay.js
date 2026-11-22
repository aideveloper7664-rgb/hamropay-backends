/*!
 * Hamro Pay checkout widget
 * <script src="https://YOUR-HAMRO-API/hamropay-pay.js"></script>
 *
 * HamroPay.setCallbacks({ onSuccess, onFailed, onTimeout });
 * HamroPay.createOrder({ hamro_api, amount, title?, customer_mobile?, mode? });
 *   mode: 'inline' (default) = payment page opens INSIDE your page as a fullscreen overlay (no redirect, no popup, no new tab)
 *         'popup'  = old behaviour (separate popup window)
 *
 * NOTE: onSuccess sirf UI signal hai. Maal dene se pehle apne SERVER se
 * GET /api/developer/order-status/:orderId call karke status === "success" check karo.
 */
(function (global) {
  'use strict';

  var BASE = 'https://hamropay-backends.onrender.com';
  try {
    var cs = document.currentScript;
    if (cs && cs.src) BASE = new URL(cs.src).origin;   // script jahan se aayi, API wahin hai
  } catch (e) {}

  var POLL_MS = 2500;
  var CLOSED_GRACE_MS = 60 * 1000;   // popup band hone ke baad bhi itni der payment dhundte rehte hain
  var callbacks = {};

  function fire(name, payload) {
    try {
      if (typeof callbacks[name] === 'function') callbacks[name](payload);
    } catch (e) {
      console.error('HamroPay.js: error inside ' + name + ' callback', e);
    }
  }

  function setCallbacks(cb) {
    callbacks = cb || {};
  }


  // ---- Inline fullscreen checkout (overlay iframe). Same shape as a popup window: { closed, close(), setUrl() } ----
  function openFrame() {
    var root = document.createElement('div');
    root.setAttribute('data-hamropay-frame', '1');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(8,3,6,.78);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    var small = window.innerWidth <= 520;
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;display:flex;flex-direction:column;background:#0b0508;overflow:hidden;' +
      (small ? 'width:100%;height:100%;' : 'width:440px;max-width:96vw;height:min(760px,94vh);border-radius:18px;box-shadow:0 30px 90px -20px #000;border:1px solid #3a1d35;');
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 12px;background:#150a14;border-bottom:1px solid #2a1527;color:#f6eef5;font-size:13px;font-weight:700;flex:none';
    bar.innerHTML = '<span style="flex:1">&#128274; Secure checkout &middot; Hamro Pay</span>';
    var x = document.createElement('button');
    x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.innerHTML = '&#10005;';
    x.style.cssText = 'width:30px;height:30px;border-radius:9px;border:1px solid #3a1d35;background:#1d0f1c;color:#c2aebf;cursor:pointer;font-size:14px;line-height:1';
    bar.appendChild(x);
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;flex:1;min-height:0;background:#0b0508';
    var spin = document.createElement('div');
    spin.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c2aebf;font-size:13px';
    spin.textContent = 'Opening secure checkout...';
    var f = document.createElement('iframe');
    f.setAttribute('title', 'Hamro Pay checkout');
    f.setAttribute('allow', 'clipboard-write; payment');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#0b0508;opacity:0;transition:opacity .2s';
    f.onload = function () { if (f.src && f.src !== 'about:blank') { f.style.opacity = '1'; spin.style.display = 'none'; } };
    wrap.appendChild(spin); wrap.appendChild(f);
    box.appendChild(bar); box.appendChild(wrap); root.appendChild(box);
    document.body.appendChild(root);
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    var api = { closed: false };
    api.close = function () {
      if (api.closed) return;
      api.closed = true;
      try { document.body.removeChild(root); } catch (e) {}
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    };
    api.setUrl = function (u) { f.src = u; };
    api.openTab = function () { try { return window.open(f.src, '_blank'); } catch (e) { return null; } };
    function onKey(e) { if (e.key === 'Escape') api.close(); }
    document.addEventListener('keydown', onKey);
    x.onclick = function () { api.close(); };
    return api;
  }

  function poll(order, popup) {
    var finished = false;
    var closedAt = null;

    function finish(name, payload) {
      if (finished) return;
      finished = true;
      try { if (popup && !popup.closed) popup.close(); } catch (e) {}
      fire(name, payload);
    }

    function schedule() {
      if (!finished) setTimeout(tick, POLL_MS);
    }

    function tick() {
      if (finished) return;

      if (popup && popup.closed && closedAt === null) closedAt = Date.now();
      if (closedAt !== null && Date.now() - closedAt > CLOSED_GRACE_MS) {
        return finish('onTimeout', { order_id: order.order_id, amount: order.amount, reason: 'closed' });
      }

      fetch(BASE + '/api/developer/public-order-status/' + encodeURIComponent(order.order_id))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (finished) return;
          var d = res && res.data;
          if (!res || !res.success || !d) return schedule();

          if (d.status === 'paid') {
            finish('onSuccess', { order_id: order.order_id, amount: order.amount });
          } else if (d.status === 'cancelled' || d.status === 'failed') {
            finish('onFailed', { order_id: order.order_id, amount: order.amount, reason: d.status });
          } else if (d.status === 'expired' || d.status === 'disabled') {
            finish('onTimeout', { order_id: order.order_id, amount: order.amount, reason: d.status });
          } else {
            schedule();
          }
        })
        .catch(schedule);
    }

    tick();
  }

  function createOrder(opts) {
    opts = opts || {};

    // Yahan fail hone par sirf console me dikhta hai, koi callback nahi chalta (network tak baat jaati hi nahi)
    if (!opts.hamro_api) { console.error('HamroPay.js: hamro_api key is required'); return; }
    if (opts.amount === undefined || opts.amount === null || opts.amount === '') {
      console.error('HamroPay.js: amount is required');
      return;
    }

    var inline = opts.mode !== 'popup';
    var popup = null;
    if (inline) {
      // Page ke andar hi fullscreen checkout: koi redirect nahi, koi popup nahi, koi naya tab nahi
      try { popup = openFrame(); } catch (e) { popup = null; inline = false; }
    }
    if (!popup) {
      // Popup click ke turant baad kholna zaroori hai, warna browser block kar deta hai
      try {
        popup = window.open('', 'hamropay_checkout', 'width=430,height=700,menubar=no,toolbar=no,location=yes,resizable=yes,scrollbars=yes');
        if (popup && popup.document) {
          popup.document.write('<title>Hamro Pay</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0508;color:#fff;font-family:system-ui,sans-serif">Opening secure checkout...</body>');
        }
      } catch (e) { popup = null; }
    }

    var body = { hamro_api: opts.hamro_api, amount: opts.amount, useEmbedded: true };
    if (opts.title) body.title = opts.title;
    if (opts.customer_mobile) body.customer_mobile = opts.customer_mobile;

    fetch(BASE + '/api/developer/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        return r.json().catch(function () { return { success: false, message: 'Invalid response from server' }; });
      })
      .then(function (res) {
        if (!res.success || !res.data) {
          try { if (popup) popup.close(); } catch (e) {}
          return fire('onFailed', { error: res.message || 'Could not create order', errors: res.errors || null });
        }

        var d = res.data;
        if (popup && !popup.closed) {
          if (inline) popup.setUrl(/[?&]embedded=/.test(d.payment_url) ? d.payment_url : d.payment_url + (d.payment_url.indexOf('?') === -1 ? '?' : '&') + 'embedded=1');
          else popup.location.href = d.payment_url;
          poll(d, popup);
        } else {
          // Popup block hua: same tab me payment page. Return par apna server order-status se verify kare.
          window.location.href = d.payment_url;
        }
      })
      .catch(function () {
        try { if (popup) popup.close(); } catch (e) {}
        fire('onFailed', { error: 'network_error' });
      });
  }

  global.HamroPay = { setCallbacks: setCallbacks, createOrder: createOrder, version: '1.1.0' };
})(window);
