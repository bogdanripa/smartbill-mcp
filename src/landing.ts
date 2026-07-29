import { SERVER_NAME, SERVER_VERSION } from "./server.js";

/**
 * The encoder the setup page uses, kept as a standalone string so a test can
 * evaluate it and check it round-trips through decodeCredentials. If this and
 * the server's decoder ever disagree, every generated URL 401s.
 */
export const CREDENTIAL_ENCODER_JS = `function encodeCredentials(email, token, cif) {
  var raw = email + ':' + token + ':' + cif;
  var utf8 = String.fromCharCode.apply(null, new TextEncoder().encode(raw));
  return btoa(utf8).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}`;

const SMARTBILL_INTEGRATIONS_URL = "https://cloud.smartbill.ro/core/integrari/";

export function renderLandingPage(mountPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SmartBill MCP — connect your AI assistant to SmartBill</title>
<meta name="description" content="Generate the connector URL that lets Claude or ChatGPT issue invoices, proformas and payments in your SmartBill Cloud account.">
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --fg: #16191d; --muted: #5b6470;
    --line: #e2e6ea; --accent: #1f6feb; --accent-fg: #ffffff;
    --warn-bg: #fff8e6; --warn-line: #f0d38a; --warn-fg: #6b4e00;
    --code-bg: #f0f2f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --panel: #171b21; --fg: #e8eaed; --muted: #9aa4b2;
      --line: #2a313a; --accent: #4c8dff; --accent-fg: #06101f;
      --warn-bg: #2a2313; --warn-line: #5c4a1a; --warn-fg: #f2d492;
      --code-bg: #11151a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem 4rem;
    background: var(--bg); color: var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -.02em; }
  h2 { font-size: 1.05rem; margin: 2.25rem 0 .75rem; letter-spacing: -.01em; }
  p { margin: 0 0 1rem; }
  .lede { color: var(--muted); font-size: 1.05rem; margin-bottom: 1.75rem; }
  a { color: var(--accent); }
  ul { padding-left: 1.15rem; margin: 0 0 1rem; }
  li { margin-bottom: .35rem; }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 1.25rem;
  }
  label { display: block; font-weight: 600; font-size: .875rem; margin-bottom: .3rem; }
  .hint { font-weight: 400; color: var(--muted); }
  input {
    width: 100%; padding: .6rem .7rem; margin-bottom: 1rem;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 8px;
    font: inherit; font-size: .95rem;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  .row { display: flex; gap: .75rem; flex-wrap: wrap; }
  .row > div { flex: 1 1 8rem; }
  button {
    padding: .65rem 1.1rem; border: 0; border-radius: 8px;
    background: var(--accent); color: var(--accent-fg);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--line); }
  code, .url {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .85rem; background: var(--code-bg);
    border-radius: 6px; padding: .15rem .35rem;
  }
  .url {
    display: block; padding: .8rem; margin-bottom: .85rem;
    border: 1px solid var(--line); word-break: break-all; line-height: 1.5;
  }
  .warn {
    background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-fg);
    border-radius: 10px; padding: .85rem 1rem; font-size: .9rem; margin: 1.25rem 0;
  }
  .warn p:last-child, .panel p:last-child { margin-bottom: 0; }
  .error { color: #c0392b; font-size: .9rem; margin-bottom: 1rem; }
  @media (prefers-color-scheme: dark) { .error { color: #ff8a80; } }
  #result[hidden] { display: none; }
  footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
  ol { padding-left: 1.25rem; }
  ol li { margin-bottom: .5rem; }
</style>
</head>
<body>
<main>
  <h1>SmartBill MCP</h1>
  <p class="lede">
    Connect Claude, ChatGPT or any other MCP client to your
    <a href="https://www.smartbill.ro/" target="_blank" rel="noopener noreferrer">SmartBill Cloud</a>
    account, so you can issue and manage documents by asking for them in plain language.
  </p>

  <div class="panel">
    <p style="margin-bottom:.6rem"><strong>What your assistant will be able to do</strong></p>
    <ul>
      <li>Issue invoices and proformas, turn an accepted proforma into an invoice, and send either by email</li>
      <li>Record payments, and check how much of an invoice has actually been collected</li>
      <li>Cancel, restore, delete or reverse (storno) a document</li>
      <li>Read your VAT rates, document series and stock levels</li>
      <li>Download any document as a PDF</li>
    </ul>
    <p class="hint" style="font-size:.9rem">
      These act on your real books — an invoice issued here is a real fiscal document. Your assistant
      is told to confirm the client, amounts and VAT rate with you before issuing anything final.
    </p>
  </div>

  <h2>Step 1 — get your SmartBill API credentials</h2>
  <p>
    Open <a href="${SMARTBILL_INTEGRATIONS_URL}" target="_blank" rel="noopener noreferrer">cloud.smartbill.ro/core/integrari</a>
    (in SmartBill: <strong>Contul Meu → Integrari → API</strong>). That page shows the three values you need
    — <strong>Email</strong>, <strong>Token</strong> and <strong>CIF</strong> — each with a copy button next to it.
  </p>
  <p class="hint" style="font-size:.9rem">
    If the API section is missing, your plan may not include API access — SmartBill support can enable it.
    Note that issuing documents through the API draws on your plan's monthly API document allowance.
  </p>

  <h2>Step 2 — paste them here</h2>
  <div class="panel">
    <label for="email">Email <span class="hint">— the address you log into SmartBill with</span></label>
    <input id="email" type="email" placeholder="you@company.ro" autocomplete="off" spellcheck="false">

    <label for="token">Token <span class="hint">— from the API section, e.g. 003|8efc…</span></label>
    <input id="token" type="text" placeholder="003|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" autocomplete="off" spellcheck="false">

    <label for="cif">CIF <span class="hint">— your company's fiscal code</span></label>
    <input id="cif" type="text" placeholder="RO12345678" autocomplete="off" spellcheck="false">

    <label>Default series <span class="hint">— optional; leave blank to name a series on every request</span></label>
    <div class="row">
      <div><input id="invoiceSeries" type="text" placeholder="Invoice, e.g. FF" autocomplete="off" spellcheck="false"></div>
      <div><input id="estimateSeries" type="text" placeholder="Proforma, e.g. PF" autocomplete="off" spellcheck="false"></div>
      <div><input id="receiptSeries" type="text" placeholder="Receipt, e.g. CH" autocomplete="off" spellcheck="false"></div>
    </div>

    <p id="error" class="error" hidden></p>
    <button id="generate" type="button">Generate my connector URL</button>
  </div>

  <div class="warn">
    <p><strong>Nothing you type here is sent anywhere.</strong> The URL is assembled entirely in your
    browser — this page makes no network requests, and the server never receives what you paste.</p>
  </div>

  <div id="result" hidden>
    <h2>Step 3 — add it to your assistant</h2>
    <span id="url" class="url"></span>
    <p>
      <button id="copy" type="button">Copy URL</button>
      <button id="reset" type="button" class="secondary">Clear</button>
    </p>
    <p><strong>In Claude:</strong> Settings → Connectors → <em>Add custom connector</em>. Give it a name,
    paste the URL into <em>Remote MCP server URL</em>, and leave the OAuth fields empty.</p>
    <p>Then ask it something read-only first, like <em>"list my SmartBill VAT rates"</em> — that confirms
    the credentials work without touching a single document.</p>

    <div class="warn">
      <p><strong>Treat this URL like a password.</strong> It carries your API token, so anyone who has it
      can issue and delete documents on your account. Don't paste it into shared documents, tickets or chats.</p>
      <p>To revoke it, regenerate your token on the SmartBill integrations page — that invalidates every URL
      built from the old one.</p>
    </div>
  </div>

  <footer>
    <p>
      ${SERVER_NAME} v${SERVER_VERSION} ·
      <a href="https://github.com/bogdanripa/smartbill-mcp" target="_blank" rel="noopener noreferrer">source on GitHub</a>
      · open source, self-hostable
    </p>
  </footer>
</main>

<script>
(function () {
  ${CREDENTIAL_ENCODER_JS}

  var MOUNT_PATH = ${JSON.stringify(mountPath)};
  var fields = ['email', 'token', 'cif', 'invoiceSeries', 'estimateSeries', 'receiptSeries'];
  var el = {};
  fields.forEach(function (id) { el[id] = document.getElementById(id); });

  var errorEl = document.getElementById('error');
  var resultEl = document.getElementById('result');
  var urlEl = document.getElementById('url');
  var copyBtn = document.getElementById('copy');

  function fail(message, focusId) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    resultEl.hidden = true;
    if (focusId) el[focusId].focus();
  }

  function build() {
    var email = el.email.value.trim();
    var token = el.token.value.trim();
    var cif = el.cif.value.trim();

    if (!email) return fail('Enter the email you log into SmartBill with.', 'email');
    if (email.indexOf('@') < 1) return fail('That does not look like an email address.', 'email');
    if (email.indexOf(':') !== -1) return fail('An email address cannot contain a colon.', 'email');
    if (!token) return fail('Enter your SmartBill API token.', 'token');
    if (!cif) return fail('Enter your company CIF, e.g. RO12345678.', 'cif');
    if (cif.indexOf(':') !== -1) return fail('A CIF cannot contain a colon.', 'cif');

    errorEl.hidden = true;

    var url = location.origin + MOUNT_PATH + '/' + encodeCredentials(email, token, cif);
    var params = [];
    [['invoiceSeries', el.invoiceSeries], ['estimateSeries', el.estimateSeries],
     ['receiptSeries', el.receiptSeries]].forEach(function (pair) {
      var value = pair[1].value.trim();
      if (value) params.push(pair[0] + '=' + encodeURIComponent(value));
    });
    if (params.length) url += '?' + params.join('&');

    urlEl.textContent = url;
    resultEl.hidden = false;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  document.getElementById('generate').addEventListener('click', build);

  document.querySelector('main').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); build(); }
  });

  copyBtn.addEventListener('click', function () {
    var text = urlEl.textContent;
    var done = function () {
      copyBtn.textContent = 'Copied';
      setTimeout(function () { copyBtn.textContent = 'Copy URL'; }, 1500);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
    else {
      var area = document.createElement('textarea');
      area.value = text; document.body.appendChild(area); area.select();
      document.execCommand('copy'); document.body.removeChild(area); done();
    }
  });

  document.getElementById('reset').addEventListener('click', function () {
    fields.forEach(function (id) { el[id].value = ''; });
    urlEl.textContent = '';
    resultEl.hidden = true;
    errorEl.hidden = true;
    el.email.focus();
  });
})();
</script>
</body>
</html>
`;
}
