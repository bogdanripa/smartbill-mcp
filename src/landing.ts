import { SERVER_NAME, SERVER_VERSION } from "./server.js";

/**
 * The setup page. The user enters their SmartBill email and password; the page
 * POSTs them to /setup, where the server logs in, reads the scoped API token and
 * CIF from the account, stores the tenant, and returns the connector URL. The
 * password is sent over HTTPS and stored encrypted so the session can be renewed
 * automatically — it is only ever used to talk to SmartBill.
 */
export function renderLandingPage(mountPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SmartBill MCP — connect your AI assistant to SmartBill</title>
<meta name="description" content="Connect Claude or ChatGPT to your SmartBill Cloud account to issue invoices and read your receivables in plain language.">
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
  button {
    padding: .65rem 1.1rem; border: 0; border-radius: 8px;
    background: var(--accent); color: var(--accent-fg);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: .6; cursor: default; }
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
</style>
</head>
<body>
<main>
  <h1>SmartBill MCP</h1>
  <p class="lede">
    Connect Claude, ChatGPT or any other MCP client to your
    <a href="https://www.smartbill.ro/" target="_blank" rel="noopener noreferrer">SmartBill Cloud</a>
    account, so you can issue documents and read your books by asking in plain language.
  </p>

  <div class="panel">
    <p style="margin-bottom:.6rem"><strong>What your assistant will be able to do</strong></p>
    <ul>
      <li>Issue invoices and proformas, convert a proforma to an invoice, and email either</li>
      <li>Record payments and check how much of an invoice has been collected</li>
      <li>Cancel, restore, delete or reverse (storno) a document; download any document as a PDF</li>
      <li>List your customers and read a client's statement, ledger and balance</li>
      <li>See receivables with aging and status, collections received, and product sales</li>
    </ul>
    <p class="hint" style="font-size:.9rem">
      These act on your real books — an invoice issued here is a real fiscal document. Your assistant
      is told to confirm the client, amounts and VAT rate with you before issuing anything final.
    </p>
  </div>

  <h2>Connect your account</h2>
  <div class="panel">
    <label for="email">SmartBill email <span class="hint">— the address you log in with</span></label>
    <input id="email" type="email" placeholder="you@company.ro" autocomplete="username" spellcheck="false">

    <label for="password">SmartBill password</label>
    <input id="password" type="password" placeholder="••••••••" autocomplete="current-password">

    <p id="error" class="error" hidden></p>
    <button id="connect" type="button">Connect SmartBill</button>
  </div>

  <div class="warn">
    <p>Your email and password are sent over HTTPS to sign you in, and stored <strong>encrypted</strong>
    so the connection keeps working when the session expires. They are used only to talk to SmartBill on
    your behalf, and never shown back to you or logged.</p>
  </div>

  <div id="result" hidden>
    <h2>Add it to your assistant</h2>
    <span id="url" class="url"></span>
    <p>
      <button id="copy" type="button">Copy URL</button>
      <button id="reset" type="button" class="secondary">Start over</button>
    </p>
    <p><strong>In Claude:</strong> Settings → Connectors → <em>Add custom connector</em>. Give it a name,
    paste the URL into <em>Remote MCP server URL</em>, and leave the OAuth fields empty.</p>
    <p>Then ask something read-only first, like <em>"list my SmartBill customers"</em> — that confirms the
    connection without touching a single document.</p>

    <div class="warn">
      <p><strong>Treat this URL like a password.</strong> It carries your API token, so anyone who has it
      can issue and delete documents on your account. Don't paste it into shared documents, tickets or chats.</p>
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
  var MOUNT_PATH = ${JSON.stringify(mountPath)};
  var emailEl = document.getElementById('email');
  var passwordEl = document.getElementById('password');
  var errorEl = document.getElementById('error');
  var resultEl = document.getElementById('result');
  var urlEl = document.getElementById('url');
  var connectBtn = document.getElementById('connect');
  var copyBtn = document.getElementById('copy');

  function fail(message, focusEl) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    resultEl.hidden = true;
    if (focusEl) focusEl.focus();
  }

  async function connect() {
    var email = emailEl.value.trim();
    var password = passwordEl.value;
    if (!email || email.indexOf('@') < 1) return fail('Enter the email you log into SmartBill with.', emailEl);
    if (!password) return fail('Enter your SmartBill password.', passwordEl);

    errorEl.hidden = true;
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    try {
      var resp = await fetch('/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        return fail(data.message || 'Could not connect. Check your email and password and try again.', passwordEl);
      }
      urlEl.textContent = location.origin + data.url;
      resultEl.hidden = false;
      passwordEl.value = '';
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      fail('Could not reach the server. Try again.');
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect SmartBill';
    }
  }

  connectBtn.addEventListener('click', connect);
  document.querySelector('main').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); connect(); }
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
    emailEl.value = ''; passwordEl.value = '';
    urlEl.textContent = '';
    resultEl.hidden = true;
    errorEl.hidden = true;
    emailEl.focus();
  });
})();
</script>
</body>
</html>`;
}
