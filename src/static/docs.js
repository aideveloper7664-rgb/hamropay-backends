/* Hamro Pay API docs: samples, errors, copy/export, AI prompts.
   Ek hi data se dikhta bhi hai aur copy bhi hota hai, isliye dono kabhi alag nahi honge. */
(function () {
  'use strict';

  var BASE = /^https?:/.test(location.protocol) ? location.origin : 'https://hamropay-backends.onrender.com';
  var KEY = 'YOUR_HAMRO_API_KEY';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ================= CODE SAMPLES ================= */
  var R = String.raw;
  var SAMPLES = {
    html: {
      label: 'HTML / JS', short: 'HT', name: 'index.html',
      intro: 'Add the widget script, set your callbacks and call createOrder. The widget opens the payment popup and watches the order for you.',
      blocks: [{ label: 'index.html', code: R`<script src="${BASE}/hamropay-pay.js"></script>

<button onclick="payNow()">Pay ₹100</button>

<script>
  HamroPay.setCallbacks({
    onSuccess: function (order) {
      // order = { order_id, amount }. This is only a UI signal.
      // Confirm on YOUR server with order-status before you deliver anything.
      console.log('Payment successful:', order.order_id);
    },
    onFailed: function (order) {
      // order = { order_id, amount, reason } OR { error } when the order could not be created
      console.log('Payment failed:', order);
    },
    onTimeout: function (order) {
      // Order expired, or the popup was closed and no payment was found
      console.log('Payment timed out:', order);
    }
  });

  function payNow() {
    HamroPay.createOrder({
      hamro_api: '${KEY}',
      amount: 100,
      title: 'Order #123',            // optional
      customer_mobile: '9999999999'   // optional
    });
  }
</script>` }],
      notes: [
        ['info', 'createOrder opens a 430×700 popup <b>immediately</b> on click (so browsers do not block it) and then points it at the payment page. If popups are blocked it falls back to opening the payment page in the same tab. In that case use <code>redirect_url</code> flow and verify on return.'],
        ['warn', '<b>The widget fails silently on missing input.</b> If <code>hamro_api</code> or <code>amount</code> is missing it only writes to the browser console and no callback fires. Test with DevTools open.'],
        ['bad', 'With the widget, your API key is visible in page source. For a real store, create the order on your server (PHP / Node / Python tabs) and open the returned <code>payment_url</code>.']
      ]
    },
    php: {
      label: 'PHP', short: 'PHP', name: 'create-order.php',
      intro: 'Two scripts: one creates the order on your server and redirects the customer, the other handles their return and confirms the payment before trusting it.',
      blocks: [
        { label: 'create-order.php', code: R`<?php
session_start();

// A redirect is a full page navigation: nothing in this script's memory survives it.
// Save what you need now (a PHP session works) and read it back on return.
$_SESSION['customer_name']  = $_POST['name']  ?? '';
$_SESSION['customer_phone'] = $_POST['phone'] ?? '';

$ch = curl_init('${BASE}/api/developer/create-order');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
    'hamro_api'    => '${KEY}',
    'amount'       => 100,                      // take this from YOUR database, never from the browser
    'title'        => 'Order #123',
    'redirect_url' => 'https://yourstore.com/payment-return.php'
]));
$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);

if ($result['success']) {
    $_SESSION['order_id'] = $result['data']['order_id'];
    header('Location: ' . $result['data']['payment_url']);
    exit;
}
echo 'Could not start payment: ' . htmlspecialchars($result['message']);` },
        { label: 'payment-return.php', code: R`<?php
session_start();
// hp_result in the URL can be spoofed by anyone. Never trust it alone.
$orderId = $_GET['hp_order'] ?? null;
if (!$orderId || $orderId !== ($_SESSION['order_id'] ?? null)) {
    die('Unknown order.');
}

$ch = curl_init("${BASE}/api/developer/order-status/{$orderId}");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['X-HamroAPI-Key: ${KEY}']);
$response = curl_exec($ch);
curl_close($ch);
$result = json_decode($response, true);

if ($result['success'] && $result['data']['status'] === 'success') {
    // Verified on the server: safe to fulfil. Do it once per order_id.
    echo 'Payment confirmed for order ' . htmlspecialchars($result['data']['order_id']);
} elseif ($result['success'] && $result['data']['status'] === 'pending') {
    echo 'Payment still pending, please check again shortly.';
} else {
    echo 'Payment failed or expired.';
}` }
      ],
      notes: [['bad', 'Never branch fulfilment on <code>$_GET[\'hp_result\']</code>. The only trustworthy signal is a server-to-server <code>order-status</code> call returning <code>"success"</code>.']]
    },
    node: {
      label: 'Node.js', short: 'JS', name: 'routes/checkout.js',
      intro: 'Express example: one route creates the order and redirects the customer, another handles their return and confirms the payment.',
      blocks: [{ label: 'routes/checkout.js', code: R`const express = require('express');
const router = express.Router();

const HAMRO_API_KEY = process.env.HAMRO_API_KEY;   // keep the key in an environment variable
const BASE_URL = '${BASE}';

router.post('/create-order', async (req, res) => {
  const response = await fetch(BASE_URL + '/api/developer/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hamro_api: HAMRO_API_KEY,
      amount: 100,                                  // from YOUR database, not from req.body
      title: 'Order #123',
      redirect_url: 'https://yourstore.com/payment-return'
    })
  });
  const result = await response.json();

  if (!result.success) return res.status(400).json({ error: result.message });
  // Save result.data.order_id against your own order here
  res.redirect(result.data.payment_url);
});

// hp_order and hp_result are appended by Hamro Pay.
// hp_result can be spoofed. Always confirm with order-status from this server.
router.get('/payment-return', async (req, res) => {
  const orderId = req.query.hp_order;
  if (!orderId) return res.status(400).send('Missing order id.');

  const response = await fetch(BASE_URL + '/api/developer/order-status/' + encodeURIComponent(orderId), {
    headers: { 'X-HamroAPI-Key': HAMRO_API_KEY }
  });
  const result = await response.json();

  if (result.success && result.data.status === 'success') {
    res.send('Payment confirmed for order ' + result.data.order_id);   // fulfil once per order_id
  } else if (result.success && result.data.status === 'pending') {
    res.send('Payment still pending, please check again shortly.');
  } else {
    res.status(400).send('Payment failed or expired.');
  }
});

module.exports = router;` }],
      notes: [['info', 'Set the key as an environment variable: <code>HAMRO_API_KEY=hmpay_...</code>. Requires Node 18+ for built-in <code>fetch</code>.'], ['bad', 'Never branch fulfilment on <code>req.query.hp_result</code>. Only a server-side <code>order-status</code> result of <code>"success"</code> counts.']]
    },
    python: {
      label: 'Python', short: 'PY', name: 'app.py',
      intro: 'Flask + requests: one route creates the order and redirects the customer, another handles their return and confirms the payment.',
      blocks: [{ label: 'app.py', code: R`import os
import requests
from flask import Flask, request, redirect, jsonify

app = Flask(__name__)

HAMRO_API_KEY = os.environ['HAMRO_API_KEY']   # keep the key in an environment variable
BASE_URL = '${BASE}'

@app.route('/create-order', methods=['POST'])
def create_order():
    resp = requests.post(BASE_URL + '/api/developer/create-order', json={
        'hamro_api': HAMRO_API_KEY,
        'amount': 100,                         # from YOUR database, not from request data
        'title': 'Order #123',
        'redirect_url': 'https://yourstore.com/payment-return'
    }, timeout=15)
    result = resp.json()

    if not result['success']:
        return jsonify({'error': result['message']}), 400
    # Save result['data']['order_id'] against your own order here
    return redirect(result['data']['payment_url'])

# hp_order and hp_result are appended by Hamro Pay.
# hp_result can be spoofed. Always confirm with order-status from this server.
@app.route('/payment-return')
def payment_return():
    order_id = request.args.get('hp_order')
    if not order_id:
        return 'Missing order id.', 400

    resp = requests.get(
        BASE_URL + '/api/developer/order-status/' + order_id,
        headers={'X-HamroAPI-Key': HAMRO_API_KEY}, timeout=15)
    result = resp.json()

    if result['success'] and result['data']['status'] == 'success':
        return 'Payment confirmed for order ' + result['data']['order_id']   # fulfil once per order_id
    if result['success'] and result['data']['status'] == 'pending':
        return 'Payment still pending, please check again shortly.'
    return 'Payment failed or expired.', 400

if __name__ == '__main__':
    app.run(port=5000)` }],
      notes: [['info', 'Set the key as an environment variable: <code>HAMRO_API_KEY=hmpay_...</code>'], ['bad', 'Never branch fulfilment on <code>hp_result</code> alone. Only a server-side <code>order-status</code> result of <code>"success"</code> counts.']]
    },
    java: {
      label: 'Java (Android)', short: 'JV', name: 'HamroPayClient.java',
      intro: 'OkHttp: create the order, open payment_url in a Chrome Custom Tab, then poll order-status until it resolves.',
      blocks: [{ label: 'HamroPayClient.java', code: R`OkHttpClient client = new OkHttpClient();
String HAMRO_API_KEY = "${KEY}";   // better: fetch the order from YOUR backend so the key is not in the app
String BASE_URL = "${BASE}";
Handler handler = new Handler(Looper.getMainLooper());

public void createOrder(double amount, String title, OrderCallback callback) {
    JSONObject body = new JSONObject();
    try {
        body.put("hamro_api", HAMRO_API_KEY);
        body.put("amount", amount);
        body.put("title", title);
        body.put("useEmbedded", true);
    } catch (JSONException e) { callback.onError(e.getMessage()); return; }

    Request request = new Request.Builder()
        .url(BASE_URL + "/api/developer/create-order")
        .post(RequestBody.create(body.toString(), MediaType.parse("application/json")))
        .build();

    client.newCall(request).enqueue(new Callback() {
        @Override public void onFailure(Call call, IOException e) { callback.onError(e.getMessage()); }
        @Override public void onResponse(Call call, Response response) throws IOException {
            try {
                JSONObject json = new JSONObject(response.body().string());
                if (json.getBoolean("success")) {
                    JSONObject data = json.getJSONObject("data");
                    openCustomTab(data.getString("payment_url"));
                    pollOrderStatus(data.getString("order_id"), callback);
                } else {
                    callback.onError(json.getString("message"));
                }
            } catch (JSONException e) { callback.onError(e.getMessage()); }
        }
    });
}

void openCustomTab(String url) {
    new CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url));
}

// Poll every ~2.5 s. Orders expire after 15 minutes, so stop by then.
public void pollOrderStatus(String orderId, OrderCallback callback) {
    Request request = new Request.Builder()
        .url(BASE_URL + "/api/developer/order-status/" + orderId)
        .header("X-HamroAPI-Key", HAMRO_API_KEY)
        .get().build();

    client.newCall(request).enqueue(new Callback() {
        @Override public void onFailure(Call call, IOException e) { callback.onError(e.getMessage()); }
        @Override public void onResponse(Call call, Response response) throws IOException {
            try {
                JSONObject json = new JSONObject(response.body().string());
                if (!json.getBoolean("success")) { callback.onError(json.getString("message")); return; }
                JSONObject data = json.getJSONObject("data");
                String status = data.getString("status");
                if (status.equals("success")) callback.onSuccess(data);
                else if (status.equals("failed")) callback.onFailed(data);
                else handler.postDelayed(() -> pollOrderStatus(orderId, callback), 2500);   // still pending
            } catch (JSONException e) { callback.onError(e.getMessage()); }
        }
    });
}

public interface OrderCallback {
    void onSuccess(JSONObject data);
    void onFailed(JSONObject data);
    void onError(String message);
}` }],
      notes: [['bad', 'Only treat the purchase as paid inside <code>onSuccess</code>, which runs after <code>order-status</code> returned <code>"success"</code>. Never because the Custom Tab simply closed.']]
    },
    kotlin: {
      label: 'Kotlin (Android)', short: 'KT', name: 'HamroPayClient.kt',
      intro: 'OkHttp + coroutines: create the order, open payment_url in a Chrome Custom Tab, then suspend-poll order-status until it resolves.',
      blocks: [{ label: 'HamroPayClient.kt', code: R`class HamroPayClient(private val context: Context) {
    private val client = OkHttpClient()
    private val apiKey = "${KEY}"   // better: fetch the order from YOUR backend so the key is not in the app
    private val baseUrl = "${BASE}"
    private val json = "application/json; charset=utf-8".toMediaType()

    data class OrderResult(val orderId: String, val status: String, val amount: Double)

    suspend fun createOrder(amount: Double, title: String): OrderResult = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("hamro_api", apiKey)
            put("amount", amount)
            put("title", title)
            put("useEmbedded", true)
        }
        val request = Request.Builder()
            .url(baseUrl + "/api/developer/create-order")
            .post(body.toString().toRequestBody(json))
            .build()

        client.newCall(request).execute().use { response ->
            val res = JSONObject(response.body!!.string())
            if (!res.getBoolean("success")) throw Exception(res.getString("message"))
            val data = res.getJSONObject("data")
            openCustomTab(data.getString("payment_url"))
            pollOrderStatus(data.getString("order_id"))
        }
    }

    private fun openCustomTab(url: String) {
        CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
    }

    // Orders expire after 15 minutes: the status turns "failed", so this loop ends on its own.
    suspend fun pollOrderStatus(orderId: String): OrderResult = withContext(Dispatchers.IO) {
        while (true) {
            val request = Request.Builder()
                .url(baseUrl + "/api/developer/order-status/" + orderId)
                .header("X-HamroAPI-Key", apiKey)
                .get().build()

            client.newCall(request).execute().use { response ->
                val res = JSONObject(response.body!!.string())
                if (!res.getBoolean("success")) throw Exception(res.getString("message"))
                val data = res.getJSONObject("data")
                val status = data.getString("status")
                if (status == "success" || status == "failed") {
                    return@withContext OrderResult(orderId, status, data.getDouble("amount"))
                }
            }
            delay(2500)
        }
        @Suppress("UNREACHABLE_CODE")
        throw IllegalStateException()
    }
}

// From a coroutine scope (viewModelScope, lifecycleScope...):
// val result = hamroPayClient.createOrder(100.0, "Order #123")
// if (result.status == "success") { /* fulfil */ }` }],
      notes: [['bad', 'Only fulfil when <code>pollOrderStatus</code> itself returns <code>status == "success"</code>. That is the real confirmation, not the Custom Tab closing.']]
    },
    js: {
      label: 'JavaScript', short: 'JS', name: 'checkout.js',
      intro: 'The same widget as the HTML tab, wired from an external or bundled JS file (no inline script tags): bundlers, CMS custom-JS blocks and similar.',
      blocks: [{ label: 'checkout.js', code: R`// <script src="${BASE}/hamropay-pay.js"></script> must already be on the page

HamroPay.setCallbacks({
  onSuccess: function (order) {
    // UI signal only. Ask YOUR server to confirm with order-status before you deliver anything.
    fetch('/api/confirm-order?order_id=' + encodeURIComponent(order.order_id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.confirmed) document.getElementById('checkout-status').textContent = 'Payment confirmed!';
      });
  },
  onFailed: function () {
    document.getElementById('checkout-status').textContent = 'Payment failed.';
  },
  onTimeout: function () {
    document.getElementById('checkout-status').textContent = 'Payment timed out.';
  }
});

document.getElementById('pay-button').addEventListener('click', function () {
  HamroPay.createOrder({
    hamro_api: '${KEY}',   // for a real site, create the order on your server instead
    amount: 100,
    title: 'Order #123',
    customer_mobile: document.getElementById('phone-input').value
  });
});

// /api/confirm-order on YOUR server should call
//   GET ${BASE}/api/developer/order-status/:orderId
// with header X-HamroAPI-Key: ${KEY}
// and only answer confirmed: true when data.status === "success".` }],
      notes: [['bad', 'Even though <code>onSuccess</code> fired, treat it as a UI signal only. The server-side <code>order-status</code> check is what gates fulfilment.']]
    }
  };
  var LANGS = Object.keys(SAMPLES);

  /* ================= ERRORS ================= */
  var ERRORS = [
    { cat: 'auth', code: '401', name: 'Missing HamroAPI key', msg: 'Missing HamroAPI key...', why: 'Neither a <code>hamro_api</code> field in the body nor an <code>X-HamroAPI-Key</code> header was found. Both places are checked.', fix: 'Send the key as the <code>X-HamroAPI-Key</code> header (server calls) or as <code>hamro_api</code> in the body (widget). Check the variable is not empty at send time: usually a missing environment variable.', payload: '{ "success": false, "message": "Missing HamroAPI key. Pass it as \\"hamro_api\\" in the request body or an \\"X-HamroAPI-Key\\" header." }' },
    { cat: 'auth', code: '401', name: 'Invalid HamroAPI key', msg: 'Invalid HamroAPI key', why: 'A key was sent but it does not match any account. Usually a stale key after regenerating, a copy-paste slip (extra space or missing character), or a key from another account.', fix: 'Copy the key again from the dashboard Developer section. After regenerating, update every place that uses it. The old key stops working instantly.', payload: '{ "success": false, "message": "Invalid HamroAPI key" }' },
    { cat: 'auth', code: '403', name: 'Account suspended', msg: 'This account has been suspended.', why: 'The key is valid but the account has been suspended. This is checked on every request.', fix: 'Not fixable in code. Contact Hamro Pay support to resolve the suspension.', payload: '{ "success": false, "message": "This account has been suspended.", "banned": true }' },
    { cat: 'validation', code: '400', name: 'Validation failed', msg: 'Validation failed', why: 'A <code>create-order</code> field is invalid, most often: <b>1)</b> <code>amount</code> sent as a formatted string such as <code>"₹499"</code> or <code>"1,999"</code>, or outside ₹1 to your plan\'s maximum amount, or with more than 2 decimals; <b>2)</b> <code>customer_mobile</code> with spaces, dashes or brackets; <b>3)</b> <code>title</code> over 100 characters; <b>4)</b> <code>redirect_url</code> that is not a valid http(s) URL; <b>5)</b> <code>useEmbedded</code> that is not true/false.', fix: 'Sanitise before sending: <code>Number(String(price).replace(/[^0-9.]/g,\'\'))</code> for amount, strip non-digits from phone numbers (or omit the field). The <code>errors</code> array names each failing field.', payload: '{ "success": false, "message": "Validation failed",\n  "errors": [ { "field": "amount", "msg": "Amount must be a plain number between ₹1 and ₹200 (BASIC plan limit)" } ] }' },
    { cat: 'validation', code: '404', name: 'Order not found', msg: 'Order not found', why: 'Returned by <code>order-status</code> when the order id does not exist <b>or</b> belongs to another account. Both cases return the same message on purpose.', fix: 'Pass the exact <code>order_id</code> from create-order, unmodified, and use the same API key that created it.', payload: '{ "success": false, "message": "Order not found" }' },
    { cat: 'limits', code: '400', name: 'No payment account connected', msg: 'Please connect FamPay or Paytm account first...', why: 'Live mode needs a connected, active FamPay account to receive payments. Test mode does not.', fix: 'Connect a FamPay account in the dashboard (UPI ID + Gmail App Password), or switch to Test mode while developing.', payload: '{ "success": false, "message": "Please connect FamPay or Paytm account first to accept payments" }' },
    { cat: 'limits', code: '400', name: 'Insufficient Hamro Credits', msg: 'Insufficient Hamro Credits...', why: 'Your Hamro Credits balance is empty (Live mode). Commission is paid from credits. Plans with 0% commission (ELITE) never need credits.', fix: 'Add credits from the dashboard. Test mode does not use credits.', payload: '{ "success": false, "message": "Insufficient Hamro Credits. Please purchase more credits." }' },
    { cat: 'auth', code: '403', name: 'API not in your plan', msg: 'API access is not included in the FREE plan. Upgrade to BASIC or higher.', why: 'Your account is on the FREE plan (or a paid plan that expired and fell back to FREE). The developer API and webhooks start from the BASIC plan.', fix: 'Upgrade or renew your plan in the dashboard. The response contains <code>"code": "PLAN_API_DISABLED"</code>.', payload: '{ "success": false, "code": "PLAN_API_DISABLED",\n  "message": "API access is not included in the FREE plan. Upgrade to BASIC or higher." }' },
    { cat: 'limits', code: '429', name: 'Rate limited', msg: 'Too many API requests...', why: 'More than 60 requests in 15 minutes on this key (or IP if no key was sent), shared across create-order and order-status. Often caused by polling faster than every 2 to 3 seconds, or a retry loop without backoff.', fix: 'Poll no faster than every 2.5 seconds, add exponential backoff to retries, and wait for the window to reset (no early reset).', payload: '{ "success": false, "message": "Too many API requests. Please try again later." }' },
    { cat: 'limits', code: '429', name: 'Too many pending orders', msg: 'Too many pending orders right now...', why: 'Hamro Pay gives each waiting order a unique amount. Up to 50 orders for your account can be waiting at the same time.', fix: 'Wait a few minutes: orders free their amount when paid, cancelled or expired (15 minutes). Do not create a new order on every page refresh: reuse the one you already have.', payload: '{ "success": false, "message": "Too many pending orders right now. Please try again in a few minutes." }' },
    { cat: 'limits', code: '503', name: 'Maintenance mode', msg: 'Payment system is under maintenance.', why: 'Hamro Pay has paused new orders platform-wide. Unrelated to your account or request. Only on create-order in Live mode.', fix: 'Nothing to change in your code. Retry after a short delay.', payload: '{ "success": false, "message": "Payment system is under maintenance." }' },
    { cat: 'validation', code: 'JS', name: 'Widget: nothing happens on click', msg: 'console: "hamro_api key is required" / "amount is required"', why: 'Not an API error: it never reaches the network. The widget checks <code>hamro_api</code> and <code>amount</code> first and, if either is missing, only logs to the console. No callback fires.', fix: 'Open DevTools while testing. Confirm the object passed to <code>HamroPay.createOrder({...})</code> has non-empty values at the moment of the click.' },
    { cat: 'validation', code: 'JS', name: 'Widget: onFailed({ error })', msg: 'onFailed({ error: "network_error" })', why: 'The browser could not reach the API (offline, blocked by an ad-blocker or firewall, or the server was asleep and timed out). Other API errors arrive in the same callback with the API\'s own message in <code>error</code>.', fix: 'Show the message to the user and let them retry. If it is always <code>network_error</code>, check the Network tab for blocked requests to the API host.' }
  ];

  /* ================= TEXT BLOCKS (copy / AI prompts) ================= */
  function introText() {
    return 'HAMRO PAY API: INTEGRATION REFERENCE\n===================================\n\n' +
      'WHAT THIS IS\nHamro Pay accepts UPI payments. Your server creates an order, the customer pays the exact amount shown from any UPI app, ' +
      'Hamro Pay detects the payment automatically from the merchant\'s connected FamPay account, and you confirm the result server-side before fulfilling.\n\n' +
      'BASE URL\n' + BASE + '\n\n' +
      'AUTHENTICATION\nOne API key per merchant account (starts with "hmpay_"; Generate it in Dashboard -> Developer; paid plans only, BASIC and above). Send it either as "hamro_api" in the JSON body, or as the header X-HamroAPI-Key (legacy header x-api-key also works).\n\n' +
      'THE FLOW\n1. POST /api/developer/create-order -> returns order_id and payment_url.\n2. Send the customer to payment_url (redirect, popup or Custom Tab). They pay the exact pay_amount.\n' +
      '3. GET /api/developer/order-status/:orderId from YOUR server and confirm status === "success" before fulfilling.\n\n' +
      'GOLDEN RULE\nA customer arriving on redirect_url, or a client-side callback firing, is NEVER proof of payment. Always verify with order-status from your server.\n\n' +
      'TEST vs LIVE\nEach account has a mode (Dashboard -> Developer). In Test mode create-order returns a payment_url that opens a simulator (Success / Failed / Cancelled); no money moves and no cashier/credits are needed. order-status returns the same pending/success/failed values plus "mode":"test".';
  }
  function referenceText() {
    return 'API REFERENCE\n=============\n\n' +
      'POST ' + BASE + '/api/developer/create-order   (Content-Type: application/json)\n' +
      '  hamro_api        string   required unless X-HamroAPI-Key header is used\n' +
      '  amount           number   REQUIRED. Rs.1 up to the plan maximum (BASIC 200, STARTER 500, GROWTH 1000, BUSINESS 5000, ADVANCE 10000, ELITE unlimited), max 2 decimals. Plain number (499), NOT "Rs.499" or "1,999". Sanitise: Number(String(price).replace(/[^0-9.]/g,\'\'))\n' +
      '  title            string   optional, max 100 chars, default "Hamro Pay Payment"\n' +
      '  customer_mobile  string   optional, 10 digits, optional 91/+91/0 prefix, no spaces or dashes\n' +
      '  redirect_url     string   optional http(s) URL. Hamro Pay appends ?hp_order=<id>&hp_result=success|failed\n' +
      '  useEmbedded      boolean  optional. true for popup / in-app checkout\n' +
      'Success 201: { "success": true, "message": "Order created", "data": { "order_id": "HP1792316718001ETM0", "payment_url": "...", "amount": 100, "pay_amount": 100, "expires_at": "<ISO>", "mode": "live" } }\n' +
      'pay_amount = the exact amount the customer must pay. First pending order = amount; if another order of the same amount is waiting it becomes amount+0.01, +0.02 ... (max +0.49). The customer pays pay_amount straight to the merchant\'s own UPI; commission is deducted from the merchant\'s Hamro Credits. Orders stay payable for 15 minutes.\n\n' +
      'GET ' + BASE + '/api/developer/order-status/:orderId   (header X-HamroAPI-Key)\n' +
      'Success 200: { "success": true, "message": "Status fetched", "data": { "order_id": "...", "status": "success", "amount": 100, "pay_amount": 100, "utr": "629040332216", "mode": "live" } }\n' +
      'status is exactly one of "pending" | "success" | "failed". On failed, "reason" is "timeout" | "cancelled" | "processing_failed". "utr" only on success. Calling order-status also makes Hamro Pay check for the payment immediately.\n\n' +
      'RATE LIMIT: 60 requests / 15 minutes per API key (per IP if no key).\n\n' +
      'WEBHOOK (optional): add one or more URLs in the dashboard (Developer -> Webhooks; BASIC 5, STARTER 10, GROWTH 25, BUSINESS 50, ADVANCE/ELITE unlimited). POST JSON on success: { "event": "payment.success", "order_id", "link_id": null, "utr", "amount", "net_amount", "commission" }. Test mode sends "event": "payment.test" with "test": true. Not signed, not retried: confirm with order-status before fulfilling.';
  }
  function errorsText() {
    return 'ERROR REFERENCE\n===============\n\n' + ERRORS.map(function (e) {
      return '[' + e.code + '] ' + e.name + '\n  Message: ' + e.msg + '\n  WHY: ' + strip(e.why) + '\n  FIX: ' + strip(e.fix);
    }).join('\n\n');
  }
  function practicesText() {
    return 'BEST PRACTICES\n==============\n- Never trust a redirect or browser callback alone: confirm with order-status from your server.\n' +
      '- Create orders on your server and keep the API key out of public code.\n- Take the amount from your own database, never from the browser.\n' +
      '- Make fulfilment idempotent: fulfil each order_id only once (webhook, redirect and polling can all report the same payment).\n' +
      '- Poll no faster than every 2.5 s; stay within 60 requests / 15 min.\n- Show the customer the exact pay_amount: a different amount will not be recognised automatically.\n- Regenerate the key immediately if it leaks.';
  }
  function strip(h) { var d = document.createElement('div'); d.innerHTML = h; return d.textContent; }
  function langText(l) {
    var s = SAMPLES[l];
    return '## ' + s.label + ' integration\n\n' + strip(s.intro) + '\n\n' +
      s.blocks.map(function (b) { return '--- ' + b.label + ' ---\n' + b.code; }).join('\n\n') + '\n\n' +
      s.notes.map(function (n) { return 'NOTE: ' + strip(n[1]); }).join('\n');
  }
  function fullDoc(l) {
    var mid = l === 'all' ? LANGS.map(langText).join('\n\n') : langText(l);
    return [introText(), referenceText(), mid, errorsText(), practicesText()].join('\n\n');
  }

  function promptFor(l) {
    var s = SAMPLES[l];
    return 'You are integrating the Hamro Pay UPI payment API into an existing ' + s.label + ' codebase that I am about to give you (or have already given you). Read my existing code first and wire this into my REAL checkout flow. Do not create a disconnected demo and call it done. If something is ambiguous for my codebase, ask me ONE clarifying question first; otherwise implement the full flow.\n\n' +
      '=== NON-NEGOTIABLE RULES ===\n' +
      '1. A redirect landing, a popup closing or a client-side callback is NEVER proof of payment. The only trustworthy signal is GET /api/developer/order-status/:orderId called from the SERVER returning status === "success". Build this verification even if I did not ask.\n' +
      '2. "amount" must be a plain number (499), never a formatted string. Strip it: Number(String(price).replace(/[^0-9.]/g, "")). Take the amount from my own database/cart, never from the browser.\n' +
      '3. "customer_mobile" is optional: exactly 10 digits (optional 91/+91/0 prefix). If you cannot guarantee that, omit it.\n' +
      '4. Handle the real errors in the table below with actionable messages (validation, key problems, rate limit, no payment account, no credits, network).\n' +
      '5. Keep the API key in server-side config / environment variables where the stack allows. Never put it in a public file if a server option exists.\n' +
      '6. Fulfil each order_id only once (idempotent). Store order_id against my own order.\n' +
      '7. Before telling me you are done, re-read rules 1 to 6 against what you wrote. If unsure it works, say so and tell me what to test.\n\n' +
      referenceText() + '\n\n' +
      '=== ERROR TABLE ===\n' + ERRORS.filter(function (e) { return e.code !== 'JS'; }).map(function (e) { return e.code + ' "' + e.msg + '": ' + strip(e.fix); }).join('\n') + '\n\n' +
      '=== REFERENCE IMPLEMENTATION (' + s.label + ') ===\n' +
      s.blocks.map(function (b) { return '--- ' + b.label + ' ---\n' + b.code; }).join('\n\n') + '\n\n' +
      '=== STEPS FOR YOU ===\n1. Find my existing buy / checkout / order-creation code.\n2. Insert order creation where payment starts, using the REAL price from my data (sanitised).\n3. Add the return / callback / polling step that verifies via order-status before fulfilling.\n4. Persist order_id and its status in my existing storage if I have any.\n5. Show specific UI for failed, timed-out and pending states.\n6. Tell me which files you changed, and what to replace YOUR_HAMRO_API_KEY with (or which environment variable HAMRO_API_KEY to set).';
  }

  /* ================= ENDPOINT SAMPLES (cURL / Node / PHP / Python) ================= */
  var EP = {
    create: {
      curl: R`curl -X POST ${BASE}/api/developer/create-order \
  -H "Content-Type: application/json" \
  -d '{
    "hamro_api": "${KEY}",
    "amount": 100,
    "title": "Order #123",
    "customer_mobile": "9999999999",
    "redirect_url": "https://yoursite.com/thank-you"
  }'`,
      node: R`// Node 18+ (server side)
const res = await fetch('${BASE}/api/developer/create-order', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    hamro_api: process.env.HAMRO_API_KEY,
    amount: 100,                       // plain number, from YOUR database
    title: 'Order #123',
    redirect_url: 'https://yoursite.com/thank-you'
  })
});
const json = await res.json();
if (!json.success) throw new Error(json.message);
// save json.data.order_id against your own order, then:
// res.redirect(json.data.payment_url)`,
      php: R`<?php
$ch = curl_init('${BASE}/api/developer/create-order');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode([
    'hamro_api' => getenv('HAMRO_API_KEY'),
    'amount' => 100,
    'title' => 'Order #123',
    'redirect_url' => 'https://yoursite.com/thank-you'
  ]),
]);
$json = json_decode(curl_exec($ch), true);
curl_close($ch);
if (empty($json['success'])) { die($json['message'] ?? 'Could not create order'); }
// store $json['data']['order_id'], then:
header('Location: ' . $json['data']['payment_url']);`,
      python: R`import os, requests

r = requests.post('${BASE}/api/developer/create-order', json={
    'hamro_api': os.environ['HAMRO_API_KEY'],
    'amount': 100,
    'title': 'Order #123',
    'redirect_url': 'https://yoursite.com/thank-you',
}, timeout=15)
data = r.json()
if not data.get('success'):
    raise Exception(data.get('message'))
# save data['data']['order_id'], then redirect the customer to:
payment_url = data['data']['payment_url']`
    },
    status: {
      curl: R`curl ${BASE}/api/developer/order-status/HP1792316718001ETM0 \
  -H "X-HamroAPI-Key: ${KEY}"`,
      node: R`const res = await fetch('${BASE}/api/developer/order-status/' + encodeURIComponent(orderId), {
  headers: { 'X-HamroAPI-Key': process.env.HAMRO_API_KEY }
});
const json = await res.json();
if (json.success && json.data.status === 'success') {
  // PAID: fulfil the order (only once!)
}`,
      php: R`<?php
$ch = curl_init('${BASE}/api/developer/order-status/' . urlencode($orderId));
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['X-HamroAPI-Key: ' . getenv('HAMRO_API_KEY')],
]);
$json = json_decode(curl_exec($ch), true);
curl_close($ch);
if (!empty($json['success']) && $json['data']['status'] === 'success') {
  // PAID: fulfil the order (only once!)
}`,
      python: R`import os, requests

r = requests.get('${BASE}/api/developer/order-status/' + order_id,
                 headers={'X-HamroAPI-Key': os.environ['HAMRO_API_KEY']}, timeout=15)
j = r.json()
if j.get('success') and j['data']['status'] == 'success':
    pass  # PAID: fulfil the order (only once!)`
    },
    webhook: {
      node: R`const express = require('express');
const app = express();

app.post('/hamropay/webhook', express.json(), async (req, res) => {
  res.status(200).json({ status: 'ok' });            // reply fast; no retries are sent

  const { event, order_id } = req.body || {};
  if (event !== 'payment.success') return;

  // The webhook is not signed: confirm the payment yourself before fulfilling.
  const r = await fetch('${BASE}/api/developer/order-status/' + encodeURIComponent(order_id), {
    headers: { 'X-HamroAPI-Key': process.env.HAMRO_API_KEY }
  });
  const j = await r.json();
  if (j.success && j.data.status === 'success') {
    await fulfilOnce(order_id, j.data.utr);          // make this idempotent
  }
});`,
      php: R`<?php
// webhook.php
http_response_code(200);
header('Content-Type: application/json');
echo json_encode(['status' => 'ok']);
if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();

$body = json_decode(file_get_contents('php://input'), true);
if (($body['event'] ?? '') !== 'payment.success') exit;

// Not signed: confirm with order-status before fulfilling.
$ch = curl_init('${BASE}/api/developer/order-status/' . urlencode($body['order_id']));
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['X-HamroAPI-Key: ' . getenv('HAMRO_API_KEY')]]);
$j = json_decode(curl_exec($ch), true);
if (!empty($j['success']) && $j['data']['status'] === 'success') {
  // fulfil once (idempotent)
}`,
      python: R`import os, requests
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.post('/hamropay/webhook')
def hamropay_webhook():
    body = request.get_json(silent=True) or {}
    if body.get('event') == 'payment.success':
        # Not signed: confirm with order-status before fulfilling.
        r = requests.get('${BASE}/api/developer/order-status/' + body['order_id'],
                         headers={'X-HamroAPI-Key': os.environ['HAMRO_API_KEY']}, timeout=15)
        j = r.json()
        if j.get('success') and j['data']['status'] == 'success':
            pass  # fulfil once (idempotent)
    return jsonify(status='ok'), 200`
    }
  };
  var LANG_NAMES = { curl: 'cURL', node: 'Node.js', php: 'PHP', python: 'Python' };

  var RESP = {
    create: [
      { label: '201 Success', dot: 'ok', code: '{\n  "success": true,\n  "message": "Order created",\n  "data": {\n    "order_id": "HP1792316718001ETM0",\n    "payment_url": "https://your-hamro-frontend/pay/HP1792316718001ETM0",\n    "amount": 100,\n    "pay_amount": 100,\n    "expires_at": "2026-11-22T10:45:00.000Z",\n    "mode": "live"\n  }\n}' },
      { label: '400 Validation', dot: 'wn', code: '{\n  "success": false,\n  "message": "Validation failed",\n  "errors": [\n    { "field": "amount", "msg": "Amount must be a plain number between ₹1 and ₹200 (BASIC plan limit)" }\n  ]\n}' },
      { label: '400 Account', dot: 'wn', code: '{ "success": false, "message": "Please connect a FamPay, Amazon Pay or Paytm account first to accept payments" }\n\n// or, when credits are empty and your plan has commission:\n{ "success": false, "message": "Insufficient Hamro Credits. Please purchase more credits." }' },
      { label: '401 Key', dot: '', code: '{ "success": false, "message": "Invalid HamroAPI key" }\n\n// or when no key was sent:\n{ "success": false, "message": "Missing HamroAPI key. Pass it as \\"hamro_api\\" in the request body or an \\"X-HamroAPI-Key\\" header." }' },
      { label: '403 Plan', dot: '', code: '{\n  "success": false,\n  "code": "PLAN_API_DISABLED",\n  "message": "API access is not included in the FREE plan. Upgrade to BASIC or higher."\n}' },
      { label: '429 Limit', dot: '', code: '{ "success": false, "message": "Too many API requests. Please try again later." }' }
    ],
    status: [
      { label: 'Success', dot: 'ok', code: '{\n  "success": true,\n  "message": "Status fetched",\n  "data": {\n    "order_id": "HP1792316718001ETM0",\n    "status": "success",\n    "amount": 100,\n    "pay_amount": 100,\n    "utr": "629040332216",\n    "mode": "live"\n  }\n}' },
      { label: 'Pending', dot: 'wn', code: '{\n  "success": true,\n  "message": "Status fetched",\n  "data": {\n    "order_id": "HP1792316718001ETM0",\n    "status": "pending",\n    "amount": 100,\n    "pay_amount": 100,\n    "mode": "live"\n  }\n}' },
      { label: 'Failed', dot: '', code: '{\n  "success": true,\n  "message": "Status fetched",\n  "data": {\n    "order_id": "HP1792316718001ETM0",\n    "status": "failed",\n    "reason": "timeout",\n    "amount": 100,\n    "pay_amount": 100,\n    "mode": "live"\n  }\n}\n\n// reason: "timeout" | "cancelled" | "processing_failed"' },
      { label: '404 Not found', dot: '', code: '{ "success": false, "message": "Order not found" }' }
    ],
    webhook: [
      { label: 'payment.success', dot: 'ok', code: '{\n  "event": "payment.success",\n  "order_id": "HP1792316718001ETM0",\n  "link_id": null,\n  "utr": "629040332216",\n  "amount": 100,\n  "net_amount": 98,\n  "commission": 2\n}' },
      { label: 'payment.test', dot: 'wn', code: '{\n  "event": "payment.test",\n  "test": true,\n  "order_id": "HP1792316718001ETM0",\n  "link_id": null,\n  "utr": "TEST1792316718999",\n  "amount": 100\n}' }
    ]
  };

  /* ================= PLANS (live from /api/plans, with static fallback) ================= */
  var PLAN_FALLBACK = [
    { name: 'FREE', price: 0, max_amount: 150, commission: 5, api_orders: false, webhooks: 0 },
    { name: 'BASIC', price: 49, max_amount: 200, commission: 3.5, api_orders: true, webhooks: 5 },
    { name: 'STARTER', price: 99, max_amount: 500, commission: 3, api_orders: true, webhooks: 10 },
    { name: 'GROWTH', price: 199, max_amount: 1000, commission: 2.5, api_orders: true, webhooks: 25 },
    { name: 'BUSINESS', price: 499, max_amount: 5000, commission: 2, api_orders: true, webhooks: 50 },
    { name: 'ADVANCE', price: 699, max_amount: 10000, commission: 1, api_orders: true, webhooks: null },
    { name: 'ELITE', price: 999, max_amount: null, commission: 0, api_orders: true, webhooks: null }
  ];
  function renderPlans(list) {
    $('#planHead').innerHTML = '<tr><th>Plan</th><th>Price / 30 days</th><th>Max amount / order</th><th>Commission</th><th>API &amp; Developer portal</th><th>Webhook URLs</th></tr>';
    $('#planBody').innerHTML = list.map(function (p) {
      return '<tr><td class="l">' + esc(p.name) + '</td><td>' + (p.price ? '₹' + p.price : 'Free') + '</td><td>' + (p.max_amount === null ? 'Unlimited' : '₹' + Number(p.max_amount).toLocaleString('en-IN')) +
        '</td><td>' + p.commission + '%</td><td class="' + (p.api_orders ? 'yes' : 'no') + '">' + (p.api_orders ? '✓ Included' : '✕ Not included') + '</td><td>' + (!p.api_orders ? '<span class="no">None</span>' : p.webhooks === null ? 'Unlimited' : p.webhooks) + '</td></tr>';
    }).join('');
  }

  /* ================= RENDER ================= */
  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  $('#baseUrl').textContent = BASE;
  $$('[data-url]').forEach(function (el) { el.textContent = BASE + el.dataset.url; });
  renderPlans(PLAN_FALLBACK);
  try {
    fetch(BASE + '/api/plans').then(function (r) { return r.json(); }).then(function (j) { if (j && j.success && j.data && j.data.length) renderPlans(j.data); }).catch(function () {});
  } catch (e) {}

  // code tabs block (language switch + copy)
  function codeTabs(el, samples, langs) {
    el.innerHTML = '<div class="code-top">' + langs.map(function (l, i) { return '<button class="code-tab' + (i ? '' : ' on') + '" data-ct="' + l + '">' + LANG_NAMES[l] + '</button>'; }).join('') +
      '<span class="grow"></span><button class="cp" data-copy-pre>Copy</button></div>' +
      langs.map(function (l, i) { return '<div class="cpane' + (i ? '' : ' on') + '" data-cp="' + l + '"><pre>' + esc(samples[l]) + '</pre></div>'; }).join('');
  }
  function respTabs(el, list) {
    el.innerHTML = '<div class="code-top">' + list.map(function (r, i) { return '<button class="resp-tab' + (i ? '' : ' on') + '" data-rt="' + i + '"><i class="' + r.dot + '"></i>' + esc(r.label) + '</button>'; }).join('') +
      '<span class="grow"></span><button class="cp" data-copy-pre>Copy</button></div>' +
      list.map(function (r, i) { return '<div class="cpane' + (i ? '' : ' on') + '" data-rp="' + i + '"><pre>' + esc(r.code) + '</pre></div>'; }).join('');
  }
  var L3 = ['curl', 'node', 'php', 'python'];
  codeTabs($('#cb-create'), EP.create, L3); respTabs($('#rb-create'), RESP.create);
  codeTabs($('#cb-status'), EP.status, L3); respTabs($('#rb-status'), RESP.status);
  codeTabs($('#cb-webhook'), EP.webhook, ['node', 'php', 'python']);
  // webhook: payload tabs under receiver code
  var wp = document.createElement('div'); wp.className = 'code-block'; $('#cb-webhook').after(wp); respTabs(wp, RESP.webhook);

  var tabsEl = $('#tabs'), panesEl = $('#panes');
  LANGS.forEach(function (l, i) {
    var s = SAMPLES[l];
    var b = document.createElement('button');
    b.className = 'tab' + (i === 0 ? ' on' : ''); b.textContent = s.label; b.dataset.lang = l;
    tabsEl.appendChild(b);
    var p = document.createElement('div');
    p.className = 'pane' + (i === 0 ? ' on' : ''); p.id = 'pane-' + l;
    p.innerHTML = '<p>' + s.intro + '</p>' +
      s.blocks.map(function (bl) {
        return '<div class="cb"><div class="cbh"><span>' + esc(bl.label) + '</span><button class="cp" data-copy-self>Copy</button></div><pre>' + esc(bl.code) + '</pre></div>';
      }).join('') +
      s.notes.map(function (n) { return '<div class="callout ' + n[0] + '"><b>' + (n[0] === 'info' ? 'ℹ' : '⚠') + '</b><div>' + n[1] + '</div></div>'; }).join('') +
      '<button class="btn copyall" data-copy-lang="' + l + '">Copy full ' + esc(s.label) + ' integration guide</button>';
    panesEl.appendChild(p);
  });

  var CATS = [['all', 'All errors'], ['auth', 'Authentication'], ['validation', 'Validation'], ['limits', 'Limits & account']];
  $('#ef').innerHTML = CATS.map(function (c, i) { return '<button class="ec' + (i === 0 ? ' on' : '') + '" data-cat="' + c[0] + '">' + c[1] + '</button>'; }).join('');
  $('#errList').innerHTML = ERRORS.map(function (e) {
    var cls = e.code === 'JS' ? 'cjs' : 'c' + e.code;
    return '<div class="err" data-cat="' + e.cat + '"><div class="eh"><span class="ecode ' + cls + '">' + e.code + '</span><div class="en"><b>' + e.name + '</b><span>' + esc(e.msg) + '</span></div><span class="chev">▾</span></div>' +
      '<div class="eb">' + (e.payload ? '<div class="pl">' + esc(e.payload) + '</div>' : '') +
      '<div class="lab w">Why it happens</div><p>' + e.why + '</p><div class="lab f">How to fix</div><p>' + e.fix + '</p></div></div>';
  }).join('');

  /* ---- drawer: plugins ---- */
  var fileExt = { html: 'html', php: 'php', node: 'js', python: 'py', java: 'java', kotlin: 'kt', js: 'js' };
  $('#pluginList').innerHTML = LANGS.map(function (l) {
    var s = SAMPLES[l];
    var files = s.blocks.map(function (b, i) {
      var nm = b.label.split('/').pop();
      return '<button class="btn sm" data-dl-file="' + l + ':' + i + '">↓ ' + esc(nm) + '</button>';
    }).join('');
    return '<div class="pc"><b>' + (l === 'html' ? 'HTML Widget Kit' : s.label + ' Example') + '</b><span>' + esc(s.blocks.map(function (b) { return b.label; }).join(' + ')) + '</span>' +
      '<div class="pa" style="flex-wrap:wrap">' + '<button class="btn sm" data-go="integration" data-pick="' + l + '">View</button>' + files + (l === 'html' ? '<a class="btn sm" href="/hamropay-pay.js" download="hamropay-pay.js">↓ hamropay-pay.js</a>' : '') + '</div></div>';
  }).join('');

  /* ---- drawer: AI prompts ---- */
  $('#promptList').innerHTML = '<div class="pc"><b>Full API reference (all languages)</b><span>Reference + every code sample + error list</span><div class="pv" data-prev="__all"></div>' +
    '<div class="pa"><button class="btn primary" data-doc-copy>Copy</button><button class="btn" data-doc-dl>Download</button></div></div>' +
    LANGS.map(function (l) {
      return '<div class="pc"><b>' + SAMPLES[l].label + ' integration</b><span>' + esc(SAMPLES[l].name) + ' + full API reference + error handling</span><div class="pv" data-prev="' + l + '"></div>' +
        '<div class="pa"><button class="btn primary" data-prompt-copy="' + l + '">Copy</button><button class="btn" data-prompt-dl="' + l + '">Download</button></div></div>';
    }).join('');
  $$('[data-prev]').forEach(function (el) { var k = el.dataset.prev; el.textContent = (k === '__all' ? fullDoc('all') : promptFor(k)).slice(0, 320) + '…'; });

  /* ================= ACTIONS ================= */
  function writeClip(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, no) {
      try {
        var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); var done = document.execCommand('copy'); document.body.removeChild(ta);
        done ? ok() : no(new Error('copy failed'));
      } catch (e) { no(e); }
    });
  }
  function flash(btn, text) {
    var old = btn.innerHTML; btn.classList.add('ok'); btn.textContent = text || 'Copied';
    setTimeout(function () { btn.classList.remove('ok'); btn.innerHTML = old; }, 1600);
  }
  function copy(btn, text, label) {
    writeClip(text).then(function () { flash(btn, label); }).catch(function () { alert('Could not copy automatically. Please select and copy the text manually.'); });
  }
  function download(name, text) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function setDrawer(open, tab) {
    $('#drawer').classList.toggle('open', open); document.body.classList.toggle('drawer-open', open);
    document.body.style.overflow = open ? 'hidden' : '';
    if (tab) dtab(tab);
  }
  function dtab(name) {
    $$('.dtab').forEach(function (x) { x.classList.toggle('on', x.dataset.dtab === name); });
    $$('.dpane').forEach(function (x) { x.classList.toggle('on', x.id === 'dp-' + name); });
  }
  function go(id) { setDrawer(false); var el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('button, a, .eh');
    if (!t) return;

    if (t.matches('[data-copy-self]')) return copy(t, t.closest('.cb').querySelector('pre').textContent);
    if (t.matches('[data-copy-pre]')) return copy(t, t.closest('.code-block').querySelector('.cpane.on pre').textContent);
    if (t.matches('[data-copy-base]')) return copy(t, BASE);
    if (t.matches('[data-copy-url]')) return copy(t, t.parentElement.querySelector('.ep-url').textContent, 'Copied');
    if (t.matches('[data-copy-lang]')) return copy(t, fullDoc(t.dataset.copyLang), 'Copied: docs ready to paste');
    if (t.matches('[data-doc-copy]')) return copy(t, fullDoc('all'));
    if (t.matches('[data-doc-dl]')) return download('hamropay-api-docs.txt', fullDoc('all'));
    if (t.matches('[data-prompt-copy]')) return copy(t, promptFor(t.dataset.promptCopy));
    if (t.matches('[data-prompt-dl]')) return download('hamropay-' + t.dataset.promptDl + '-integration-prompt.txt', promptFor(t.dataset.promptDl));
    if (t.matches('[data-dl-file]')) {
      var p = t.dataset.dlFile.split(':'); var b = SAMPLES[p[0]].blocks[Number(p[1])];
      return download(b.label.split('/').pop(), b.code);
    }
    if (t.matches('[data-close]')) return setDrawer(false);
    if (t.matches('[data-dtab]')) return dtab(t.dataset.dtab);
    if (t.matches('[data-go]')) {
      if (t.dataset.pick) $$('.tab').forEach(function (x) { if (x.dataset.lang === t.dataset.pick) x.click(); });
      return go(t.dataset.go);
    }
    if (t.matches('.side a[data-t]')) return go(t.dataset.t);
    if (t.matches('.tab')) {
      $$('.tab').forEach(function (x) { x.classList.toggle('on', x === t); });
      $$('.pane').forEach(function (x) { x.classList.toggle('on', x.id === 'pane-' + t.dataset.lang); });
      return;
    }
    if (t.matches('.code-tab')) {
      var cb = t.closest('.code-block');
      $$('.code-tab', cb).forEach(function (x) { x.classList.toggle('on', x === t); });
      $$('.cpane', cb).forEach(function (x) { x.classList.toggle('on', x.dataset.cp === t.dataset.ct); });
      return;
    }
    if (t.matches('.resp-tab')) {
      var rb = t.closest('.code-block');
      $$('.resp-tab', rb).forEach(function (x) { x.classList.toggle('on', x === t); });
      $$('.cpane', rb).forEach(function (x) { x.classList.toggle('on', x.dataset.rp === t.dataset.rt); });
      return;
    }
    if (t.matches('.ec')) {
      $$('.ec').forEach(function (x) { x.classList.toggle('on', x === t); });
      $$('.err').forEach(function (x) { x.style.display = (t.dataset.cat === 'all' || x.dataset.cat === t.dataset.cat) ? '' : 'none'; });
      return;
    }
    if (t.matches('.eh')) return t.parentElement.classList.toggle('open');
  });

  $('#burger').onclick = function () { setDrawer(!$('#drawer').classList.contains('open')); };
  $('#aiBtn').onclick = function () { setDrawer(true, 'ai'); };
  $('#aiBtn2').onclick = function () { setDrawer(true, 'ai'); };
  $('#drawer').addEventListener('click', function (e) { if (e.target === this) setDrawer(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setDrawer(false); });

  /* scroll spy */
  var IDS = ['overview', 'key', 'create-order', 'order-status', 'webhooks', 'testmode', 'plans', 'integration', 'errors', 'practices'];
  function spy() {
    var cur = IDS[0];
    IDS.forEach(function (id) { var el = document.getElementById(id); if (el && el.getBoundingClientRect().top <= 130) cur = id; });
    $$('.side a[data-t]').forEach(function (a) { a.classList.toggle('on', a.dataset.t === cur); });
  }
  window.addEventListener('scroll', function () { requestAnimationFrame(spy); }, { passive: true });
  spy();

  window.__HAMRO_DOCS__ = { BASE: BASE, fullDoc: fullDoc, promptFor: promptFor, ERRORS: ERRORS, LANGS: LANGS };
})();
