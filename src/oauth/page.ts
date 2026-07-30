// The /authorize consent screen: the user signs in with their SmartBill email
// and password. It carries the OAuth request parameters through as hidden fields
// and POSTs them, with the credentials, back to /authorize. No third-party
// subresources; the credentials only ever go to this server.

const FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface AuthorizePageOptions {
  /** OAuth request parameters to preserve across the POST, as raw strings. */
  params: Record<string, string | undefined>;
  /** The requesting client's display name, if it registered one. */
  clientName?: string;
  /** An error to show above the form (e.g. wrong credentials). */
  error?: string;
}

export function renderAuthorizePage({ params, clientName, error }: AuthorizePageOptions): string {
  const hidden = FIELDS.map((name) => {
    const value = params[name];
    return value === undefined ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  }).join("\n    ");

  const who = clientName ? `<strong>${escapeHtml(clientName)}</strong>` : "an application";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect SmartBill</title>
<style>
  :root {
    --bg:#f6f7f9; --panel:#fff; --fg:#16191d; --muted:#5b6470; --line:#e2e6ea;
    --accent:#1f6feb; --accent-fg:#fff; --warn-bg:#fff8e6; --warn-line:#f0d38a; --warn-fg:#6b4e00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0f1216; --panel:#171b21; --fg:#e8eaed; --muted:#9aa4b2; --line:#2a313a;
      --accent:#4c8dff; --accent-fg:#06101f; --warn-bg:#2a2313; --warn-line:#5c4a1a; --warn-fg:#f2d492;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:2.5rem 1rem 4rem; background:var(--bg); color:var(--fg);
    font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width:26rem; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .35rem; letter-spacing:-.01em; }
  p { margin:0 0 1rem; color:var(--muted); font-size:.95rem; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:1.25rem; }
  label { display:block; font-weight:600; font-size:.85rem; margin-bottom:.3rem; }
  input[type=email], input[type=password] {
    width:100%; padding:.6rem .7rem; margin-bottom:1rem; background:var(--bg); color:var(--fg);
    border:1px solid var(--line); border-radius:8px; font:inherit; font-size:.95rem; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  button { width:100%; padding:.7rem 1.1rem; border:0; border-radius:8px; background:var(--accent);
    color:var(--accent-fg); font:inherit; font-weight:600; cursor:pointer;
    display:inline-flex; align-items:center; justify-content:center; gap:.5em; }
  button:hover { filter:brightness(1.08); }
  button.loading { opacity:.75; cursor:default; }
  button[disabled] { cursor:default; }
  .spin { display:none; width:1em; height:1em; border:2px solid currentColor; border-right-color:transparent;
    border-radius:50%; animation:spin .6s linear infinite; }
  button.loading .spin { display:inline-block; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .error { background:#fdecea; border:1px solid #f5c6cb; color:#a12; border-radius:8px;
    padding:.6rem .8rem; font-size:.9rem; margin-bottom:1rem; }
  @media (prefers-color-scheme: dark) { .error { background:#3a1d1d; border-color:#5c2a2a; color:#ff9b93; } }
  .warn { background:var(--warn-bg); border:1px solid var(--warn-line); color:var(--warn-fg);
    border-radius:10px; padding:.75rem .9rem; font-size:.85rem; margin-top:1.25rem; }
  .warn p { margin:0; color:inherit; }
</style>
</head>
<body>
<main>
  <h1>Connect your SmartBill account</h1>
  <p>${who} is asking to access your SmartBill Cloud account. Sign in to authorize it.</p>
  <div class="panel">
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/authorize">
    ${hidden}
      <label for="email">SmartBill email</label>
      <input id="email" name="email" type="email" placeholder="you@company.ro" autocomplete="username" required spellcheck="false">
      <label for="password">SmartBill password</label>
      <input id="password" name="password" type="password" placeholder="••••••••" autocomplete="current-password" required>
      <button id="authorize" type="submit"><span class="spin" aria-hidden="true"></span><span class="label">Authorize</span></button>
    </form>
  </div>
  <script>
  (function () {
    var form = document.querySelector('form');
    var btn = document.getElementById('authorize');
    form.addEventListener('submit', function () {
      // The submit is already in flight; reflect it and block a double-click.
      btn.classList.add('loading');
      var label = btn.querySelector('.label');
      if (label) label.textContent = 'Signing in…';
      setTimeout(function () { btn.disabled = true; }, 0);
    });
  })();
  </script>
  <div class="warn">
    <p>Your email and password are sent over HTTPS only to this server, used to sign in to SmartBill, and stored
    encrypted so the connection keeps working. The application never sees them.</p>
  </div>
</main>
</body>
</html>`;
}
