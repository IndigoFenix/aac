// server/dev/browser-test-page.ts
//
// A self-hosted, embed-friendly test page for the AAC in-app browser
// (BrowserApp / Electron <webview>). Served from our own origin so we can
// verify the launch → browser → interaction chain (render, click, type,
// scroll, subpage navigation) WITHOUT depending on a third-party site's
// X-Frame-Options / CSP or its handling of synthetic gaze events.
//
// Public, unauthenticated, holds NO PHI and talks to no backend — every
// interaction is client-side JS. Add the served URL to a student's
// aacSettings.permittedWebsites, then have the AI open it (or press a
// launch button) to exercise the browser app.
//
// Two pages so the permitted-subpage rule + in-frame navigation are
// testable: `/browser-test` (page 1) links to `/browser-test/page2`, which
// is a subpage of the permitted prefix and links back.

interface TestPageOptions {
  /** 1 or 2 — which page to render. */
  page: 1 | 2;
  /** Absolute path this page is served at (for the "you are here" readout). */
  selfPath: string;
  /** Path of the other page, for the navigation link. */
  otherPath: string;
}

/** Render the interactive browser-test HTML. Fully self-contained (inline
 *  CSS + JS, no external assets) so it renders identically inside a sandboxed
 *  iframe or a webview. */
