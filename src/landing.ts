import { SERVER_NAME, SERVER_VERSION } from "./server.js";

/**
 * The public homepage. With OAuth in front, there is no setup form here any
 * more: the user just adds the connector URL to their MCP client and signs in
 * through the authorization flow. So this is a marketing / overview page — what
 * the connector does and how to add it — not a setup guide.
 */
export function renderHomePage(connectorUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SmartBill MCP — run your invoicing by talking to your AI</title>
<meta name="description" content="Connect Claude, ChatGPT or any MCP client to your SmartBill Cloud account and issue invoices, chase receivables and read your books in plain language.">
<style>
  :root {
    --bg:#f6f7f9; --panel:#ffffff; --fg:#16191d; --muted:#5b6470; --line:#e2e6ea;
    --accent:#1f6feb; --accent-fg:#ffffff; --code-bg:#0f1620; --code-fg:#e6edf3;
    --chip:#eef2f7; --warn-bg:#fff8e6; --warn-line:#f0d38a; --warn-fg:#6b4e00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0f1216; --panel:#171b21; --fg:#e8eaed; --muted:#9aa4b2; --line:#2a313a;
      --accent:#4c8dff; --accent-fg:#06101f; --code-bg:#0b0f14; --code-fg:#e6edf3;
      --chip:#1c222b; --warn-bg:#2a2313; --warn-line:#5c4a1a; --warn-fg:#f2d492;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:0 1rem 5rem; background:var(--bg); color:var(--fg);
    font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width:48rem; margin:0 auto; }
  .hero { padding:4rem 0 2rem; text-align:center; }
  h1 { font-size:2.4rem; line-height:1.1; margin:0 0 .6rem; letter-spacing:-.03em; }
  .tagline { color:var(--muted); font-size:1.2rem; margin:0 auto 1.5rem; max-width:34rem; }
  h2 { font-size:1.15rem; margin:2.5rem 0 .9rem; letter-spacing:-.01em; }
  p { margin:0 0 1rem; }
  a { color:var(--accent); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:.9rem; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:1.1rem 1.2rem; }
  .card h3 { margin:0 0 .35rem; font-size:1rem; }
  .card p { margin:0; color:var(--muted); font-size:.92rem; }
  ol.steps { counter-reset:step; list-style:none; padding:0; margin:0; }
  ol.steps li { position:relative; padding:.15rem 0 1rem 2.6rem; }
  ol.steps li::before { counter-increment:step; content:counter(step); position:absolute; left:0; top:0;
    width:1.8rem; height:1.8rem; border-radius:50%; background:var(--accent); color:var(--accent-fg);
    font-weight:700; font-size:.9rem; display:flex; align-items:center; justify-content:center; }
  .url { display:flex; gap:.5rem; align-items:center; background:var(--panel); border:1px solid var(--line);
    border-radius:10px; padding:.6rem .7rem; margin:.4rem 0 1.5rem; }
  .url code { flex:1; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.9rem;
    color:var(--fg); word-break:break-all; background:none; }
  button { border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg);
    font:inherit; font-weight:600; padding:.5rem .9rem; cursor:pointer; white-space:nowrap; }
  button:hover { filter:brightness(1.08); }
  .warn { background:var(--warn-bg); border:1px solid var(--warn-line); color:var(--warn-fg);
    border-radius:10px; padding:.85rem 1rem; font-size:.9rem; margin:1.5rem 0; }
  .warn p { margin:0; color:inherit; }
  footer { margin-top:3.5rem; padding-top:1rem; border-top:1px solid var(--line);
    color:var(--muted); font-size:.85rem; text-align:center; }
</style>
</head>
<body>
<main>
  <section class="hero">
    <h1>Run your invoicing by talking to your AI.</h1>
    <p class="tagline">SmartBill MCP connects Claude, ChatGPT or any MCP client to your
      <a href="https://www.smartbill.ro/" target="_blank" rel="noopener noreferrer">SmartBill Cloud</a>
      account — so you issue invoices, chase receivables and read your books in plain language.</p>
  </section>

  <h2>What you can ask it to do</h2>
  <div class="grid">
    <div class="card"><h3>Issue &amp; send documents</h3><p>Invoices and proformas, convert a proforma to an invoice, and e-mail any of them straight to the client.</p></div>
    <div class="card"><h3>Track the money</h3><p>Record payments, see how much of an invoice is collected, and pull the receivables/aging report — who owes you and for how long.</p></div>
    <div class="card"><h3>Know your customers</h3><p>List your customers and read any client's statement, ledger and outstanding balance.</p></div>
    <div class="card"><h3>Read the books</h3><p>Collections received, product-sales breakdowns, VAT rates, series and stock levels.</p></div>
    <div class="card"><h3>Fix mistakes safely</h3><p>Cancel and restore a document, issue a storno correction, or delete the last one — with the right, reversible undo for each.</p></div>
    <div class="card"><h3>Grab the PDF</h3><p>Pull the real PDF of any invoice or proforma to view or save, or read the text of a fiscal receipt.</p></div>
  </div>

  <h2>Connect it in three steps</h2>
  <ol class="steps">
    <li><strong>Copy the connector URL.</strong>
      <div class="url"><code id="url">${connectorUrl}</code><button id="copy" type="button">Copy</button></div>
    </li>
    <li><strong>Add it to your assistant.</strong> In Claude: Settings → Connectors → <em>Add custom connector</em>,
      paste the URL, and save. (No token or OAuth fields to fill — leave them empty.)</li>
    <li><strong>Authorize with SmartBill.</strong> Your assistant will send you to a SmartBill sign-in page.
      Enter your SmartBill email and password once; from then on it just works.</li>
  </ol>

  <div class="warn">
    <p>You sign in on our page over HTTPS; your credentials are stored encrypted and used only to talk to
      SmartBill on your behalf. Your assistant only ever receives a revocable access token — never your
      SmartBill password or API key. Everything issued is a real fiscal document, so your assistant is told to
      confirm client, amounts and VAT with you before issuing anything final.</p>
  </div>

  <footer>
    ${SERVER_NAME} v${SERVER_VERSION} ·
    <a href="https://github.com/bogdanripa/smartbill-mcp" target="_blank" rel="noopener noreferrer">open source on GitHub</a>
    · self-hostable
  </footer>
</main>
<script>
(function () {
  var btn = document.getElementById('copy');
  var url = document.getElementById('url');
  btn.addEventListener('click', function () {
    var text = url.textContent;
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
    else {
      var area = document.createElement('textarea');
      area.value = text; document.body.appendChild(area); area.select();
      document.execCommand('copy'); document.body.removeChild(area); done();
    }
  });
})();
</script>
</body>
</html>`;
}
