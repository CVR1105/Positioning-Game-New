'use strict';
// End-to-end test: spins up the server on a temp data dir and plays a full
// game over HTTP with N teams, checking every round's maths and the 8-round finish.
//   node test/simulate.js [teams=6]

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posgame-'));
process.env.DATA_DIR = tmp;
const E = require('../engine');
const { server } = require('../server');

const N = Number(process.argv[2]) || 6;
let BASE;

async function call(method, p, body, tok) {
  const res = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Token': tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

function randomCell() {
  for (;;) {
    const c = E.ROWS[Math.floor(Math.random() * 10)] + (1 + Math.floor(Math.random() * 10));
    if (c !== 'J1') return c;
  }
}

function plan(me, settings, round) {
  // Mix of strategies: launch, move, occasionally withdraw; always >= 1 move when affordable.
  const actions = [];
  const active = me.products.filter(p => p.status === 'active');
  const r = Math.random();
  if (round > 2 && active.length && r < 0.15) actions.push({ type: 'withdraw', slot: active[0].slot });
  else if (active.length && r < 0.45) {
    const p = active[Math.floor(Math.random() * active.length)];
    let cell; do { cell = randomCell(); } while (cell === p.cell);
    actions.push({ type: 'move', slot: p.slot, cell });
  }
  if (me.products.length < settings.maxProducts && (actions.length === 0 || Math.random() < 0.4)) {
    actions.push({ type: 'launch', cell: Math.random() < 0.5 ? ['A10', 'D3', 'H3', 'I8'][Math.floor(Math.random() * 4)] : randomCell() });
  }
  // trim until affordable
  while (actions.length && E.evaluateDecision(me, actions, settings).cost > me.acc) actions.pop();
  if (!actions.length && me.acc >= 200) {
    if (active.length) {
      const p = active[0];
      const nb = E.ROWS[E.parseCell(p.cell).r] + (E.parseCell(p.cell).c === 0 ? 2 : E.parseCell(p.cell).c);
      actions.push({ type: 'move', slot: p.slot, cell: nb });
    } else actions.push({ type: 'launch', cell: 'I1' });
  }
  return actions;
}

(async () => {
  await new Promise(r => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const created = await call('POST', '/api/games', { adminPin: '1234', settings: { totalRounds: 8 } });
  assert.strictEqual(created.status, 201);
  const { code, adminToken } = created.json;

  const teams = [];
  for (let i = 0; i < N; i++) {
    const j = await call('POST', `/api/games/${code}/join`, { teamName: `Team ${i + 1}`, pin: '0000' });
    assert.strictEqual(j.status, 201, JSON.stringify(j.json));
    teams.push({ name: `Team ${i + 1}`, ...j.json });
  }
  // rejoin works, wrong pin refused
  assert.strictEqual((await call('POST', `/api/games/${code}/join`, { teamName: 'team 1', pin: '0000' })).json.token, teams[0].token);
  assert.strictEqual((await call('POST', `/api/games/${code}/join`, { teamName: 'Team 1', pin: '9999' })).status, 403);

  // non-admin cannot start
  assert.strictEqual((await call('POST', `/api/games/${code}/admin/start`, {}, teams[0].token)).status, 403);
  assert.strictEqual((await call('POST', `/api/games/${code}/admin/start`, {}, adminToken)).status, 200);

  for (let round = 1; round <= 8; round++) {
    let st = (await call('GET', `/api/games/${code}/state`, null, adminToken)).json;
    assert.strictEqual(st.phase, 'decision', `round ${round} should be open`);
    assert.strictEqual(st.round, round);
    const accBefore = {};

    for (const [i, t] of teams.entries()) {
      const s = (await call('GET', `/api/games/${code}/state`, null, t.token)).json;
      // privacy: a team never receives other teams' decisions or tokens
      assert.ok(!s.admin && !JSON.stringify(s).includes(teams[(i + 1) % N].token));
      accBefore[t.teamId] = s.me.acc;

      // min-one-move rule
      const empty = await call('POST', `/api/games/${code}/decision`, { actions: [], round }, t.token);
      if (s.me.acc >= 200) assert.strictEqual(empty.status, 422);

      // last team, in round 3: leave unsubmitted so the facilitator has to force-process
      if (round === 3 && i === N - 1) continue;
      const actions = plan(s.me, s.settings, round);
      const r = await call('POST', `/api/games/${code}/decision`, { actions, round }, t.token);
      assert.strictEqual(r.status, 200, `round ${round} ${t.name}: ${JSON.stringify(r.json)} ${JSON.stringify(actions)}`);
    }

    st = (await call('GET', `/api/games/${code}/state`, null, adminToken)).json;
    if (round === 3) {
      assert.strictEqual(st.phase, 'decision');
      // a stale double-click with the wrong round is rejected
      assert.strictEqual((await call('POST', `/api/games/${code}/admin/process`, { round: 2 }, adminToken)).status, 409);
      assert.strictEqual((await call('POST', `/api/games/${code}/admin/process`, { round }, adminToken)).status, 200);
      st = (await call('GET', `/api/games/${code}/state`, null, adminToken)).json;
    }
    assert.strictEqual(st.phase, 'results', `round ${round} should be processed`);
    const rec = st.admin.fullHistory[round - 1];
    assert.strictEqual(rec.round, round);

    // verify maths
    let totalSales = 0;
    for (const t of teams) {
      const tr = rec.teams[t.teamId];
      const sumProducts = tr.products.reduce((s, p) => s + p.sales, 0);
      assert.strictEqual(tr.sales, sumProducts);
      assert.strictEqual(tr.profit, tr.sales - tr.positioningCost - tr.penalty);
      assert.strictEqual(tr.acc, accBefore[t.teamId] + tr.profit);
      assert.ok(tr.acc >= 0, 'budget rule keeps accumulated profit >= 0');
      for (const p of tr.products) {
        const expected = Math.round(E.demandOf(p.cell) / rec.cellCounts[p.cell] * (1 + p.loyalty / 100));
        assert.ok(Math.abs(expected - p.sales) <= 1, `sales maths ${JSON.stringify(p)}`);
      }
      totalSales += tr.sales;
    }
    assert.strictEqual(rec.totals.sales, totalSales);
    console.log(`Round ${round}: ` + teams.map(t => `${t.name}=${rec.teams[t.teamId].acc}`).join('  '));

    const next = await call('POST', `/api/games/${code}/admin/next`, { round }, adminToken);
    assert.strictEqual(next.status, 200);
    // double click of "next" must not skip a round
    const dbl = await call('POST', `/api/games/${code}/admin/next`, { round }, adminToken);
    assert.notStrictEqual(dbl.status, 200);
  }

  const fin = (await call('GET', `/api/games/${code}/state`, null, teams[0].token)).json;
  assert.strictEqual(fin.phase, 'finished');
  assert.strictEqual(fin.history.length, 8);
  const board = [...fin.teams].sort((a, b) => b.acc - a.acc);
  console.log('\nFINAL LEADERBOARD');
  board.forEach((t, i) => console.log(`${i + 1}. ${t.name}  ${t.acc}`));

  // persistence: file on disk reflects final state
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, `game-${code}.json`), 'utf8'));
  assert.strictEqual(saved.phase, 'finished');
  const csv = await fetch(`${BASE}/export/${code}.csv?token=${adminToken}`);
  assert.strictEqual(csv.status, 200);
  assert.strictEqual((await fetch(`${BASE}/export/${code}.csv?token=${teams[0].token}`)).status, 403);

  console.log('\nAll checks passed: 8 rounds completed, maths verified, privacy and persistence OK.');
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
