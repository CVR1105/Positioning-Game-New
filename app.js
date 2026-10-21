/* Positioning Strategy Game - browser client.
 * Views: home, host (create game), team (join/play), admin (facilitator console), screen (projector).
 * Live updates come from Server-Sent Events, with polling as a fallback, so a flaky
 * connection can never leave a laptop stuck on an old round.
 */
(function () {
  'use strict';
  const E = window.Engine;
  const $app = document.getElementById('app');
  const $top = document.getElementById('topinfo');
  const $tip = document.getElementById('tooltip');

  // ------------------------------------------------------------ utilities
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => (n == null || isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US'));
  const sgn = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
  const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return memory[k] || null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { memory[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { delete memory[k]; } },
  };
  const memory = {};

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    const wrap = document.getElementById('toasts');
    wrap.appendChild(el);
    while (wrap.children.length > 2) wrap.firstChild.remove();
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3800);
  }

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (S.token) headers['X-Token'] = S.token;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch (_) {
      throw new Error('Connection problem - check your internet and try again.');
    }
    let json = {};
    try { json = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) {
      const err = new Error(json.error || `Request failed (${res.status})`);
      err.status = res.status; err.data = json;
      if (res.status === 409) refresh(true);
      throw err;
    }
    return json;
  }

  // ------------------------------------------------------------ state
  const S = {
    view: 'home', code: null, token: null, state: null, renderKey: '',
    es: null, poll: null, skew: 0, connected: false,
    tab: null, resultsRound: null, chartTab: 'acc',
    plan: [], planRound: null, planDirty: 0, mode: null, modeSlot: null,
    simulating: false, refreshing: false, lastPhaseKey: '',
  };

  const tokenKey = (code, role) => `pg_${role}_${code}`;

  // ------------------------------------------------------------ routing
  function parseHash() {
    const h = (location.hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!h.length) return { view: 'home' };
    if (h[0] === 'host') return { view: 'host' };
    if (h[0] === 'g' && h[1]) {
      const code = h[1].toUpperCase();
      if (h[2] === 'admin') return { view: 'admin', code };
      if (h[2] === 'screen') return { view: 'screen', code };
      return { view: 'team', code };
    }
    return { view: 'home' };
  }

  function route() {
    const r = parseHash();
    const changed = r.view !== S.view || r.code !== S.code;
    S.view = r.view;
    S.code = r.code || null;
    if (changed) {
      S.state = null; S.renderKey = ''; S.tab = null; S.resultsRound = null; S.plan = []; S.planRound = null; S.mode = null;
      S.token = S.code ? store.get(tokenKey(S.code, S.view === 'admin' ? 'admin' : 'team')) : null;
      if (S.view === 'screen') S.token = null;
    }
    disconnect();
    if (S.code) { connect(); refresh(true); }
    render(true);
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------ live connection
  function disconnect() {
    if (S.es) { S.es.close(); S.es = null; }
    if (S.poll) { clearInterval(S.poll); S.poll = null; }
  }

  function connect() {
    const url = `/api/games/${S.code}/stream` + (S.token ? `?token=${encodeURIComponent(S.token)}` : '');
    try {
      S.es = new EventSource(url);
      S.es.onopen = () => { S.connected = true; renderTop(); };
      S.es.onmessage = e => {
        S.connected = true;
        let d = {};
        try { d = JSON.parse(e.data); } catch (_) { /* ignore */ }
        if (!S.state || d.version !== S.state.version) refresh();
      };
      S.es.onerror = () => { S.connected = false; renderTop(); };
    } catch (_) { S.connected = false; }
    // Fallback poll: keeps presence fresh and recovers from any missed event.
    S.poll = setInterval(() => refresh(), 4000);
  }

  async function refresh(force) {
    if (!S.code || (S.refreshing && !force)) return;
    S.refreshing = true;
    const tok = S.token, code = S.code;
    try {
      const res = await fetch(`/api/games/${code}/state`, { headers: tok ? { 'X-Token': tok } : {}, cache: 'no-store' });
      if (code !== S.code) return;
      if (res.status === 404) { S.state = { notFound: true }; render(true); return; }
      const st = await res.json();
      S.connected = true;
      // Ignore responses fetched with a different login (e.g. a request in flight while joining).
      if (tok !== S.token) { setTimeout(() => refresh(true), 0); return; }
      if (S.state && !S.state.notFound && st.version < S.state.version && st.role === S.state.role) return; // stale
      onState(st);
    } catch (_) {
      S.connected = false;
      renderTop();
    } finally {
      S.refreshing = false;
    }
  }

  function onState(st) {
    const prev = S.state && !S.state.notFound ? S.state : null;
    S.skew = st.serverNow - Date.now();

    // Token no longer valid for this role -> forget it.
    if (S.token && S.view === 'team' && st.role !== 'team') { store.del(tokenKey(S.code, 'team')); S.token = null; reconnect(); }
    if (S.token && S.view === 'admin' && st.role !== 'admin') { store.del(tokenKey(S.code, 'admin')); S.token = null; reconnect(); }

    // Round plan bookkeeping (team view).
    if (st.me && st.phase === 'decision') {
      if (S.planRound !== st.round) {
        S.planRound = st.round;
        S.plan = clonePlan((st.me.decision && st.me.decision.actions) || st.me.draft || []);
        S.mode = null; S.modeSlot = null;
      } else if (!st.me.decision && st.me.draft && Date.now() - S.planDirty > 4000) {
        S.plan = clonePlan(st.me.draft); // teammate on another laptop edited the plan
      }
      if (st.me.decision) S.plan = clonePlan(st.me.decision.actions);
    }

    // Phase transitions -> tab switches + simulation animation.
    const phaseKey = `${st.phase}:${st.round}`;
    const phaseChanged = prev && S.lastPhaseKey && S.lastPhaseKey !== phaseKey;
    S.lastPhaseKey = phaseKey;
    S.state = st;

    const seenKey = `pg_seen_${S.code}_${S.view}`;
    const seen = Number(store.get(seenKey) || 0);
    if (st.history.length > seen) {
      store.set(seenKey, String(st.history.length));
      if (prev && st.history.length > prev.history.length) {
        S.resultsRound = st.history.length;
        if (S.view !== 'admin') S.tab = 'results';
        runSimulation(st.history.length);
      }
    }
    if (phaseChanged) {
      if (st.phase === 'decision') { S.tab = 'decide'; toast(`Round ${st.round} is open - make your move!`, 'ok'); }
      if (st.phase === 'finished') { S.tab = 'final'; setTimeout(confetti, 300); }
    }
    render();
  }

  function reconnect() { disconnect(); connect(); }
  const clonePlan = a => (a || []).map(x => ({ type: x.type, slot: x.slot, cell: x.cell }));

  // ------------------------------------------------------------ render root
  function render(force) {
    renderTop();
    const st = S.state;
    const key = st ? `${S.view}|${st.version}|${st.teams ? st.teams.map(t => (t.online ? 1 : 0) + (t.submitted ? 2 : 0)).join('') : ''}|${S.tab}|${S.resultsRound}|${S.chartTab}|${JSON.stringify(S.plan)}|${S.mode}|${S.modeSlot}|${S.token ? 1 : 0}` : S.view + Math.random();
    if (!force && key === S.renderKey) return;
    S.renderKey = key;
    hideTip();
    const y = window.scrollY;
    if (S.view === 'home') $app.innerHTML = viewHome();
    else if (S.view === 'host') $app.innerHTML = viewHost();
    else if (!st) $app.innerHTML = `<div class="waiting"><div class="spinner"></div><p class="muted">Connecting to game ${esc(S.code)}...</p></div>`;
    else if (st.notFound) $app.innerHTML = `<div class="card empty"><h2>Game ${esc(S.code)} not found</h2><p>Check the code with your facilitator.</p><a class="btn primary" href="#/">Back to start</a></div>`;
    else if (S.view === 'admin') $app.innerHTML = st.role === 'admin' ? viewAdmin(st) : viewAdminLogin();
    else if (S.view === 'screen') $app.innerHTML = viewScreen(st);
    else $app.innerHTML = st.role === 'team' ? viewTeam(st) : viewJoin(st);
    window.scrollTo(0, y);
    afterRender();
  }

  function renderTop() {
    const st = S.state;
    if (!S.code || !st || st.notFound) { $top.innerHTML = ''; return; }
    const parts = [`<span class="pill ${S.connected ? 'live' : 'off'}">${S.connected ? 'Live' : 'Reconnecting'}</span>`, `<span class="pill">Game <b>${esc(st.code)}</b></span>`];
    if (st.me) parts.push(`<span class="pill"><span class="dot" style="background:${st.me.color}"></span>${esc(st.me.name)}</span>`);
    if (S.view === 'admin' && st.role === 'admin') parts.push('<span class="pill">Facilitator</span>');
    $top.innerHTML = parts.join('');
  }

  // ------------------------------------------------------------ shared pieces
  function phaseBar(st) {
    const dots = [];
    for (let r = 1; r <= st.settings.totalRounds; r++) {
      const c = r < st.round || (r === st.round && (st.phase === 'results' || st.phase === 'finished')) ? 'done' : r === st.round ? 'now' : '';
      dots.push(`<span class="round-dot ${c}" title="Round ${r}">${r}</span>`);
    }
    const label = {
      lobby: 'Lobby - waiting for teams',
      decision: `Round ${st.round} of ${st.settings.totalRounds} - decisions open`,
      results: `Round ${st.round} of ${st.settings.totalRounds} - results`,
      finished: 'Game over - final leaderboard',
    }[st.phase];
    return `<div class="phasebar"><div class="round-dots">${dots.join('')}</div><b>${label}</b>${st.deadline ? `<span class="countdown" data-deadline="${st.deadline}">--:--</span>` : ''}</div>`;
  }

  function teamById(st, id) { return st.teams.find(t => t.id === id) || { name: '?', color: '#888' }; }
  function teamDot(t) { return `<span class="dot" style="background:${t.color}"></span>`; }

  function submissionChips(st) {
    return `<div class="team-chips">${st.teams.map(t => `<span class="team-chip ${t.submitted ? 'done' : ''}" title="${t.online ? 'online' : 'offline'}"><span class="online-dot ${t.online ? 'on' : ''}"></span>${teamDot(t)}${esc(t.name)} ${t.submitted ? '<span class="tick">✓</span>' : '<span class="wait">…</span>'}</span>`).join('')}</div>`;
  }

  // Demand heat colour: one hue, darker -> brighter with demand (log scale).
  function heat(d) {
    if (!d) return '#1a2440';
    const t = Math.max(0, Math.min(1, Math.log(d / 50) / Math.log(30)));
    const l = 15 + t * 27, s = 22 + t * 18, h = 222 - t * 12; // low-chroma slate ramp so team colours stand out
    return `hsl(${h} ${s}% ${l}%)`;
  }

  function records(st) { return st.admin ? st.admin.fullHistory : st.history; }

  // ------------------------------------------------------------ HOME
  function viewHome() {
    return `
    <section class="hero">
      <h1>Marketing &amp; Positioning Simulation</h1>
      <p>Up to 10 teams compete over 8 rounds to position products on a perceptual map of <b>quality</b> and <b>style/look</b>. Launch, reposition, protect your best sellers, and finish with the highest accumulated profit.</p>
    </section>
    <div class="choice">
      <div class="card">
        <h2>🎮 Join a game</h2>
        <p class="muted small">Your facilitator gives you a 6-character game code, or a link to open.</p>
        <form id="f-code" class="row">
          <input class="grow" type="text" name="code" maxlength="6" placeholder="Game code e.g. K7M2QX" autocomplete="off" style="text-transform:uppercase" required>
          <button class="btn primary">Join</button>
        </form>
      </div>
      <div class="card">
        <h2>🧑‍🏫 Host a game</h2>
        <p class="muted small">Create a game, share the link with the teams, then run the rounds from the facilitator console.</p>
        <a class="btn go" href="#/host">Create a new game</a>
      </div>
    </div>
    <div class="card" style="max-width:900px;margin:0 auto">
      <h3>How it works in 30 seconds</h3>
      <ol class="muted" style="margin:0;padding-left:20px">
        <li>Every team starts with <b>5,000 points</b>. Moving a product costs <b>200 points per cell</b> (horizontal or vertical only), starting from J1.</li>
        <li>Each cell's demand is shared equally among all products in it. Products you keep in place earn a <b>10% compounding loyalty bonus</b>.</li>
        <li>You must make <b>at least one move every round</b>. Launched products can't simply be deleted; withdrawing one costs a <b>double penalty</b>.</li>
        <li>After each round everyone sees the results, the charts and the leaderboard. The highest accumulated profit after round 8 wins.</li>
      </ol>
      <p class="small" style="margin-bottom:0"><a href="/how-to-play" target="_blank" rel="noopener">Read the full How to Play guide and game logic →</a></p>
    </div>`;
  }

  // ------------------------------------------------------------ HOST
  function viewHost() {
    return `
    <div class="card" style="max-width:640px;margin:0 auto">
      <h2>Create a new game</h2>
      <form id="f-host">
        <label>Game title</label>
        <input type="text" name="title" maxlength="60" placeholder="e.g. MBA Section B - Marketing Sim">
        <label>Facilitator PIN (keep it secret - you need it to reopen the console)</label>
        <input type="password" name="pin" minlength="4" required placeholder="At least 4 characters">
        <div class="grid cols-2" style="gap:12px">
          <div><label>Number of rounds</label><input type="number" name="rounds" min="1" max="8" value="8"></div>
          <div><label>Maximum teams</label><input type="number" name="teams" min="1" max="10" value="10"></div>
          <div><label>Decision timer per round (minutes, 0 = none)</label><input type="number" name="roundMin" min="0" max="60" value="0"></div>
          <div><label>Results display before next round (minutes, 0 = I click next)</label><input type="number" name="resMin" min="0" max="60" value="0"></div>
        </div>
        <label class="check"><input type="checkbox" name="auto" checked> Process the round automatically once every team has submitted</label>
        <label class="check"><input type="checkbox" name="reveal" checked> Show competitors' product positions and sales in results (as in the original game)</label>
        <div class="row" style="margin-top:14px"><button class="btn go lg">Create game</button><a class="btn ghost" href="#/">Cancel</a></div>
      </form>
    </div>`;
  }

  // ------------------------------------------------------------ JOIN
  function viewJoin(st) {
    const started = st.phase !== 'lobby';
    return `
    <div class="card" style="max-width:560px;margin:20px auto">
      <h2>${esc(st.title)}</h2>
      <p class="muted">Game <b>${esc(st.code)}</b> · ${st.teams.length}/${st.settings.maxTeams} teams · ${started ? `<b>in progress (round ${st.round})</b>` : 'waiting in lobby'}</p>
      ${started ? '<div class="alert warn">This game has started. Only existing teams can rejoin: enter your exact team name and PIN.</div>' : ''}
      <form id="f-join">
        <label>Team name</label>
        <input type="text" name="team" maxlength="30" required placeholder="e.g. Team Phoenix" autocomplete="off">
        <label>Team PIN (4+ characters - teammates use it to log in from other laptops)</label>
        <input type="password" name="pin" minlength="4" required>
        <div class="row" style="margin-top:14px"><button class="btn primary lg">${started ? 'Rejoin team' : 'Join game'}</button></div>
      </form>
      ${st.teams.length ? `<h3 style="margin-top:18px">Teams in this game</h3><div class="team-chips">${st.teams.map(t => `<span class="team-chip">${teamDot(t)}${esc(t.name)}</span>`).join('')}</div>` : ''}
      <p class="small muted" style="margin-top:16px">Same team on two laptops? Enter the same team name and PIN on both. You will see the same products and plan.</p>
    </div>`;
  }

  // ------------------------------------------------------------ TEAM
  function viewTeam(st) {
    const me = st.me;
    if (st.phase === 'lobby') return phaseBar(st) + lobbyCard(st, `Welcome, ${esc(me.name)}!`, 'Waiting for the facilitator to start the game. Use this time to read the rules and plan your first move.');

    const hasResults = st.history.length > 0;
    if (!S.tab) S.tab = st.phase === 'decision' ? 'decide' : st.phase === 'finished' ? 'final' : 'results';
    if (S.tab === 'decide' && st.phase !== 'decision') S.tab = st.phase === 'finished' ? 'final' : 'results';
    if (S.tab === 'final' && st.phase !== 'finished') S.tab = 'results';
    if (S.tab === 'results' && !hasResults) S.tab = 'decide';

    const tabs = [];
    if (st.phase === 'decision') tabs.push(['decide', `Round ${st.round} decisions`]);
    if (st.phase === 'finished') tabs.push(['final', '🏆 Final leaderboard']);
    if (hasResults) tabs.push(['results', 'Results']);
    tabs.push(['myproducts', 'My portfolio']);

    let body = '';
    if (S.tab === 'decide') body = viewDecide(st);
    else if (S.tab === 'results') body = viewResults(st, S.resultsRound || st.history.length);
    else if (S.tab === 'final') body = viewFinal(st);
    else body = viewPortfolio(st);

    let banner = '';
    if (st.phase === 'results' && st.round < st.settings.totalRounds) banner = `<div class="alert info">Round ${st.round} results are in. ${st.deadline ? 'Round ' + (st.round + 1) + ' opens automatically when the timer ends.' : 'Waiting for the facilitator to open round ' + (st.round + 1) + '.'}</div>`;
    if (st.phase === 'results' && st.round >= st.settings.totalRounds) banner = '<div class="alert info">That was the final round! The facilitator will reveal the final leaderboard shortly.</div>';

    return phaseBar(st) + banner + `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>` + body;
  }

  function lobbyCard(st, title, text) {
    return `<div class="grid cols-2">
      <div class="card"><h2>${title}</h2><p class="muted">${text}</p>
        <h3>Teams joined (${st.teams.length}/${st.settings.maxTeams})</h3>${submissionChipsLobby(st)}
        <p class="small muted" style="margin-top:14px">${st.settings.totalRounds} rounds · start budget ${fmt(st.settings.startBudget)} · up to ${st.settings.maxProducts} products per team${st.settings.roundSeconds ? ` · ${Math.round(st.settings.roundSeconds / 60)} min per round` : ''}</p>
      </div>
      <div class="card"><h3>The market</h3>${mapHtml(st, { readonly: true })}</div>
    </div>`;
  }

  function submissionChipsLobby(st) {
    return `<div class="team-chips">${st.teams.map(t => `<span class="team-chip"><span class="online-dot ${t.online ? 'on' : ''}"></span>${teamDot(t)}${esc(t.name)}</span>`).join('') || '<span class="muted">No teams yet</span>'}</div>`;
  }

  // ---------- decision screen
  function lastRecord(st) { return st.history[st.history.length - 1] || null; }

  function planInfo(st) {
    const me = st.me;
    const ev = E.evaluateDecision(me, S.plan, st.settings);
    const bySlot = {};
    for (const a of S.plan) if (a.type !== 'launch') bySlot[a.slot] = a;
    const launches = S.plan.filter(a => a.type === 'launch');
    return { ev, bySlot, launches };
  }

  function viewDecide(st) {
    const me = st.me;
    const locked = !!me.decision;
    const { ev, bySlot, launches } = planInfo(st);
    const active = me.products.filter(p => p.status === 'active');
    const withdrawn = me.products.filter(p => p.status === 'withdrawn');
    const rec = lastRecord(st);
    const lastProd = {};
    const myLast = me.history[me.history.length - 1];
    if (myLast) for (const p of myLast.products) lastProd[p.slot] = p;
    const slotsLeft = st.settings.maxProducts - me.products.length - launches.length;
    const remaining = me.acc - ev.cost;
    const pending = st.teams.filter(t => !t.submitted).length;

    let hint = '';
    if (!locked) {
      if (S.mode === 'launch') hint = '<div class="hint">🚀 Click any cell on the map to launch a new product there. Cost = 200 × cells from J1 (START).</div>';
      else if (S.mode === 'move') hint = `<div class="hint">↔️ Click the cell to move product #${S.modeSlot} to. Cost = 200 × cells moved. Click its current cell to cancel the move.</div>`;
      else hint = '<div class="hint">Pick an action: <b>Launch new product</b>, or click one of your products (map or list) to <b>reposition</b> it. You must make at least one move.</div>';
    }

    const prodRows = active.map(p => {
      const a = bySlot[p.slot];
      const lp = lastProd[p.slot];
      const pl = p.lifeSales - p.lifeCost;
      const nextLoyalty = Math.round(E.loyaltyBonus(p.streak + 1, st.settings.loyaltyRate) * 100);
      let tag = '';
      if (a && a.type === 'move') tag = `<span class="plan-tag move">→ ${a.cell} (−${fmt(E.distance(p.cell, a.cell) * st.settings.cellCost)})</span>`;
      if (a && a.type === 'withdraw') tag = `<span class="plan-tag withdraw">WITHDRAW (−${fmt(E.withdrawPenalty(p, st.settings).penalty)})</span>`;
      return `<div class="prow ${S.modeSlot === p.slot && S.mode === 'move' ? 'sel' : ''}">
        <span class="chip" style="background:${me.color}">${p.slot}</span>
        <div><b>${p.cell}</b> ${tag}<div class="meta">Last sales ${fmt(lp ? lp.sales : 0)} · held ${p.streak} rd${p.streak === 1 ? '' : 's'} · if held: +${nextLoyalty}% loyalty · lifetime P/L <span class="${cls(pl)}">${sgn(pl)}</span></div></div>
        <div class="acts">${locked ? '' : a ? `<button class="btn sm ghost" data-undo="${p.slot}">Undo</button>` : `<button class="btn sm" data-move="${p.slot}">Move</button><button class="btn sm danger" data-withdraw="${p.slot}">Withdraw</button>`}</div>
      </div>`;
    }).join('');
    const launchRows = launches.map((a, i) => `<div class="prow planned-new">
        <span class="chip ghost" style="border-color:${me.color}">+</span>
        <div><b>New product → ${esc(a.cell)}</b><span class="plan-tag launch">LAUNCH (−${fmt(E.distance('J1', a.cell) * st.settings.cellCost)})</span><div class="meta">Demand ${fmt(E.demandOf(a.cell))} · ${rec ? `${rec.cellCounts[a.cell] || 0} product(s) there last round` : 'no competition data yet'}</div></div>
        <div class="acts">${locked ? '' : `<button class="btn sm ghost" data-unlaunch="${i}">Remove</button>`}</div>
      </div>`).join('');
    const wRows = withdrawn.map(p => `<div class="prow withdrawn"><span class="chip" style="background:#555">${p.slot}</span><div><b>Withdrawn</b> in round ${p.withdrawnRound}<div class="meta">Penalty paid ${fmt(p.penaltyPaid)}</div></div><div></div></div>`).join('');

    const minMoveMsg = ev.lines.length === 0 ? (me.acc >= st.settings.cellCost ? '<div class="alert warn">At least one move is compulsory every round.</div>' : '<div class="alert info">You cannot afford any move this round (budget below 200), so you may submit without a move.</div>') : '';
    const errs = ev.lines.length && !ev.ok ? ev.errors.map(e => `<div class="alert err">${esc(e)}</div>`).join('') : '';
    const canSubmit = ev.ok && !locked;

    return `<div class="decide-layout">
      <div class="card">
        <div class="card-head"><h2>Perceptual map <span class="sub">${rec ? `competition shown from round ${rec.round}` : 'demand per cell'}</span></h2></div>
        ${locked ? '' : `<div class="modebar">
          <button class="btn sm ${S.mode === 'launch' ? 'active' : ''}" data-mode="launch" ${slotsLeft <= 0 ? 'disabled' : ''}>🚀 Launch new product</button>
          ${S.mode ? '<button class="btn sm ghost" data-mode="none">Cancel</button>' : ''}
          <span class="small muted">${slotsLeft} of ${st.settings.maxProducts} product slots left</span>
        </div>${hint}`}
        <div style="margin-top:10px">${mapHtml(st, { interactive: !locked, plan: S.plan })}</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Your decision</h2>${locked ? '<span class="pill" style="border-color:#10b981">✓ Submitted</span>' : ''}</div>
        <div class="budget">
          <div><div class="k">Budget</div><div class="v">${fmt(me.acc)}</div></div>
          <div><div class="k">This round</div><div class="v ${ev.cost ? 'neg' : ''}">${ev.cost ? '−' + fmt(ev.cost) : '0'}</div></div>
          <div><div class="k">Remaining</div><div class="v ${remaining < 0 ? 'neg' : ''}">${fmt(remaining)}</div></div>
        </div>
        <div class="plist">${prodRows}${launchRows}${wRows || ''}${!active.length && !launches.length ? '<div class="empty small">No products yet. Launch your first product from the map.</div>' : ''}</div>
        <div class="summary">
          <div class="line"><span>Positioning (launch + moves)</span><span>${fmt(ev.positioning || 0)}</span></div>
          <div class="line"><span>Withdrawal penalties</span><span>${fmt(ev.penalties || 0)}</span></div>
          <div class="line total"><span>Total cost</span><span>${fmt(ev.cost)}</span></div>
        </div>
        ${locked ? '' : minMoveMsg + errs}
        ${locked
          ? `<div class="alert ok">Decision locked in. ${pending ? `Waiting for ${pending} more team${pending > 1 ? 's' : ''}...` : 'Processing...'}</div><button class="btn block" data-cancel-decision>Edit decision</button>`
          : `<button class="btn go lg block" data-submit ${canSubmit ? '' : 'disabled'}>Submit round ${st.round} decision</button>`}
        <h3 style="margin-top:18px">Teams submitted</h3>${submissionChips(st)}
        <p class="tiny faint" style="margin-top:10px">Other teams only see that you have submitted, never what you chose.</p>
      </div>
    </div>`;
  }

  // ---------- perceptual map (shared by decision, results, lobby, admin)
  function mapHtml(st, opt) {
    opt = opt || {};
    const me = st.me;
    const rec = opt.record || lastRecord(st);
    const counts = rec ? rec.cellCounts : {};
    const chips = {}; // cell -> html[]
    const add = (cell, html) => { (chips[cell] = chips[cell] || []).push(html); };

    if (opt.record) {
      // Results map: every revealed product as a team-coloured dot.
      for (const [tid, t] of Object.entries(opt.record.teams)) {
        if (!t.products) continue;
        const tm = teamById(st, tid);
        for (const p of t.products) add(p.cell, `<span class="pdot" style="background:${tm.color}" title="${esc(tm.name)} #${p.slot}: ${p.sales}"></span>`);
      }
      if (me && !opt.record.teams[me.id]?.products) {
        const mine = me.history.find(h => h.round === opt.record.round);
        if (mine) for (const p of mine.products) add(p.cell, `<span class="pdot" style="background:${me.color}"></span>`);
      }
    } else if (me) {
      const plan = opt.plan || [];
      const bySlot = {};
      for (const a of plan) if (a.type !== 'launch') bySlot[a.slot] = a;
      for (const p of me.products) {
        if (p.status !== 'active') continue;
        const a = bySlot[p.slot];
        const sel = S.mode === 'move' && S.modeSlot === p.slot ? 'sel' : '';
        add(p.cell, `<span class="chip ${a ? 'leaving' : ''} ${sel}" style="background:${me.color}" data-slot="${p.slot}">${p.slot}</span>`);
        if (a && a.type === 'move') add(a.cell, `<span class="chip ghost" style="border-color:${me.color}">${p.slot}</span>`);
      }
      for (const a of plan) if (a.type === 'launch') add(a.cell, `<span class="chip ghost" style="border-color:${me.color}">+</span>`);
    }

    let html = `<div class="map-wrap"><div class="map-axis-y"><span>Basic</span><span>Style / look →</span><span>High</span></div><div class="map ${opt.interactive ? 'mode-' + (S.mode || 'none') : ''}">`;
    html += '<div></div>' + E.COLS.map(c => `<div class="lab">${c}</div>`).join('');
    E.ROWS.forEach((r, ri) => {
      html += `<div class="lab">${r}</div>`;
      E.COLS.forEach((c, ci) => {
        const id = r + c;
        const d = E.DEMAND[ri][ci];
        const start = id === 'J1';
        const seg = E.SEGMENTS[id];
        const cnt = counts[id] || 0;
        html += `<div class="cell ${start ? 'start' : ''} ${seg ? 'has-seg' : ''}" data-cell="${id}" style="background:${heat(d)}">
          <span class="dem">${start ? 'START' : d}</span><span class="cid">${id}</span>
          ${cnt && !opt.record ? `<span class="cnt" title="${cnt} product(s) here last round">×${cnt}</span>` : ''}
          <span class="chips">${(chips[id] || []).join('')}</span>
          ${seg ? `<span class="seg">${seg}</span>` : ''}
        </div>`;
      });
    });
    html += '</div><div class="map-axis-x"><span>Low quality</span><span>Quality →</span><span>High quality</span></div></div>';
    html += `<div class="legend-scale"><span>Demand</span><span class="bar" style="background:linear-gradient(90deg,${heat(50)},${heat(300)},${heat(1500)})"></span><span>50 → 1,500</span>${!opt.record && rec ? '<span>· <b style="color:#fde68a">×n</b> = products in the cell last round</span>' : ''}${opt.record ? '<span>· dots = products (team colour)</span>' : ''}</div>`;
    return html;
  }

  // ---------- portfolio
  function viewPortfolio(st) {
    const me = st.me;
    const rows = me.products.map(p => {
      const pl = p.lifeSales - p.lifeCost;
      return `<tr><td><span class="chip" style="background:${p.status === 'active' ? me.color : '#555'}">${p.slot}</span></td><td>${p.status === 'active' ? `<b>${p.cell}</b>` : 'Withdrawn'}</td><td>${p.path.map(x => x.cell || '✕').join(' → ')}</td><td class="num">${p.launchedRound}</td><td class="num">${fmt(p.lastSales)}</td><td class="num">${p.status === 'active' ? '+' + Math.round(E.loyaltyBonus(p.streak, st.settings.loyaltyRate) * 100) + '%' : '–'}</td><td class="num">${fmt(p.lifeSales)}</td><td class="num">${fmt(p.lifeCost)}</td><td class="num ${cls(pl)}">${sgn(pl)}</td><td class="num">${p.penaltyPaid ? fmt(p.penaltyPaid) : ''}</td></tr>`;
    }).join('');
    const hist = me.history.map(h => `<tr><td>Round ${h.round}</td><td>${h.missed ? '<span class="neg">No submission</span>' : h.actions.map(describeAction).join('<br>') || 'No move (budget below 200)'}</td></tr>`).join('');
    return `<div class="grid">
      <div class="card"><h2>My products</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Cell</th><th>Path</th><th class="num">Launched</th><th class="num">Last sales</th><th class="num">Loyalty</th><th class="num">Lifetime sales</th><th class="num">Lifetime cost</th><th class="num">Lifetime P/L</th><th class="num">Penalty</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="empty">No products yet</td></tr>'}</tbody></table></div></div>
      <div class="card"><h2>My decision history <span class="sub">private to your team</span></h2><div class="table-wrap"><table><tbody>${hist || '<tr><td class="empty">No rounds played yet</td></tr>'}</tbody></table></div></div>
    </div>`;
  }

  function describeAction(a) {
    if (a.type === 'launch') return `🚀 Launched #${a.slot} in ${a.cell} (−${fmt(a.cost)})`;
    if (a.type === 'move') return `↔️ Moved #${a.slot} ${a.from} → ${a.cell} (−${fmt(a.cost)})`;
    return `✕ Withdrew #${a.slot} from ${a.from} (penalty −${fmt(a.cost)})`;
  }

  // ---------- results
  function viewResults(st, roundNo) {
    const recs = records(st);
    if (!recs.length) return '<div class="card empty">No results yet.</div>';
    roundNo = Math.max(1, Math.min(recs.length, roundNo || recs.length));
    const rec = recs[roundNo - 1];
    const prev = recs[roundNo - 2];
    const me = st.me;
    const mine = me && rec.teams[me.id];
    const ids = Object.keys(rec.teams).sort((a, b) => rec.teams[a].accRank - rec.teams[b].accRank || rec.teams[b].acc - rec.teams[a].acc);

    const picker = `<div class="row">${recs.map(r => `<button class="btn sm ${r.round === roundNo ? 'active' : ''}" data-rround="${r.round}">R${r.round}</button>`).join('')}</div>`;

    let kpis = '';
    if (mine) {
      const pr = prev && prev.teams[me.id];
      const rankDelta = pr ? pr.accRank - mine.accRank : 0;
      kpis = `<div class="kpis">
        <div class="kpi"><div class="k">Sales</div><div class="v" data-count="${mine.sales}">${fmt(mine.sales)}</div><div class="d">${mine.marketShare}% market share</div></div>
        <div class="kpi"><div class="k">Costs</div><div class="v" data-count="${mine.costs}">${fmt(mine.costs)}</div><div class="d">${mine.penalty ? `incl. ${fmt(mine.penalty)} penalty` : 'positioning'}</div></div>
        <div class="kpi"><div class="k">Net profit</div><div class="v ${cls(mine.profit)}" data-count="${mine.profit}">${fmt(mine.profit)}</div><div class="d">rank #${mine.profitRank} this round</div></div>
        <div class="kpi hl"><div class="k">Accumulated profit</div><div class="v" data-count="${mine.acc}">${fmt(mine.acc)}</div><div class="d">${sgn(mine.acc - mine.accBefore)} vs last round</div></div>
        <div class="kpi hl"><div class="k">Overall rank</div><div class="v">#${mine.accRank}<span class="small muted"> / ${ids.length}</span></div><div class="d">${rankDelta > 0 ? `<span class="delta-up">▲ ${rankDelta} place${rankDelta > 1 ? 's' : ''}</span>` : rankDelta < 0 ? `<span class="delta-down">▼ ${-rankDelta} place${rankDelta < -1 ? 's' : ''}</span>` : 'no change'}</div></div>
      </div>`;
    }

    const ticker = rec.news && rec.news.length ? `<div class="ticker"><span class="label">MARKET NEWS</span><div class="track">${rec.news.map(n => `<span>${esc(n)}</span>`).join('')}</div></div>` : '';

    const board = `<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Team</th><th class="num">Sales</th><th class="num">Share</th><th class="num">Best product</th><th class="num">Costs</th><th class="num">Net profit</th><th class="num">Accumulated</th><th class="num">Products</th></tr></thead><tbody>
      ${ids.map(id => {
        const t = rec.teams[id], tm = teamById(st, id), p = prev && prev.teams[id];
        const d = p ? p.accRank - t.accRank : 0;
        return `<tr class="${me && id === me.id ? 'me' : ''}"><td class="rank">${t.accRank} ${d > 0 ? `<span class="delta-up">▲${d}</span>` : d < 0 ? `<span class="delta-down">▼${-d}</span>` : '<span class="delta-same">–</span>'}</td><td>${teamDot(tm)} ${esc(tm.name)}${t.missed ? ' <span class="tiny neg">(no submission)</span>' : ''}</td><td class="num">${fmt(t.sales)}</td><td class="num">${t.marketShare}%</td><td class="num">${fmt(t.bestProduct)}</td><td class="num">${fmt(t.costs)}</td><td class="num ${cls(t.profit)}">${sgn(t.profit)}</td><td class="num"><b>${fmt(t.acc)}</b></td><td class="num">${t.productCount}</td></tr>`;
      }).join('')}
      <tr><td></td><td class="muted">Total market</td><td class="num muted">${fmt(rec.totals.sales)}</td><td class="num muted">100%</td><td></td><td class="num muted">${fmt(rec.totals.costs)}</td><td class="num muted">${sgn(rec.totals.profit)}</td><td class="num muted">${fmt(rec.totals.acc)}</td><td class="num muted">${rec.totals.products}</td></tr>
      <tr><td></td><td class="muted">Average team</td><td class="num muted">${fmt(rec.averages.sales)}</td><td></td><td></td><td class="num muted">${fmt(rec.averages.costs)}</td><td class="num muted">${sgn(rec.averages.profit)}</td><td class="num muted">${fmt(rec.averages.acc)}</td><td class="num muted">${rec.averages.products}</td></tr>
    </tbody></table></div>`;

    const chartTabs = [['acc', 'Accumulated profit'], ['sales', 'Sales per round'], ['profit', 'Profit per round'], ['share', 'Market share']];
    const charts = `<div class="card"><div class="card-head"><h2>Performance charts</h2><div class="row">${chartTabs.map(([k, l]) => `<button class="btn sm ${S.chartTab === k ? 'active' : ''}" data-chart-tab="${k}">${l}</button>`).join('')}</div></div>
      ${S.chartTab === 'share' ? shareBars(st, rec) : lineChart(st, recs.slice(0, roundNo), S.chartTab)}</div>`;

    // my product table
    let myProducts = '';
    const myRec = me && me.history.find(h => h.round === roundNo);
    if (myRec) {
      myProducts = `<div class="card"><h2>Your products in round ${roundNo}</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Cell</th><th>Status</th><th class="num">Products in cell</th><th class="num">Equal share</th><th class="num">Loyalty</th><th class="num">Sales</th><th class="num">Cost this round</th></tr></thead><tbody>
        ${myRec.products.map(p => `<tr><td><span class="chip" style="background:${me.color}">${p.slot}</span></td><td><b>${p.cell}</b></td><td>${{ new: '🚀 New', moved: '↔️ Repositioned', held: '🛡️ Held' }[p.status]}</td><td class="num">${p.competitors}</td><td class="num">${fmt(p.baseShare)}</td><td class="num">${p.loyalty ? '+' + p.loyalty + '%' : '–'}</td><td class="num"><b>${fmt(p.sales)}</b></td><td class="num">${p.roundCost ? '−' + fmt(p.roundCost) : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No active products</td></tr>'}
        </tbody></table></div>${myRec.actions.length ? `<p class="small muted" style="margin-bottom:0">Your moves: ${myRec.actions.map(describeAction).join(' · ')}</p>` : ''}</div>`;
    }

    const top10 = `<div class="card"><h2>Top 10 products</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Team</th><th>Product</th><th class="num">Sales</th></tr></thead><tbody>${rec.top10.map((p, i) => { const tm = teamById(st, p.teamId); return `<tr class="${me && p.teamId === me.id ? 'me' : ''}"><td class="rank">${i + 1}</td><td>${teamDot(tm)} ${esc(tm.name)}</td><td>#${p.slot}${p.cell ? ' · ' + p.cell : ''}</td><td class="num">${fmt(p.sales)}</td></tr>`; }).join('')}</tbody></table></div></div>`;

    const teamProducts = st.settings.revealPositions || st.admin ? `<div class="card"><h2>Product sales by team</h2><div class="table-wrap"><table><thead><tr><th>Team</th><th>Products (cell: sales)</th><th class="num">Total</th></tr></thead><tbody>${ids.map(id => { const t = rec.teams[id], tm = teamById(st, id); return `<tr class="${me && id === me.id ? 'me' : ''}"><td>${teamDot(tm)} ${esc(tm.name)}</td><td class="small">${(t.products || []).map(p => `#${p.slot} ${p.cell}: <b>${fmt(p.sales)}</b>`).join(' · ') || '–'}</td><td class="num">${fmt(t.sales)}</td></tr>`; }).join('')}</tbody></table></div></div>` : '';

    return `<div class="card-head"><h2>Round ${roundNo} results</h2>${picker}</div>
      ${kpis}${ticker}
      <div class="card" style="margin-bottom:18px"><h2>Leaderboard <span class="sub">ranked by accumulated profit</span></h2>${board}</div>
      <div class="grid cols-2" style="margin-bottom:18px">${charts}<div class="card"><h2>Competitive map <span class="sub">after round ${roundNo}</span></h2>${mapHtml(st, { record: rec })}${competitionHeat(rec)}</div></div>
      <div class="grid cols-2">${myProducts || top10}${myProducts ? top10 : teamProducts}</div>
      ${myProducts && teamProducts ? `<div style="margin-top:18px">${teamProducts}</div>` : ''}`;
  }

  function competitionHeat(rec) {
    const crowded = Object.entries(rec.cellCounts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (!crowded.length) return '<p class="small muted" style="margin:10px 0 0">No contested cells yet: every product has its cell to itself.</p>';
    return `<p class="small muted" style="margin:10px 0 0">Most contested cells: ${crowded.map(([c, n]) => `<b>${c}</b> ×${n} (${fmt(E.demandOf(c) / n)} each)`).join(' · ')}</p>`;
  }

  function shareBars(st, rec) {
    const ids = Object.keys(rec.teams).sort((a, b) => rec.teams[b].marketShare - rec.teams[a].marketShare);
    const max = Math.max(1, ...ids.map(id => rec.teams[id].marketShare));
    return `<div class="bars">${ids.map(id => { const tm = teamById(st, id); const v = rec.teams[id].marketShare; return `<div class="barrow"><span class="name">${teamDot(tm)} ${esc(tm.name)}</span><div class="track"><div class="fill" style="width:${(v / max) * 100}%;background:${tm.color}"></div></div><span class="num">${v}%</span></div>`; }).join('')}</div>`;
  }

  // ---------- line chart (SVG, team colours, hover crosshair + tooltip)
  const chartData = {};
  function lineChart(st, recs, kind) {
    const ids = st.teams.map(t => t.id);
    const xs = kind === 'acc' ? [0, ...recs.map(r => r.round)] : recs.map(r => r.round);
    const series = ids.map(id => {
      const tm = teamById(st, id);
      const vals = recs.map(r => (r.teams[id] ? r.teams[id][kind] : null));
      return { id, name: tm.name, color: tm.color, values: kind === 'acc' ? [st.settings.startBudget, ...vals] : vals };
    });
    const all = series.flatMap(s => s.values.filter(v => v != null));
    let lo = Math.min(0, ...all), hi = Math.max(1, ...all);
    const pad = (hi - lo) * 0.08 || 100; hi += pad; if (lo < 0) lo -= pad;
    const W = 640, H = 300, L = 54, R = 92, T = 14, B = 30;
    const x = i => L + (xs.length === 1 ? (W - L - R) / 2 : (i / (xs.length - 1)) * (W - L - R));
    const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ticks = niceTicks(lo, hi, 5);
    const meId = st.me && st.me.id;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${kind} chart">`;
    for (const tv of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${y(tv)}" y2="${y(tv)}" stroke="#24324f" stroke-width="1" ${tv === 0 ? '' : 'stroke-dasharray="3 4"'}/><text x="${L - 8}" y="${y(tv) + 4}" text-anchor="end" font-size="11" fill="#9aa8c1">${fmtShort(tv)}</text>`;
    xs.forEach((r, i) => { svg += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#9aa8c1">${r === 0 ? 'Start' : 'R' + r}</text>`; });
    // draw others first, own team last (on top, thicker)
    const ordered = [...series].sort((a, b) => (a.id === meId) - (b.id === meId));
    const ends = [];
    for (const s of ordered) {
      const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
      if (!pts.length) continue;
      const w = s.id === meId ? 3.5 : 2;
      svg += `<polyline fill="none" stroke="${s.color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" points="${pts.map(p => p.join(',')).join(' ')}" class="draw"/>`;
      for (const p of pts) svg += `<circle cx="${p[0]}" cy="${p[1]}" r="${s.id === meId ? 4.5 : 3.2}" fill="${s.color}" stroke="#0f172b" stroke-width="2"/>`;
      const last = pts[pts.length - 1];
      ends.push({ y: last[1], x: last[0], s, v: s.values[s.values.length - 1] });
    }
    // end labels with simple collision avoidance
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const e of ends) svg += `<text x="${e.x + 8}" y="${e.y + 4}" font-size="11" fill="#e8eef9" font-weight="${e.s.id === meId ? 800 : 500}">${esc(e.s.name.length > 11 ? e.s.name.slice(0, 10) + '…' : e.s.name)}</text>`;
    svg += `<line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#9aa8c1" stroke-width="1" opacity="0"/>`;
    svg += `<rect class="hit" x="${L - 20}" y="${T}" width="${W - L - R + 40}" height="${H - T - B}" fill="transparent"/>`;
    svg += '</svg>';
    const cid = 'c' + Math.random().toString(36).slice(2, 8);
    chartData[cid] = { xs, series, x, W, kind };
    const title = { acc: 'Accumulated profit', sales: 'Sales', profit: 'Net profit' }[kind];
    return `<div class="chart-box" data-chart="${cid}">${svg}</div><div class="chart-legend">${series.map(s => `<span class="${s.id === meId ? 'me' : ''}"><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('')}</div><p class="tiny faint" style="margin:6px 0 0">${title} by team. Hover for exact values.</p>`;
  }

  function niceTicks(lo, hi, n) {
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v));
    return out;
  }
  const fmtShort = v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(v));

  function chartHover(e) {
    const box = e.target.closest('[data-chart]');
    if (!box) return;
    const d = chartData[box.dataset.chart];
    if (!d) return;
    const svg = box.querySelector('svg');
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * d.W;
    let best = 0, bd = Infinity;
    d.xs.forEach((_, i) => { const dist = Math.abs(d.x(i) - sx); if (dist < bd) { bd = dist; best = i; } });
    const xh = svg.querySelector('.xhair');
    xh.setAttribute('x1', d.x(best)); xh.setAttribute('x2', d.x(best)); xh.setAttribute('opacity', '.6');
    const rows = d.series.map(s => ({ s, v: s.values[best] })).filter(r => r.v != null).sort((a, b) => b.v - a.v);
    showTip(e, `<b>${d.xs[best] === 0 ? 'Start' : 'Round ' + d.xs[best]}</b>` + rows.map(r => `<div class="tt-row"><span>${teamDot(r.s)} ${esc(r.s.name)}</span><b>${fmt(r.v)}</b></div>`).join(''));
  }

  // ---------- final leaderboard
  function viewFinal(st) {
    const recs = records(st);
    const last = recs[recs.length - 1];
    if (!last) return '<div class="card empty">No rounds were played.</div>';
    const ids = Object.keys(last.teams).sort((a, b) => last.teams[b].acc - last.teams[a].acc);
    const totals = id => recs.reduce((s, r) => { const t = r.teams[id]; if (t) { s.sales += t.sales; s.costs += t.costs; s.best = Math.max(s.best, t.bestProduct); } return s; }, { sales: 0, costs: 0, best: 0 });
    const me = st.me;
    const pod = [ids[1], ids[0], ids[2]].map((id, i) => {
      if (!id) return '<div></div>';
      const tm = teamById(st, id); const place = [2, 1, 3][i];
      return `<div class="p p${place}"><div class="nm">${teamDot(tm)} ${esc(tm.name)}</div><div class="sc">${fmt(last.teams[id].acc)}</div><div class="block">${place === 1 ? '🏆' : place}</div></div>`;
    }).join('');
    const myPlace = me ? ids.indexOf(me.id) + 1 : 0;
    return `<div class="card" style="text-align:center;margin-bottom:18px">
        <h1>🏁 Final leaderboard</h1>
        <p class="muted">${esc(st.title)} · ${recs.length} rounds · winner decided by accumulated profit</p>
        ${me ? `<p style="font-size:1.2rem">Your team finished <b>#${myPlace}</b> of ${ids.length} with <b>${fmt(last.teams[me.id].acc)}</b> points${myPlace === 1 ? ' - congratulations, you won! 🎉' : '.'}</p>` : ''}
        <div class="podium">${pod}</div>
      </div>
      <div class="card" style="margin-bottom:18px"><div class="table-wrap"><table><thead><tr><th>Place</th><th>Team</th><th class="num">Final accumulated profit</th><th class="num">Total sales</th><th class="num">Total costs</th><th class="num">Best product (round)</th><th class="num">Products</th></tr></thead><tbody>
        ${ids.map((id, i) => { const tm = teamById(st, id), t = last.teams[id], tt = totals(id); return `<tr class="${me && id === me.id ? 'me' : ''}"><td class="rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td><td>${teamDot(tm)} <b>${esc(tm.name)}</b></td><td class="num"><b>${fmt(t.acc)}</b></td><td class="num">${fmt(tt.sales)}</td><td class="num">${fmt(tt.costs)}</td><td class="num">${fmt(tt.best)}</td><td class="num">${t.productCount}</td></tr>`; }).join('')}
      </tbody></table></div></div>
      <div class="grid cols-2"><div class="card"><h2>Accumulated profit over the game</h2>${lineChart(st, recs, 'acc')}</div><div class="card"><h2>Final market map</h2>${mapHtml(st, { record: last })}</div></div>
      <p class="small muted" style="text-align:center;margin-top:16px">Round-by-round results remain available in the Results tab.</p>`;
  }

  // ------------------------------------------------------------ ADMIN
  function viewAdminLogin() {
    return `<div class="card" style="max-width:460px;margin:30px auto"><h2>Facilitator login</h2><p class="muted">Game <b>${esc(S.code)}</b></p>
      <form id="f-admin"><label>Facilitator PIN</label><input type="password" name="pin" required><div class="row" style="margin-top:12px"><button class="btn primary">Open console</button></div></form></div>`;
  }

  function viewAdmin(st) {
    const link = `${location.origin}/#/g/${st.code}`;
    const share = `<div class="card" style="margin-bottom:18px"><div class="grid cols-2" style="align-items:center">
      <div><div class="muted small">Game code</div><div class="big-code">${esc(st.code)}</div><div class="muted small">${esc(st.title)}</div></div>
      <div><div class="muted small" style="margin-bottom:6px">Share this link with every team (works on any laptop or phone, no login needed):</div>
        <div class="share"><code>${esc(link)}</code><button class="btn sm" data-copy="${esc(link)}">Copy</button></div>
        <div class="row" style="margin-top:10px"><a class="btn sm ghost" href="#/g/${st.code}/screen" target="_blank">📺 Projector view</a><button class="btn sm ghost" data-settings>⚙️ Settings</button><a class="btn sm ghost" href="/export/${st.code}.csv?token=${encodeURIComponent(S.token)}">⬇ CSV</a><a class="btn sm ghost" href="/export/${st.code}.json?token=${encodeURIComponent(S.token)}">⬇ JSON</a></div>
      </div></div></div>`;

    let control = '';
    const n = st.teams.length, sub = st.teams.filter(t => t.submitted).length;
    if (st.phase === 'lobby') {
      control = `<div class="card"><div class="card-head"><h2>Lobby <span class="sub">${n}/${st.settings.maxTeams} teams joined</span></h2><button class="btn go lg" data-admin="start" ${n ? '' : 'disabled'}>▶ Start round 1</button></div>
        <div class="table-wrap"><table><thead><tr><th>Team</th><th>Status</th><th></th></tr></thead><tbody>${st.teams.map(t => `<tr><td>${teamDot(t)} ${esc(t.name)}</td><td><span class="online-dot ${t.online ? 'on' : ''}"></span> ${t.online ? 'online' : 'offline'}</td><td class="num"><button class="btn sm ghost" data-reset-pin="${t.id}">Reset PIN</button> <button class="btn sm danger" data-remove="${t.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="3" class="empty">Waiting for teams to join with the link above...</td></tr>'}</tbody></table></div></div>`;
    } else if (st.phase === 'decision') {
      const decs = st.admin.decisions;
      control = `<div class="card"><div class="card-head"><h2>Round ${st.round} - decisions <span class="sub">${sub}/${n} submitted</span></h2>
          <div class="row">${timerButtons(st)}<button class="btn ${sub === n ? 'go' : 'primary'}" data-admin="process">⚡ Process round ${st.round}${sub < n ? ` (${n - sub} missing)` : ''}</button></div></div>
        <div class="progress" style="margin-bottom:12px"><div class="p" style="width:${n ? (sub / n) * 100 : 0}%"></div></div>
        <div class="table-wrap"><table><thead><tr><th>Team</th><th>Online</th><th>Budget</th><th>Status</th><th>Decision (facilitator only)</th></tr></thead><tbody>
        ${st.admin.teams.map(t => { const d = decs[t.id]; const pub = st.teams.find(x => x.id === t.id); return `<tr><td>${teamDot(t)} ${esc(t.name)}</td><td><span class="online-dot ${pub.online ? 'on' : ''}"></span></td><td class="num">${fmt(t.acc)}</td><td>${d ? '<span class="pos">✓ submitted</span>' : '<span class="muted">thinking...</span>'}</td><td class="small">${d ? d.lines.map(describeAction).join('<br>') + `<div class="muted">Total ${fmt(d.cost)}</div>` : ''}</td></tr>`; }).join('')}
        </tbody></table></div>
        <p class="small muted" style="margin-bottom:0">${st.settings.autoProcess ? 'Auto-process is ON: the round is calculated as soon as every team submits.' : 'Auto-process is OFF: click Process when ready.'} Teams that have not submitted when you process keep their products where they are with no move.</p></div>`;
    } else if (st.phase === 'results') {
      const last = st.round >= st.settings.totalRounds;
      control = `<div class="card"><div class="card-head"><h2>Round ${st.round} results are live</h2><div class="row">${timerButtons(st)}<button class="btn go lg" data-admin="next">${last ? '🏆 Reveal final leaderboard' : `▶ Open round ${st.round + 1}`}</button></div></div>
        <p class="muted small" style="margin:0">Give teams time to study the results, then ${last ? 'reveal the winners' : 'open the next round'}.${st.deadline ? ' The timer will do it automatically.' : ''}</p></div>`;
    } else {
      control = '<div class="card"><h2>Game finished</h2><p class="muted" style="margin:0">All rounds are complete. Download the CSV/JSON for your records.</p></div>';
    }

    if (!S.tab || !['control', 'results', 'final', 'teams'].includes(S.tab)) S.tab = st.phase === 'finished' ? 'final' : 'control';
    const tabs = [['control', 'Control'], ...(st.history.length ? [['results', 'Results']] : []), ...(st.phase === 'finished' ? [['final', '🏆 Final']] : []), ['teams', 'Team portfolios']];
    let body = '';
    if (S.tab === 'results' && st.history.length) body = viewResults(st, S.resultsRound || st.history.length);
    else if (S.tab === 'final' && st.phase === 'finished') body = viewFinal(st);
    else if (S.tab === 'teams') body = adminPortfolios(st);
    else body = control + (st.history.length ? `<div style="margin-top:18px">${viewResults(st, S.resultsRound || st.history.length)}</div>` : `<div class="card" style="margin-top:18px"><h3>Market</h3>${mapHtml(st, { readonly: true })}</div>`);

    return phaseBar(st) + share + `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>` + body;
  }

  function timerButtons(st) {
    return `<button class="btn sm ghost" data-timer="extend" title="Add 1 minute">+1 min</button><button class="btn sm ghost" data-timer="set5" title="Set a 5-minute countdown">5:00</button>${st.deadline ? '<button class="btn sm ghost" data-timer="clear">Stop timer</button>' : ''}`;
  }

  function adminPortfolios(st) {
    return `<div class="grid cols-2">${st.admin.teams.map(t => `<div class="card"><h3>${teamDot(t)} ${esc(t.name)} <span class="sub">budget ${fmt(t.acc)}</span></h3><div class="table-wrap"><table><thead><tr><th>#</th><th>Cell</th><th class="num">Last sales</th><th class="num">Lifetime P/L</th></tr></thead><tbody>${t.products.map(p => `<tr><td>${p.slot}</td><td>${p.status === 'active' ? p.cell : 'Withdrawn R' + p.withdrawnRound}</td><td class="num">${fmt(p.lastSales)}</td><td class="num ${cls(p.lifeSales - p.lifeCost)}">${sgn(p.lifeSales - p.lifeCost)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No products</td></tr>'}</tbody></table></div></div>`).join('')}</div>`;
  }

  // ------------------------------------------------------------ PROJECTOR
  function viewScreen(st) {
    const link = `${location.origin}/#/g/${st.code}`;
    if (st.phase === 'lobby') return `<div class="card" style="text-align:center"><h1>${esc(st.title)}</h1><p class="muted">Join at</p><div class="big-code" style="font-size:1.6rem;letter-spacing:0">${esc(link)}</div><p class="muted">or enter game code</p><div class="big-code">${esc(st.code)}</div><h3 style="margin-top:20px">${st.teams.length} team(s) joined</h3>${submissionChipsLobby(st)}</div>`;
    if (st.phase === 'finished') return phaseBar(st) + viewFinal(st);
    if (st.phase === 'decision') {
      const sub = st.teams.filter(t => t.submitted).length;
      return phaseBar(st) + `<div class="card" style="text-align:center;margin-bottom:18px"><h1>Round ${st.round}: teams are deciding...</h1><p class="muted">${sub} of ${st.teams.length} submitted</p><div class="progress" style="max-width:600px;margin:10px auto 16px"><div class="p" style="width:${(sub / Math.max(1, st.teams.length)) * 100}%"></div></div>${submissionChips(st)}</div>` + (st.history.length ? viewResults(st, st.history.length) : '');
    }
    return phaseBar(st) + viewResults(st, st.history.length);
  }

  // ------------------------------------------------------------ simulation overlay
  function runSimulation(roundNo) {
    if (S.simulating) return;
    S.simulating = true;
    const steps = ['Consumers scanning the perceptual map', 'Splitting demand in contested cells', 'Applying 10% compounding loyalty bonuses', 'Deducting positioning costs and penalties', 'Ranking teams by accumulated profit'];
    const el = document.createElement('div');
    el.className = 'sim';
    el.innerHTML = `<div class="sim-box"><div class="radar"></div><h2>Simulating round ${roundNo} market</h2><div class="sim-steps">${steps.map(s => `<div class="sim-step"><span class="ic">○</span>${s}</div>`).join('')}</div><div class="progress"><div class="p"></div></div></div>`;
    document.body.appendChild(el);
    const stepEls = el.querySelectorAll('.sim-step');
    const bar = el.querySelector('.progress .p');
    let i = 0;
    const tick = setInterval(() => {
      if (i > 0) { stepEls[i - 1].className = 'sim-step done'; stepEls[i - 1].querySelector('.ic').textContent = '✓'; }
      if (i < steps.length) { stepEls[i].className = 'sim-step on'; stepEls[i].querySelector('.ic').textContent = '◉'; }
      bar.style.width = `${(i / steps.length) * 100}%`;
      i++;
      if (i > steps.length) {
        clearInterval(tick);
        setTimeout(() => { el.remove(); S.simulating = false; render(true); countUp(); window.scrollTo({ top: 0, behavior: 'smooth' }); }, 350);
      }
    }, 650);
  }

  function countUp() {
    document.querySelectorAll('[data-count]').forEach(el => {
      const target = Number(el.dataset.count);
      const t0 = performance.now(), dur = 1200;
      const step = now => {
        const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(target * e);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function confetti() {
    const colors = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#fde047'];
    for (let i = 0; i < 140; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 2.5 + Math.random() * 2.5 + 's';
      c.style.animationDelay = Math.random() * 1.2 + 's';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 6500);
    }
  }

  // ------------------------------------------------------------ tooltip
  function showTip(e, html) {
    $tip.innerHTML = html;
    $tip.classList.remove('hidden');
    const w = $tip.offsetWidth, h = $tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
    $tip.style.left = Math.max(8, x) + 'px';
    $tip.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { $tip.classList.add('hidden'); document.querySelectorAll('.xhair').forEach(x => x.setAttribute('opacity', '0')); }

  function cellTip(e, cellEl) {
    const st = S.state;
    if (!st || st.notFound) return;
    const id = cellEl.dataset.cell;
    const d = E.demandOf(id);
    const rec = lastRecord(st);
    const cnt = rec ? rec.cellCounts[id] || 0 : 0;
    let html = `<b>${id}</b>${E.SEGMENTS[id] ? ` · ${E.SEGMENTS[id]}` : ''}<div class="tt-row"><span>Demand</span><b>${id === 'J1' ? 'START (none)' : fmt(d)}</b></div>`;
    if (rec) html += `<div class="tt-row"><span>Products here last round</span><b>${cnt}</b></div>`;
    if (st.me && st.phase === 'decision' && S.view === 'team' && id !== 'J1') {
      const mineHere = st.me.products.some(p => p.status === 'active' && p.cell === id);
      if (S.mode === 'move') {
        const p = st.me.products.find(x => x.slot === S.modeSlot);
        if (p) html += `<div class="tt-row"><span>Move #${p.slot} cost</span><b>${fmt(E.distance(p.cell, id) * st.settings.cellCost)}</b></div><div class="tt-row"><span>Est. sales if you move here*</span><b>${fmt(d / (cnt + (p.cell === id ? 0 : 1) || 1))}</b></div>`;
      } else {
        html += `<div class="tt-row"><span>Launch cost (from J1)</span><b>${fmt(E.distance('J1', id) * st.settings.cellCost)}</b></div><div class="tt-row"><span>Est. sales if you enter*</span><b>${fmt(d / (cnt + 1))}</b></div>`;
      }
      if (mineHere) html += '<div class="tiny" style="margin-top:4px">Your product is here: click it to reposition.</div>';
      html += '<div class="tiny faint" style="margin-top:4px">*based on last round, before loyalty bonuses and new entrants</div>';
    }
    showTip(e, html);
  }

  // ------------------------------------------------------------ plan editing
  function setPlan(p) {
    S.plan = p;
    S.planDirty = Date.now();
    render();
    saveDraft();
  }
  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { api('POST', `/api/games/${S.code}/draft`, { actions: S.plan }).catch(() => {}); }, 600);
  }

  function onCellClick(id) {
    const st = S.state;
    if (!st.me || st.phase !== 'decision' || st.me.decision) return;
    if (id === 'J1') { toast('J1 is the START cell - it has no demand.', 'err'); return; }
    if (S.mode === 'launch') {
      if (st.settings.maxProducts - st.me.products.length - S.plan.filter(a => a.type === 'launch').length <= 0) { toast('No product slots left.', 'err'); return; }
      S.mode = null;
      setPlan([...S.plan, { type: 'launch', cell: id }]);
      toast(`Planned: launch a new product in ${id} (−${fmt(E.distance('J1', id) * st.settings.cellCost)})`, 'ok');
      return;
    }
    if (S.mode === 'move') {
      const p = st.me.products.find(x => x.slot === S.modeSlot);
      const rest = S.plan.filter(a => a.slot !== S.modeSlot || a.type === 'launch');
      S.mode = null; S.modeSlot = null;
      if (!p || p.cell === id) { setPlan(rest); return; }
      setPlan([...rest, { type: 'move', slot: p.slot, cell: id }]);
      toast(`Planned: move #${p.slot} ${p.cell} → ${id} (−${fmt(E.distance(p.cell, id) * st.settings.cellCost)})`, 'ok');
      return;
    }
    const mine = st.me.products.filter(p => p.status === 'active' && p.cell === id);
    if (mine.length) { S.mode = 'move'; S.modeSlot = mine[0].slot; render(); return; }
    S.mode = 'launch';
    onCellClick(id);
  }

  function confirmWithdraw(slot) {
    const st = S.state;
    const p = st.me.products.find(x => x.slot === slot);
    const w = E.withdrawPenalty(p, st.settings);
    const why = w.basis === 'loss'
      ? `This product is loss-making: lifetime sales ${fmt(p.lifeSales)} vs lifetime positioning cost ${fmt(p.lifeCost)} = loss of ${fmt(w.loss)}. The loss is deducted <b>twice</b>.`
      : `This product is not loss-making, so you pay double the exit cost: ${E.distance(p.cell, 'J1')} cells back to START × 200 = ${fmt(w.exitCost)}, × 2.`;
    modal(`<h2>Withdraw product #${slot} from ${p.cell}?</h2>
      <div class="alert err">Withdrawal is permanent. The product slot stays used (it still counts toward your ${st.settings.maxProducts}-product limit) and you lose its sales and loyalty.</div>
      <p>${why}</p><p style="font-size:1.2rem">Penalty: <b class="neg">−${fmt(w.penalty)}</b></p>
      <p class="small muted">Repositioning a weak product is usually cheaper than withdrawing it.</p>
      <div class="row"><button class="btn danger" data-confirm-withdraw="${slot}">Yes, withdraw (−${fmt(w.penalty)})</button><button class="btn" data-close>Keep the product</button></div>`);
  }

  function modal(html) {
    closeModal();
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="card modal">${html}</div>`;
    bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) closeModal(); });
    document.body.appendChild(bg);
    return bg;
  }
  function closeModal() { document.querySelectorAll('.modal-bg').forEach(m => m.remove()); }

  function settingsModal() {
    const s = S.state.settings;
    const bg = modal(`<h2>Game settings</h2><form id="f-settings">
      <label class="check"><input type="checkbox" name="auto" ${s.autoProcess ? 'checked' : ''}> Auto-process when all teams have submitted</label>
      <label class="check"><input type="checkbox" name="reveal" ${s.revealPositions ? 'checked' : ''}> Show competitors' product positions in results</label>
      <label>Decision timer for future rounds (minutes, 0 = none)</label><input type="number" name="roundMin" min="0" max="60" step="0.5" value="${s.roundSeconds / 60}">
      <label>Results display before auto-opening next round (minutes, 0 = manual)</label><input type="number" name="resMin" min="0" max="60" step="0.5" value="${s.resultsSeconds / 60}">
      <label>Total rounds</label><input type="number" name="rounds" min="${Math.max(1, S.state.round)}" max="8" value="${s.totalRounds}">
      <div class="row" style="margin-top:14px"><button class="btn primary">Save</button><button type="button" class="btn ghost" data-close>Cancel</button></div></form>`);
    bg.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('POST', `/api/games/${S.code}/admin/settings`, { autoProcess: f.auto.checked, revealPositions: f.reveal.checked, roundSeconds: Math.round(f.roundMin.value * 60), resultsSeconds: Math.round(f.resMin.value * 60), totalRounds: Number(f.rounds.value) });
        closeModal(); toast('Settings saved', 'ok'); refresh(true);
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  // ------------------------------------------------------------ events
  function afterRender() { tickClock(); }

  document.addEventListener('submit', async e => {
    const f = e.target;
    if (!f.id) return;
    e.preventDefault();
    const btn = f.querySelector('button:not([type=button])');
    if (btn) btn.disabled = true;
    try {
      if (f.id === 'f-code') {
        location.hash = `#/g/${f.code.value.trim().toUpperCase()}`;
      } else if (f.id === 'f-host') {
        const r = await api('POST', '/api/games', {
          title: f.title.value, adminPin: f.pin.value,
          settings: { totalRounds: Number(f.rounds.value), maxTeams: Number(f.teams.value), roundSeconds: Math.round(f.roundMin.value * 60), resultsSeconds: Math.round(f.resMin.value * 60), autoProcess: f.auto.checked, revealPositions: f.reveal.checked },
        });
        store.set(tokenKey(r.code, 'admin'), r.adminToken);
        location.hash = `#/g/${r.code}/admin`;
        toast(`Game ${r.code} created. Share the link with your teams!`, 'ok');
      } else if (f.id === 'f-join') {
        const r = await api('POST', `/api/games/${S.code}/join`, { teamName: f.team.value, pin: f.pin.value });
        store.set(tokenKey(S.code, 'team'), r.token);
        S.token = r.token; S.tab = null;
        toast(r.rejoined ? 'Welcome back!' : 'You have joined the game!', 'ok');
        reconnect(); await refresh(true);
      } else if (f.id === 'f-admin') {
        const r = await api('POST', `/api/games/${S.code}/admin/login`, { pin: f.pin.value });
        store.set(tokenKey(S.code, 'admin'), r.adminToken);
        S.token = r.adminToken;
        reconnect(); await refresh(true);
      }
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      if (btn && document.body.contains(btn)) btn.disabled = false;
    }
  });

  document.addEventListener('click', async e => {
    const t = e.target.closest('button, [data-cell], .chip[data-slot]');
    if (!t) return;
    const st = S.state;
    const d = t.dataset;
    try {
      if (d.tab) { S.tab = d.tab; if (d.tab === 'results') S.resultsRound = null; render(); window.scrollTo({ top: 0 }); return; }
      if (d.rround) { S.resultsRound = Number(d.rround); render(); return; }
      if (d.chartTab) { S.chartTab = d.chartTab; render(); return; }
      if (d.copy) { try { await navigator.clipboard.writeText(d.copy); toast('Link copied', 'ok'); } catch (_) { toast('Copy failed - select the link and copy it manually', 'err'); } return; }
      if (d.settings !== undefined) { settingsModal(); return; }
      if (d.mode) { S.mode = d.mode === 'none' ? null : d.mode; S.modeSlot = null; render(); return; }
      if (d.move) { S.mode = 'move'; S.modeSlot = Number(d.move); render(); return; }
      if (d.withdraw) { confirmWithdraw(Number(d.withdraw)); return; }
      if (d.confirmWithdraw) {
        const slot = Number(d.confirmWithdraw);
        closeModal();
        setPlan([...S.plan.filter(a => a.slot !== slot || a.type === 'launch'), { type: 'withdraw', slot }]);
        return;
      }
      if (d.undo) { setPlan(S.plan.filter(a => a.type === 'launch' || a.slot !== Number(d.undo))); return; }
      if (d.unlaunch !== undefined) {
        let i = -1; const idx = Number(d.unlaunch);
        setPlan(S.plan.filter(a => (a.type === 'launch' ? ++i !== idx : true)));
        return;
      }
      if (d.slot && t.classList.contains('chip') && S.mode !== 'launch' && !(S.mode === 'move' && S.modeSlot !== Number(d.slot)) && st && st.me && st.phase === 'decision' && !st.me.decision) {
        e.stopPropagation();
        const slot = Number(d.slot);
        if (S.mode === 'move' && S.modeSlot === slot) { S.mode = null; S.modeSlot = null; } else { S.mode = 'move'; S.modeSlot = slot; }
        render();
        return;
      }
      if (S.view === 'team' && (d.cell || t.closest('[data-cell]'))) { onCellClick(d.cell || t.closest('[data-cell]').dataset.cell); return; }
      if (d.submit !== undefined) {
        t.disabled = true;
        await api('POST', `/api/games/${S.code}/decision`, { actions: S.plan, round: st.round });
        toast('Decision submitted!', 'ok');
        await refresh(true);
        return;
      }
      if (d.cancelDecision !== undefined) { await api('POST', `/api/games/${S.code}/decision/cancel`, { round: st.round }); await refresh(true); return; }
      if (d.admin) {
        const n = st.teams.length, sub = st.teams.filter(x => x.submitted).length;
        if (d.admin === 'process' && sub < n && !confirm(`${n - sub} team(s) have not submitted. Their products will stay where they are with no move this round. Process now?`)) return;
        t.disabled = true;
        await api('POST', `/api/games/${S.code}/admin/${d.admin}`, { round: st.round });
        await refresh(true);
        return;
      }
      if (d.timer) {
        const body = d.timer === 'extend' ? { mode: st.deadline ? 'extend' : 'set', seconds: 60 } : d.timer === 'set5' ? { mode: 'set', seconds: 300 } : { mode: 'clear' };
        await api('POST', `/api/games/${S.code}/admin/timer`, body);
        await refresh(true);
        return;
      }
      if (d.remove) { if (confirm('Remove this team from the lobby?')) { await api('POST', `/api/games/${S.code}/admin/remove-team`, { teamId: d.remove }); await refresh(true); } return; }
      if (d.resetPin) { const pin = prompt('New PIN for this team (4+ characters):'); if (pin) { await api('POST', `/api/games/${S.code}/admin/team-pin`, { teamId: d.resetPin, pin }); toast('PIN updated', 'ok'); } return; }
    } catch (err) {
      toast(err.message, 'err');
      if (t.tagName === 'BUTTON') t.disabled = false;
      if (err.status === 422) refresh(true);
    }
  });

  document.addEventListener('mousemove', e => {
    const cell = e.target.closest('[data-cell]');
    if (cell) { cellTip(e, cell); return; }
    if (e.target.closest('[data-chart]')) { chartHover(e); return; }
    if (!$tip.classList.contains('hidden')) hideTip();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); if (S.mode) { S.mode = null; S.modeSlot = null; render(); } } });

  // Countdown clocks
  function tickClock() {
    document.querySelectorAll('[data-deadline]').forEach(el => {
      const left = Math.max(0, Math.round((Number(el.dataset.deadline) - (Date.now() + S.skew)) / 1000));
      el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
      el.classList.toggle('urgent', left <= 30);
    });
  }
  setInterval(tickClock, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.code) refresh(true); });

  route();
})();
