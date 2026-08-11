// The dashboard. One self-contained page — no build step, no dependencies, no
// network fetches — because a tool that operates your machine should not need a
// toolchain to show you what it is doing.
//
// The face is the point. Every expression maps to a real state in face.mjs, so
// the drawing is a rendering of the state machine rather than decoration: if
// Woboo is squinting, a verify command is genuinely running right now.

import { FACES, faceSvg, faceColor, FACE_CSS, VIEWBOX } from './faceart.mjs';

// The ten faces, rendered once here and embedded as markup. Same trick the
// desktop widget uses: the geometry lives in exactly one module, and the client
// only ever looks up and draws. Nothing to keep in sync, nothing to drift.
const ART = JSON.stringify(
  Object.fromEntries(Object.keys(FACES).map((state) => [state, { svg: faceSvg(state), color: faceColor(state) }])),
);

export function page({ key }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="woboo-key" content="${key}">
<title>Woboo</title>
<style>
  :root {
    --bg: #08080B;
    --panel: #0C0C11;
    --line: rgba(255,255,255,.09);
    --ink: #FFFFFF;
    --dim: rgba(255,255,255,.56);
    --fc: #FFB55C;
    --warn: #FF9264;
    --bad: #FF5A3D;
    --ok: #7FD1A0;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    height: 100vh; overflow: hidden;
  }
  .shell { display: flex; flex-direction: column; height: 100vh; }

  header {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 0 152px 0 14px; min-height: 38px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #12100F 0%, var(--panel) 100%);
    /* In the desktop console the native title bar is hidden and this header
       stands in for it. A plain browser ignores the rule. */
    -webkit-app-region: drag;
  }
  header button, header .tag, header input { -webkit-app-region: no-drag; }

  /* The mark: the same face the widget and the tray wear, at header size. */
  .mark {
    width: 26px; height: 21px; flex: none; border-radius: 6px; position: relative;
    background: linear-gradient(158deg, #1A1512 0%, #0D0A09 70%);
    box-shadow: inset 0 0 0 1px var(--fc), 0 0 12px -4px var(--fc);
    transition: box-shadow .5s ease;
  }
  .mark i {
    position: absolute; top: 6px; left: 6px; width: 4px; height: 8px;
    border-radius: 2px; background: var(--fc); box-shadow: 0 0 6px -1px var(--fc);
  }
  .mark i::after {
    content: ''; position: absolute; left: 10px; top: 0; width: 4px; height: 8px;
    border-radius: 2px; background: var(--fc);
  }
  .mark b {
    position: absolute; left: 8px; bottom: 4px; width: 10px; height: 2px;
    border-radius: 2px; background: var(--fc);
  }

  .brand {
    font-weight: 700; letter-spacing: 5px; text-indent: 5px;
    color: #FFFFFF; font-size: 13px;
  }
  .tag {
    font-size: 11px; color: var(--dim); border: 1px solid var(--line);
    padding: 2px 7px; border-radius: 3px; white-space: nowrap;
  }
  .tag b { color: var(--ink); font-weight: 500; }
  .spacer { flex: 1; }
  .live { color: var(--ok); }
  .dead { color: var(--bad); }

  main { flex: 1; display: grid; grid-template-columns: 300px 1fr; min-height: 0; }
  @media (max-width: 820px) { main { grid-template-columns: 1fr; } }

  .col-face {
    border-right: 1px solid var(--line); padding: 14px;
    display: flex; flex-direction: column; gap: 10px; overflow: auto;
  }
  /* The same chassis the desktop companion wears, so the console and the widget
     are recognisably one character rather than two skins. */
  .crt {
    position: relative; aspect-ratio: 1; width: 100%;
    background: url('/assets/woboo.png') center/contain no-repeat;
    animation: bob 6s ease-in-out infinite;
  }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }

  /* The warm halo the character sits in on the site. */
  .crt::before {
    content: ''; position: absolute; left: 50%; top: 52%; transform: translate(-50%, -50%);
    width: 120%; aspect-ratio: 1; border-radius: 50%; z-index: -1;
    background: radial-gradient(circle, var(--fc), transparent 62%);
    opacity: .2; filter: blur(14px); transition: background .5s ease;
  }
  /* The bulb, lit in whatever Woboo is currently feeling. */
  .antenna {
    position: absolute; top: 12.5%; left: 50%; transform: translateX(-50%);
    width: 8.5%; aspect-ratio: 1; border-radius: 50%; pointer-events: none;
    background: radial-gradient(circle at 36% 32%, #FFF1DC, var(--fc) 52%, #FF6B3D 100%);
    box-shadow: 0 0 16px var(--fc), 0 0 36px -6px #FF6B3D;
    animation: breathe 3.2s ease-in-out infinite; mix-blend-mode: screen;
  }
  @keyframes breathe { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }

  /* The dark glass on the render's own face, where the live dots are drawn. */
  .glass { position: absolute; left: 34%; top: 34%; width: 32%; height: 19%; }
  .vent { display: none; }
  #face { display: block; width: 100%; height: 100%; }
${FACE_CSS}
  .state-line { text-align: center; }
  .state-line b { color: var(--fc); text-transform: uppercase; letter-spacing: 2px; }
  .state-line span { display: block; color: var(--dim); font-size: 11px; min-height: 16px; }

  button {
    font: inherit; cursor: pointer; border-radius: 4px; border: 1px solid var(--line);
    background: rgba(255,255,255,.06); color: var(--ink); padding: 7px 10px;
  }
  button:hover:not(:disabled) { border-color: var(--fc); color: var(--fc); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .stop {
    background: rgba(255,90,61,.16); border-color: rgba(255,90,61,.5); color: #FFB0A0;
    font-weight: 700; letter-spacing: 3px; padding: 13px;
  }
  .stop:hover:not(:disabled) { background: rgba(255,90,61,.28); border-color: var(--bad); color: #fff; }
  .resume { background: rgba(127,209,160,.14); border-color: rgba(127,209,160,.45); color: #A8E6C0; letter-spacing: 1px; padding: 11px; }
  .mini { display: flex; gap: 8px; }
  .mini button { flex: 1; font-size: 11px; }
  .hidden { display: none !important; }

  #shot-wrap { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  #shot { display: block; width: 100%; }

  .col-work { display: grid; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); min-height: 0; }
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); }
  .tab { padding: 6px 14px; font-size: 11px; letter-spacing: 2px; color: var(--dim); cursor: pointer; border-bottom: 2px solid transparent; background: none; border-top: none; border-left: none; border-right: none; border-radius: 0; }
  .tab:hover { color: var(--ink); }
  .tab.active { color: var(--fc); border-bottom-color: var(--fc); }
  .tab:focus-visible { outline: 2px solid var(--fc); outline-offset: -2px; }
  .cost-tag { font-size: 10px; color: var(--dim); }
  .cost-tag b { color: var(--fc); }
  .history-item { padding: 8px 0; border-bottom: 1px solid var(--line); cursor: pointer; }
  .history-item:hover { background: rgba(255,255,255,.03); }
  .history-item .hi-task { color: var(--ink); font-size: 12px; }
  .history-item .hi-meta { color: var(--dim); font-size: 10px; margin-top: 2px; }
  .history-item .hi-state { font-size: 10px; padding: 1px 5px; border-radius: 3px; border: 1px solid var(--line); margin-left: 6px; }
  .history-item .hi-state.done { color: var(--ok); border-color: rgba(127,209,160,.3); }
  .history-item .hi-state.failed { color: var(--bad); border-color: rgba(255,90,61,.3); }
  .settings-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
  .settings-row label { color: var(--dim); font-size: 11px; min-width: 120px; }
  .settings-row input, .settings-row select { font: inherit; background: rgba(0,0,0,.36); color: var(--ink); border: 1px solid var(--line); border-radius: 4px; padding: 5px 8px; }
  .settings-row input:focus, .settings-row select:focus { outline: none; border-color: var(--fc); }
  .template-chip { display: inline-block; padding: 4px 10px; border: 1px solid var(--line); border-radius: 12px; font-size: 11px; color: var(--dim); cursor: pointer; margin: 2px 4px 2px 0; }
  .template-chip:hover { border-color: var(--fc); color: var(--ink); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .panel { display: flex; flex-direction: column; min-height: 0; padding: 12px 14px; }
  .panel + .panel { border-top: 1px solid var(--line); }
  .panel h2 {
    margin: 0 0 8px; font-size: 11px; letter-spacing: 3px; color: var(--dim); font-weight: 500;
  }
  .panel > div { overflow: auto; min-height: 0; flex: 1; }

  .summary { color: var(--dim); margin-bottom: 10px; }
  .summary b { color: var(--ink); font-weight: 500; }
  .badge { font-size: 10px; border: 1px solid var(--line); padding: 1px 5px; border-radius: 3px; margin-left: 6px; }

  .step { border-left: 2px solid var(--line); padding: 5px 0 5px 10px; margin-bottom: 4px; }
  .step-head { display: flex; gap: 8px; align-items: baseline; }
  .step-title { flex: 1; }
  .step-meta { color: var(--dim); font-size: 11px; white-space: nowrap; }
  .step.ok { border-left-color: var(--ok); }
  .step.failed { border-left-color: var(--bad); }
  .step.running, .step.verifying { border-left-color: var(--warn); }
  .glyph { width: 12px; text-align: center; }
  .step.ok .glyph { color: var(--ok); }
  .step.failed .glyph { color: var(--bad); }
  .step.running .glyph, .step.verifying .glyph { color: var(--warn); }
  .step.pending { opacity: .5; }
  .kind { color: var(--dim); font-size: 10px; text-transform: uppercase; }
  details { margin-top: 5px; }
  summary { color: var(--dim); font-size: 11px; cursor: pointer; }
  pre {
    margin: 5px 0 0; padding: 7px; background: rgba(0,0,0,.36); border: 1px solid var(--line);
    border-radius: 4px; max-height: 200px; overflow: auto; white-space: pre-wrap;
    word-break: break-word; font-size: 11px; color: var(--dim);
  }
  .empty { color: var(--dim); }

  .line { display: flex; gap: 8px; white-space: pre-wrap; word-break: break-word; }
  .line time { color: rgba(255,255,255,.32); flex: none; }
  .line .kind-col { color: var(--dim); flex: none; width: 68px; }
  .line.ok .msg { color: var(--ok); }
  .line.warn .msg { color: var(--warn); }
  .line.error .msg { color: var(--bad); }

  footer {
    display: flex; gap: 8px; align-items: center; padding: 10px 14px;
    border-top: 1px solid var(--line); background: var(--panel);
  }
  .prompt { color: var(--fc); }
  #task {
    flex: 1; font: inherit; background: rgba(0,0,0,.36); color: var(--ink);
    border: 1px solid var(--line); border-radius: 4px; padding: 8px 10px;
  }
  #task:focus { outline: none; border-color: var(--fc); }

  .modal {
    position: fixed; inset: 0; background: rgba(4,7,6,.82);
    display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 20;
  }
  .card {
    background: var(--panel); border: 1px solid var(--warn); border-radius: 8px;
    padding: 18px; max-width: 560px; width: 100%;
  }
  .card h3 { margin: 0 0 4px; color: var(--warn); font-size: 13px; letter-spacing: 2px; }
  .card .why { color: var(--dim); font-size: 11px; margin-bottom: 10px; }
  .card .row { display: flex; gap: 10px; margin-top: 14px; }
  .card .row button { flex: 1; padding: 10px; }
  .allow { border-color: rgba(127,209,160,.45); color: #A8E6C0; }
  .deny { border-color: rgba(255,90,61,.5); color: #FFB0A0; }
  .toast {
    position: fixed; bottom: 66px; left: 50%; transform: translateX(-50%);
    background: var(--panel); border: 1px solid var(--bad); color: #FFB0A0;
    padding: 8px 14px; border-radius: 4px; z-index: 30; max-width: 80vw;
  }
</style>

<div class="shell">
  <header>
    <span class="mark" aria-hidden="true"><i></i><b></b></span>
    <span class="brand">WOBOO</span>
    <span class="tag" id="tag-brain">brain <b>…</b></span>
    <span class="tag" id="tag-crew">crew <b>…</b></span>
    <span class="tag" id="tag-hands">hands <b>…</b></span>
    <span class="tag" id="tag-ws">workspace <b>…</b></span>
    <span class="cost-tag" id="tag-cost">cost <b>$0.00</b></span>
    <span class="spacer"></span>
    <span class="tag" id="tag-link">connecting…</span>
  </header>

  <main>
    <section class="col-face">
      <div class="crt" id="crt" data-face="idle">
        <div class="antenna"></div>
        <div class="vent l"></div>
        <div class="vent r"></div>
        <div class="glass"><svg id="face" viewBox="${VIEWBOX}" role="img" aria-label="Woboo's face"></svg></div>
      </div>
      <div class="state-line">
        <b id="face-state">idle</b>
        <span id="face-note"></span>
      </div>
      <button class="stop" id="btn-stop" aria-label="Stop current mission">STOP</button>
      <button class="resume hidden" id="btn-resume" aria-label="Resume after stop">RELEASE STOP</button>
      <div class="mini">
        <button id="btn-look">LOOK</button>
        <button id="btn-selftest">SELF-TEST</button>
      </div>
      <div class="hidden" id="shot-wrap">
        <img id="shot" alt="the screen as Woboo last saw it">
      </div>
    </section>

    <section class="col-work">
      <div class="panel" id="panel-top">
        <div class="tabs" role="tablist" aria-label="Work panels">
          <button class="tab active" role="tab" aria-selected="true" aria-controls="mission" id="tab-mission" data-panel="mission">MISSION</button>
          <button class="tab" role="tab" aria-selected="false" aria-controls="history" id="tab-history" data-panel="history">HISTORY</button>
          <button class="tab" role="tab" aria-selected="false" aria-controls="settings" id="tab-settings" data-panel="settings">SETTINGS</button>
          <button class="tab" role="tab" aria-selected="false" aria-controls="analytics" id="tab-analytics" data-panel="analytics">ANALYTICS</button>
        </div>
        <div id="mission" role="tabpanel" aria-labelledby="tab-mission"><p class="empty">No mission yet. Type a task below.</p></div>
        <div id="history" class="hidden" role="tabpanel" aria-labelledby="tab-history"><p class="empty">Loading history…</p></div>
        <div id="analytics" class="hidden" role="tabpanel" aria-labelledby="tab-analytics"><p class="empty">Loading analytics...</p></div>
        <div id="settings" class="hidden" role="tabpanel" aria-labelledby="tab-settings">
          <div class="settings-row"><label for="set-brain">Brain</label><select id="set-brain"><option value="anthropic">Anthropic</option><option value="nim">NVIDIA NIM</option></select></div>
          <div class="settings-row"><label for="set-notify">Notifications</label><input type="checkbox" id="set-notify" checked></div>
          <div class="settings-row"><label for="set-verify">Verify every step</label><input type="checkbox" id="set-verify" checked></div>
          <div class="settings-row"><label for="set-skin">Skin</label><select id="set-skin"><option value="default">Default</option><option value="ocean">Ocean</option><option value="forest">Forest</option><option value="sunset">Sunset</option><option value="mono">Mono</option><option value="neon">Neon</option></select></div>
          <div class="settings-row"><label>Actions</label><button id="btn-cleanup">Clean up old data</button> <button id="btn-export">Export history</button></div>
        </div>
      </div>
      <div class="panel">
        <h2 id="journal-heading" role="heading" aria-level="2">JOURNAL</h2>
        <div id="log" role="log" aria-live="polite" aria-labelledby="journal-heading"></div>
      </div>
    </section>
  </main>

  <footer>
    <span class="prompt">&gt;</span>
    <input id="task" placeholder="give Woboo a task…" autocomplete="off" spellcheck="false" aria-label="Task input">
    <button id="btn-send">SEND</button>
  </footer>
</div>

<div class="modal hidden" id="modal">
  <div class="card">
    <h3 id="ap-kind">APPROVAL NEEDED</h3>
    <div class="why" id="ap-why"></div>
    <pre id="ap-detail"></pre>
    <div class="row">
      <button class="deny" id="ap-deny">DENY</button>
      <button class="allow" id="ap-allow">ALLOW</button>
    </div>
    <div class="why" id="ap-clock"></div>
  </div>
</div>

<script>
(function () {
  var KEY = document.querySelector('meta[name=woboo-key]').content;
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var approvals = [];

  // The key arrived in the URL once, for this navigation. The server has
  // already set it as a session cookie, so take it out of the address bar —
  // browser history and shoulder-surfers should not get to keep it.
  if (location.search.indexOf('key=') >= 0) history.replaceState(null, '', location.pathname);

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  function toast(message) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  // ── the face ───────────────────────────────────────────────────────────────
  // Pre-rendered server-side from src/faceart.mjs — the same module the desktop
  // widget draws from, so the panel and the companion can never drift into being
  // two different characters.

  var ART = ${ART};

  function drawFace(current) {
    var name = current && ART[current.state] ? current.state : 'idle';
    var art = ART[name];
    $('face').innerHTML = art.svg;
    document.documentElement.style.setProperty('--fc', art.color);
    $('crt').setAttribute('data-face', name);
    $('face-state').textContent = name;
    $('face-note').textContent = (current && current.note) || '';
  }

  // ── mission ────────────────────────────────────────────────────────────────

  var GLYPH = { pending: '·', running: '>', verifying: '?', ok: '+', failed: 'x' };

  function drawMission(mission) {
    var host = $('mission');
    if (!mission) {
      host.innerHTML = '<p class="empty">No mission yet. Type a task below.</p>';
      return;
    }

    var html = '<div class="summary"><b>' + esc(mission.task) + '</b>';
    if (mission.offline) html += '<span class="badge">offline plan</span>';
    if (mission.crew) html += '<span class="badge">' + esc(mission.crew) + '</span>';
    html += '<span class="badge">' + esc(mission.state) + '</span>';
    if (mission.summary) html += '<div>' + esc(mission.summary) + '</div>';
    html += '</div>';

    (mission.steps || []).forEach(function (step, i) {
      var seconds = step.ms ? (step.ms / 1000).toFixed(1) + 's' : '';
      html += '<div class="step ' + esc(step.status) + '">' +
        '<div class="step-head">' +
          '<span class="glyph">' + (GLYPH[step.status] || '·') + '</span>' +
          '<span class="step-title">' + (i + 1) + '. ' + esc(step.title) +
            ' <span class="kind">' + esc(step.kind) + '</span></span>' +
          '<span class="step-meta">' + (step.attempts > 1 ? 'try ' + step.attempts + ' · ' : '') + seconds + '</span>' +
        '</div>';

      if (step.verify) {
        html += '<div class="step-meta">check: ' + esc(step.verify) + '</div>';
      }
      if (step.diagnosis) {
        html += '<div class="step-meta">diagnosis: ' + esc(step.diagnosis) + '</div>';
      }
      if (step.output) {
        html += '<details><summary>output</summary><pre>' + esc(step.output) + '</pre></details>';
      }
      if (step.verifyOutput) {
        html += '<details><summary>check output</summary><pre>' + esc(step.verifyOutput) + '</pre></details>';
      }
      html += '</div>';
    });

    if (mission.report) {
      html += '<div class="summary" style="margin-top:10px">' + esc(mission.report) + '</div>';
    }
    host.innerHTML = html;
  }

  // ── journal ────────────────────────────────────────────────────────────────

  function clock(stamp) {
    var when = stamp ? new Date(stamp) : new Date();
    return when.toTimeString().slice(0, 8);
  }

  function addLine(entry) {
    var host = $('log');
    var pinned = host.scrollTop + host.clientHeight >= host.scrollHeight - 24;
    var el = document.createElement('div');
    el.className = 'line ' + (entry.level || 'info');
    el.innerHTML = '<time>' + clock(entry.t || entry.at) + '</time>' +
      '<span class="kind-col">' + esc(entry.kind) + '</span>' +
      '<span class="msg">' + esc(entry.msg) + '</span>';
    host.appendChild(el);
    while (host.childElementCount > 400) host.removeChild(host.firstElementChild);
    if (pinned) host.scrollTop = host.scrollHeight;
  }

  // ── approvals ──────────────────────────────────────────────────────────────

  var clockTimer = null;

  function drawApprovals() {
    var request = approvals[0];
    if (!request) {
      $('modal').classList.add('hidden');
      if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
      return;
    }
    $('ap-kind').textContent = String(request.kind || 'approval').toUpperCase() + ' — ALLOW?';
    $('ap-why').textContent = request.reason || '';
    $('ap-detail').textContent = request.detail || '';
    $('modal').classList.remove('hidden');

    var tick = function () {
      var left = Math.max(0, Math.round((request.asked + request.timeout * 1000 - Date.now()) / 1000));
      $('ap-clock').textContent = 'auto-denies in ' + left + 's' +
        (approvals.length > 1 ? ' · ' + (approvals.length - 1) + ' more waiting' : '');
      if (left === 0) resolve(request.id, 'deny', true);
    };
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(tick, 500);
    tick();
  }

  function resolve(id, decision, silent) {
    approvals = approvals.filter(function (r) { return r.id !== id; });
    drawApprovals();
    if (silent) return;
    api('/api/approval', { id: id, decision: decision }).catch(function (err) { toast(err.message); });
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  function drawHeader(snap) {
    var brain = snap.brain || {};
    $('tag-brain').innerHTML = 'brain <b>' +
      (brain.credentials ? esc(brain.model) + ' / ' + esc(brain.effort) : 'offline') + '</b>';

    var ready = (snap.crew || []).filter(function (m) { return m.available; });
    $('tag-crew').innerHTML = 'crew <b>' +
      (ready.length ? ready.map(function (m) { return esc(m.label); }).join(', ') : 'none found') + '</b>';

    $('tag-hands').innerHTML = 'hands <b>' + esc(snap.hands) + '</b>';
    $('tag-ws').innerHTML = 'workspace <b>' + esc((snap.settings && snap.settings.workspace) || 'cwd') + '</b>';

    var stopped = snap.guard && snap.guard.stopped;
    $('btn-stop').classList.toggle('hidden', !!stopped);
    $('btn-resume').classList.toggle('hidden', !stopped);
    $('btn-send').disabled = !!stopped || !!snap.busy;
    $('btn-selftest').disabled = !!stopped || !!snap.busy;
  }

  function drawAll(snap) {
    state = snap;
    drawHeader(snap);
    drawFace(snap.face);
    drawMission(snap.mission);
    $('log').innerHTML = '';
    (snap.log || []).forEach(addLine);
    $('log').scrollTop = $('log').scrollHeight;
    approvals = snap.approvals || [];
    drawApprovals();
    if (snap.shot) showShot();
  }

  function showShot() {
    $('shot-wrap').classList.remove('hidden');
    $('shot').src = '/api/shot?t=' + Date.now();
  }

  function handle(event) {
    switch (event.type) {
      case 'state':
        drawAll(event.state);
        return;
      case 'face':
        drawFace({ state: event.state, note: event.note });
        return;
      case 'mission':
        drawMission(event.mission);
        if (state) {
          state.busy = !!(event.mission && (event.mission.state === 'running' || event.mission.state === 'planning'));
          drawHeader(state);
        }
        return;
      case 'log':
        addLine(event);
        return;
      case 'approval':
        approvals.push(event.request);
        drawApprovals();
        return;
      case 'approval:resolved':
        resolve(event.id, event.decision, true);
        return;
      case 'guard':
        if (state) {
          state.guard = { stopped: event.stopped, reason: event.reason };
          drawHeader(state);
        }
        return;
      case 'shot':
        showShot();
        return;
      default:
        // crew / crew:output and anything added later: the journal already
        // carries the human-readable version, so there is nothing to do here.
    }
  }

  function connect() {
    // EventSource cannot set headers; the session cookie the page set on load
    // is what authenticates this connection.
    var source = new EventSource('/api/events');
    source.onopen = function () {
      $('tag-link').textContent = '● live';
      $('tag-link').className = 'tag live';
    };
    source.onmessage = function (message) {
      try { handle(JSON.parse(message.data)); } catch (err) { /* malformed frame */ }
    };
    source.onerror = function () {
      $('tag-link').textContent = '● reconnecting';
      $('tag-link').className = 'tag dead';
      // EventSource retries on its own; this only reports the gap.
    };
  }

  function submit() {
    var input = $('task');
    var task = input.value.trim();
    if (!task) return;
    input.value = '';
    api('/api/mission', { task: task }).catch(function (err) {
      toast(err.message);
      input.value = task;
    });
  }

  $('btn-send').onclick = submit;
  $('task').onkeydown = function (event) { if (event.key === 'Enter') submit(); };
  $('btn-stop').onclick = function () { api('/api/stop', {}).catch(function (e) { toast(e.message); }); };
  $('btn-resume').onclick = function () { api('/api/resume', {}).catch(function (e) { toast(e.message); }); };
  $('btn-selftest').onclick = function () { api('/api/selftest', {}).catch(function (e) { toast(e.message); }); };
  $('btn-look').onclick = function () {
    api('/api/look', {}).then(function (result) {
      if (result.ok) showShot(); else toast(result.error || 'screen capture unavailable');
    }).catch(function (e) { toast(e.message); });
  };
  $('ap-allow').onclick = function () { if (approvals[0]) resolve(approvals[0].id, 'allow'); };
  $('ap-deny').onclick = function () { if (approvals[0]) resolve(approvals[0].id, 'deny'); };

  // Space is a habit for "stop"; Escape denies whatever is being asked.
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && approvals[0]) resolve(approvals[0].id, 'deny');
  });

  // ── tab switching ──────────────────────────────────────────────────────
  var tabs = document.querySelectorAll('.tab');
  var panels = ['mission', 'history', 'settings', 'analytics'];
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      panels.forEach(function (p) {
        var el = document.getElementById(p);
        if (el) el.classList.toggle('hidden', p !== tab.dataset.panel);
      });
      if (tab.dataset.panel === 'history') loadHistory();
      if (tab.dataset.panel === 'analytics') loadAnalytics();
    });
  });

  // ── mission history ─────────────────────────────────────────────────────
  function loadHistory() {
    api('/api/history').then(function (missions) {
      var host = $('history');
      if (!missions || !missions.length) {
        host.innerHTML = '<p class="empty">No mission history yet.</p>';
        return;
      }
      var html = '';
      missions.forEach(function (m) {
        var dur = m.duration ? m.duration + 's' : 'running';
        var stateClass = m.state === 'done' ? 'done' : m.state === 'failed' ? 'failed' : '';
        html += '<div class="history-item" data-id="' + esc(m.id) + '">' +
          '<div class="hi-task">' + esc(m.task) +
          '<span class="hi-state ' + stateClass + '">' + esc(m.state) + '</span></div>' +
          '<div class="hi-meta">' + dur + ' · ' + (m.steps || 0) + ' steps · ' + clock(m.startedAt) + '</div>' +
          '</div>';
      });
      host.innerHTML = html;
      host.querySelectorAll('.history-item').forEach(function (item) {
        item.addEventListener('click', function () {
          toast('Mission ' + item.dataset.id);
        });
      });
    }).catch(function () {
      $('history').innerHTML = '<p class="empty">Could not load history.</p>';
    });
  }

  // ── desktop notifications ───────────────────────────────────────────────
  var notifyEnabled = true;
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    // Will ask on first mission complete
  }
  function notifyMissionDone(mission) {
    if (!notifyEnabled || !mission) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification('Woboo: Mission complete', {
        body: mission.task || 'Task finished',
        silent: false
      });
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') notifyMissionDone(mission);
      });
    }
  }

  // ── settings actions ────────────────────────────────────────────────────
  var btnCleanup = $('btn-cleanup');
  if (btnCleanup) btnCleanup.onclick = function () {
    api('/api/cleanup', {}).then(function (r) {
      toast('Cleaned ' + (r.shotsRemoved || 0) + ' screenshots');
    }).catch(function (e) { toast(e.message); });
  };
  var btnExport = $('btn-export');
  if (btnExport) btnExport.onclick = function () {
    window.open('/api/export?key=' + encodeURIComponent(KEY), '_blank');
    toast('Exporting mission history…');
  };
  var setNotify = $('set-notify');
  if (setNotify) setNotify.onchange = function () { notifyEnabled = setNotify.checked; };

  // ── cost display ────────────────────────────────────────────────────────
  function updateCost() {
    api('/api/health').then(function (h) {
      var d = (h.cost || 0).toFixed(2);
      $('tag-cost').innerHTML = 'cost <b>' + d + '</b>';
    }).catch(function () {});
  }
  updateCost();
  setInterval(updateCost, 60000);

  // ── notify on mission done ──────────────────────────────────────────────
  var origHandle = handle;
  handle = function (event) {
    origHandle(event);
    if (event.type === 'mission' && event.mission && event.mission.state === 'done') {
      notifyMissionDone(event.mission);
    }
  };


  // ── analytics ─────────────────────────────────────────────────────
  function loadAnalytics() {
    api('/api/analytics').then(function (data) {
      var o = data.overview;
      var D = String.fromCharCode(36);
      var html = '<div style="padding:10px">';
      html += '<div class="summary"><b>Missions</b>: ' + o.missions.total + ' (success: ' + o.missions.successRate + '%)</div>';
      html += '<div class="summary"><b>Avg Duration</b>: ' + o.duration.avg + 's</div>';
      html += '<div class="summary"><b>Avg Steps</b>: ' + o.steps.avg + '</div>';
      html += '<div class="summary"><b>Cost</b>: ' + D + o.costs.total + ' (7d: ' + D + o.costs.last7d + ')</div>';
      html += '<h3 style="margin-top:14px;font-size:11px;letter-spacing:2px;color:var(--dim)">DAILY</h3>';
      (data.daily || []).forEach(function (d) {
        html += '<div style="display:flex;gap:10px;padding:3px 0;font-size:11px">';
        html += '<span style="color:var(--dim);width:80px">' + d.day + '</span>';
        html += '<span>' + d.missions + ' missions</span>';
        html += '<span style="color:var(--ok)">' + d.done + ' ok</span>';
        html += '<span style="color:var(--bad)">' + d.failed + ' fail</span>';
        html += '<span style="color:var(--fc)">' + D + d.cost.toFixed(2) + '</span>';
        html += '</div>';
      });
      html += '</div>';
      document.getElementById('analytics').innerHTML = html;
    }).catch(function () {
      document.getElementById('analytics').innerHTML = '<p class="empty">Could not load analytics.</p>';
    });
  }

  // ── skin selector ─────────────────────────────────────────────────────
  var setSkin = document.getElementById('set-skin');
  if (setSkin) setSkin.onchange = function () {
    api('/api/skins', { name: setSkin.value }).then(function (r) {
      if (r.vars) {
        for (var k in r.vars) document.documentElement.style.setProperty(k, r.vars[k]);
      }
      toast('Skin changed to ' + setSkin.value);
    }).catch(function (e) { toast(e.message); });
  };

  // ── keyboard accessibility ──────────────────────────────────────────────
  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey && event.key === '1') { document.getElementById('tab-mission').click(); }
    if (event.ctrlKey && event.key === '2') { document.getElementById('tab-history').click(); }
    if (event.ctrlKey && event.key === '3') { document.getElementById('tab-settings').click(); }
    if (event.ctrlKey && event.key === '4') { document.getElementById('tab-analytics').click(); }
  });

  drawFace({ state: 'idle', note: '' });
  connect();
})();
</script>
`;
}
