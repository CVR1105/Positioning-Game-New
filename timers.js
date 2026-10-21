'use strict';
// Timer auto-processing, missed submissions, and restart persistence.
const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posgame-t-'));
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const start = () => { const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir }, stdio: 'ignore' }); return p; };
const call = async (m, p, b, t) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { 'X-Token': t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json() }; };
(async () => {
  let srv = start(); await sleep(700);
  const { code, adminToken } = (await call('POST', '/api/games', { adminPin: '1234', settings: { roundSeconds: 2, resultsSeconds: 2, totalRounds: 2 } })).json;
  const a = (await call('POST', `/api/games/${code}/join`, { teamName: 'A', pin: '1111' })).json;
  const b = (await call('POST', `/api/games/${code}/join`, { teamName: 'B', pin: '2222' })).json;
  await call('POST', `/api/games/${code}/admin/start`, {}, adminToken);
  assert.strictEqual((await call('POST', `/api/games/${code}/decision`, { actions: [{ type: 'launch', cell: 'H3' }] }, a.token)).status, 200);
  // B never submits -> timer processes round 1
  await sleep(3200);
  let st = (await call('GET', `/api/games/${code}/state`, null, adminToken)).json;
  assert.ok(st.phase === 'results' || (st.phase === 'decision' && st.round === 2), 'timer processed round 1: ' + st.phase + st.round);
  assert.strictEqual(st.admin.fullHistory[0].teams[b.teamId].missed, true);
  assert.strictEqual(st.admin.fullHistory[0].teams[a.teamId].sales, 1000);
  // restart the server mid-game: state must survive
  srv.kill(); await sleep(400); srv = start(); await sleep(800);
  st = (await call('GET', `/api/games/${code}/state`, null, a.token)).json;
  assert.strictEqual(st.role, 'team', 'team token survives restart');
  assert.strictEqual(st.me.products.length, 1);
  await sleep(2500);
  st = (await call('GET', `/api/games/${code}/state`, null, a.token)).json;
  assert.strictEqual(st.round, 2); 
  // held product earns loyalty in round 2 even though A must still move: launch a second product
  if (st.phase === 'decision') await call('POST', `/api/games/${code}/decision`, { actions: [{ type: 'launch', cell: 'I1' }] }, a.token);
  await sleep(3500);
  st = (await call('GET', `/api/games/${code}/state`, null, a.token)).json;
  assert.ok(['results', 'finished'].includes(st.phase));
  const r2 = st.me.history[1].products.find(p => p.slot === 1);
  assert.strictEqual(r2.sales, 1100, 'held H3 earns 1000 x 1.10');
  await sleep(2500);
  st = (await call('GET', `/api/games/${code}/state`, null, a.token)).json;
  assert.strictEqual(st.phase, 'finished');
  console.log('Timer, missed-submission, restart-persistence and loyalty checks passed.');
  srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