export function renderBrowserTestPage(opts: TestPageOptions): string {
  const { page, selfPath, otherPath } = opts;
  const accent = page === 1 ? "#0d9488" /* teal */ : "#7c3aed" /* violet */;
  const title = `AAC Browser Test — Page ${page}`;
  const otherLabel = page === 1 ? "Go to Page 2 →" : "← Back to Page 1";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { --accent: ${accent}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f8fafc; color: #0f172a; line-height: 1.5;
    padding: 16px 16px 120px;
  }
  h1 { font-size: 28px; margin: 0 0 4px; color: var(--accent); }
  h2 { font-size: 20px; margin: 0 0 12px; }
  .card {
    background: #fff; border: 3px solid #e2e8f0; border-radius: 16px;
    padding: 20px; margin: 0 0 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .card.accent { border-color: var(--accent); }
  /* Big, high-contrast, gaze/touch-friendly controls */
  button, .linkbtn {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 72px; min-width: 120px; padding: 12px 24px; margin: 6px;
    font-size: 22px; font-weight: 700; border-radius: 14px; cursor: pointer;
    border: 3px solid var(--accent); background: #fff; color: var(--accent);
    text-decoration: none; user-select: none; transition: transform .08s;
  }
  button:active, .linkbtn:active { transform: scale(0.96); }
  button.solid { background: var(--accent); color: #fff; }
  .readout {
    font-size: 40px; font-weight: 800; text-align: center;
    padding: 12px; color: var(--accent);
  }
  .pill {
    display: inline-block; padding: 6px 14px; border-radius: 999px;
    background: #ecfeff; color: var(--accent); font-weight: 700;
    font-size: 16px; border: 2px solid var(--accent);
  }
  input[type=text] {
    width: 100%; font-size: 24px; padding: 16px; border-radius: 14px;
    border: 3px solid #cbd5e1;
  }
  .echo { font-size: 24px; font-weight: 700; margin-top: 12px; min-height: 32px; }
  .colorgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .colorbtn { min-height: 96px; font-size: 20px; border-width: 4px; }
  .filler-row {
    padding: 18px; margin: 8px 0; border-radius: 12px; background: #eef2ff;
    font-size: 20px; font-weight: 600;
  }
  /* Fixed HUD so scroll position + last event are visible without devtools */
  #hud {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
    background: rgba(15,23,42,0.92); color: #e2e8f0; padding: 10px 16px;
    font-size: 15px; display: flex; gap: 18px; flex-wrap: wrap;
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  #hud b { color: #5eead4; }
</style>
</head>
<body>
  <h1>${title}</h1>
  <p><span class="pill" id="url-readout">loading…</span></p>

  <div class="card accent">
    <h2>1 · Tap / click</h2>
    <div class="readout" id="counter">0</div>
    <div style="text-align:center">
      <button class="solid" id="btn-inc" data-dwell>+1</button>
      <button id="btn-reset" data-dwell>Reset</button>
    </div>
    <div class="colorgrid" style="margin-top:16px">
      <button class="colorbtn" data-color="Red" data-dwell>Red</button>
      <button class="colorbtn" data-color="Green" data-dwell>Green</button>
      <button class="colorbtn" data-color="Blue" data-dwell>Blue</button>
      <button class="colorbtn" data-color="Yellow" data-dwell>Yellow</button>
    </div>
    <div class="echo" id="last-color">Last picked: —</div>
  </div>

  <div class="card">
    <h2>2 · Type</h2>
    <input type="text" id="typebox" placeholder="Type here to test the keyboard…" data-dwell />
    <div class="echo" id="type-echo">You typed: —</div>
    <div style="text-align:center"><button id="btn-clear" data-dwell>Clear</button></div>
  </div>

  <div class="card">
    <h2>3 · Scroll</h2>
    <p>Scroll down through the rows — the bar at the bottom shows your scroll position.</p>
    <div style="text-align:center">
      <button id="btn-bottom" data-dwell>Jump to bottom ↓</button>
      <button id="btn-top" data-dwell>Jump to top ↑</button>
    </div>
    <div id="filler"></div>
  </div>

  <div class="card accent">
    <h2>4 · Navigate (subpage)</h2>
    <p>This link stays inside the permitted site (a subpage of the same prefix).</p>
    <a class="linkbtn" href="${otherPath}" data-dwell>${otherLabel}</a>
  </div>

  <div id="hud">
    <span>scroll: <b id="hud-scroll">0%</b></span>
    <span>taps: <b id="hud-taps">0</b></span>
    <span>last: <b id="hud-last">—</b></span>
  </div>

<script>
(function () {
  var taps = 0, count = 0;
  var $ = function (id) { return document.getElementById(id); };
  function logEvent(label) {
    taps++;
    $("hud-taps").textContent = String(taps);
    $("hud-last").textContent = label;
  }

  $("url-readout").textContent = location.pathname + " · Page ${page}";

  $("btn-inc").addEventListener("click", function () {
    count++; $("counter").textContent = String(count); logEvent("+1 (=" + count + ")");
  });
  $("btn-reset").addEventListener("click", function () {
    count = 0; $("counter").textContent = "0"; logEvent("reset");
  });

  var colorBtns = document.querySelectorAll("[data-color]");
  for (var i = 0; i < colorBtns.length; i++) {
    colorBtns[i].addEventListener("click", function (e) {
      var c = e.currentTarget.getAttribute("data-color");
      $("last-color").textContent = "Last picked: " + c;
      logEvent("color:" + c);
    });
  }

  $("typebox").addEventListener("input", function (e) {
    var v = e.target.value;
    $("type-echo").textContent = v ? "You typed: " + v : "You typed: —";
    logEvent("type(" + v.length + ")");
  });
  $("btn-clear").addEventListener("click", function () {
    $("typebox").value = ""; $("type-echo").textContent = "You typed: —"; logEvent("clear");
  });

  // Tall filler for the scroll test.
  var filler = $("filler");
  for (var r = 1; r <= 30; r++) {
    var row = document.createElement("div");
    row.className = "filler-row";
    row.textContent = "Row " + r + " of 30 — keep scrolling…";
    filler.appendChild(row);
  }
  $("btn-bottom").addEventListener("click", function () {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); logEvent("jump-bottom");
  });
  $("btn-top").addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" }); logEvent("jump-top");
  });

  function onScroll() {
    var max = document.body.scrollHeight - window.innerHeight;
    var pct = max > 0 ? Math.round((window.scrollY / max) * 100) : 0;
    $("hud-scroll").textContent = pct + "%";
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();
</script>
</body>
</html>`;
}
