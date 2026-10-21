'use strict';
// Multiplayer server for the Positioning Simulation Game.
// Zero dependencies: Node's http module, Server-Sent Events for live updates,
// and atomic JSON files for persistence (one file per game in DATA_DIR).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 64 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- storage
const games = new Map();      // code -> game
const streams = new Map();    // code -> Set<{res, teamId, admin}>
const lastSeen = new Map();   // `${code}:${teamId}` -> ms

function gameFile(code) { return path.join(DATA_DIR, `game-${code}.json`); }

function loadAll() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/^game-[A-Z0-9]+\.json$/.test(f)) continue;
    try {
      const g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      games.set(g.code, g);
    } catch (e) {
      console.error('Could not load', f, e.message);
    }
  }
  console.log(`Loaded ${games.size} saved game(s) from ${DATA_DIR}`);
}

function save(game) {
  game.version = (game.version || 0) + 1;
  game.updatedAt = Date.now();
  const file = gameFile(game.code);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(game));
  fs.renameSync(tmp, file);
  broadcast(game);
}

function broadcast(game) {
  const set = streams.get(game.code);
  if (!set) return;
  const msg = `data: ${JSON.stringify({ version: game.version, phase: game.phase, round: game.round })}\n\n`;
  for (const s of set) {
    try { s.res.write(msg); } catch (_) { /* closed */ }
  }
}

// ---------------------------------------------------------------- helpers
const token = () => crypto.randomBytes(18).toString('base64url');
const hashPin = (code, pin) => crypto.createHash('sha256').update(`${code}:${String(pin)}`).digest('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!games.has(c)) return c;
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function getGame(code) {
  const g = games.get(String(code || '').toUpperCase());
  if (!g) throw new HttpError(404, 'Game not found. Check the game code.');
  return g;
}

function authOf(req, url, game) {
  const t = req.headers['x-token'] || url.searchParams.get('token') || '';
  if (!t) return { role: 'public' };
  if (game.admin.token === t) return { role: 'admin' };
  const team = game.teams.find(x => x.token === t);
  if (team) return { role: 'team', team };
  return { role: 'public' };
}

function requireAdmin(auth) { if (auth.role !== 'admin') throw new HttpError(403, 'Facilitator access required.'); }
function requireTeam(auth) { if (auth.role !== 'team') throw new HttpError(403, 'Join the game as a team first.'); }

function cleanName(s, max) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

function intIn(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function decisionsFor(game, round) {
  game.decisions[round] = game.decisions[round] || {};
  return game.decisions[round];
}

// ---------------------------------------------------------------- game flow
function startRound(game, round) {
  game.phase = 'decision';
  game.round = round;
  game.roundStartedAt = Date.now();
  game.deadline = game.settings.roundSeconds > 0 ? Date.now() + game.settings.roundSeconds * 1000 : null;
  decisionsFor(game, round);
}

function processCurrentRound(game, reason) {
  if (game.phase !== 'decision') return false;
  const round = game.round;
  const subs = decisionsFor(game, round);
  const actions = {};
  for (const t of game.teams) if (subs[t.id]) actions[t.id] = subs[t.id].actions;
  const record = E.processRound(game.teams, actions, round, game.settings);
  record.reason = reason;
  record.news = E.buildNews(record, game.history[game.history.length - 1], game.teams);
  game.history.push(record);
  game.phase = 'results';
  game.deadline = game.settings.resultsSeconds > 0 ? Date.now() + game.settings.resultsSeconds * 1000 : null;
  console.log(`[${game.code}] round ${round} processed (${reason})`);
  return true;
}

function advance(game) {
  if (game.phase !== 'results') return false;
  if (game.round >= game.settings.totalRounds) {
    game.phase = 'finished';
    game.deadline = null;
    game.finishedAt = Date.now();
  } else {
    startRound(game, game.round + 1);
  }
  return true;
}

function maybeAutoProcess(game) {
  if (game.phase !== 'decision' || !game.settings.autoProcess || !game.teams.length) return false;
  const subs = decisionsFor(game, game.round);
  if (game.teams.every(t => subs[t.id])) return processCurrentRound(game, 'all-submitted');
  return false;
}

// Timers survive restarts because deadlines are stored as timestamps.
setInterval(() => {
  const now = Date.now();
  for (const game of games.values()) {
    if (!game.deadline || now < game.deadline) continue;
    try {
      if (game.phase === 'decision' && processCurrentRound(game, 'timer')) save(game);
      else if (game.phase === 'results' && advance(game)) save(game);
      else { game.deadline = null; save(game); }
    } catch (e) {
      console.error(`[${game.code}] timer error`, e);
      game.deadline = null;
    }
  }
}, 1000);

// ---------------------------------------------------------------- views
function publicSettings(s) {
  return {
    totalRounds: s.totalRounds, maxTeams: s.maxTeams, startBudget: s.startBudget, maxProducts: s.maxProducts,
    cellCost: s.cellCost, loyaltyRate: s.loyaltyRate, autoProcess: s.autoProcess,
    roundSeconds: s.roundSeconds, resultsSeconds: s.resultsSeconds, revealPositions: s.revealPositions,
  };
}

function publicRecord(rec, reveal) {
  const teams = {};
  for (const [id, t] of Object.entries(rec.teams)) {
    teams[id] = {
      sales: t.sales, costs: t.costs, positioningCost: t.positioningCost, penalty: t.penalty,
      profit: t.profit, acc: t.acc, accBefore: t.accBefore, marketShare: t.marketShare,
      bestProduct: t.bestProduct, productCount: t.productCount, withdrawnCount: t.withdrawnCount,
      profitRank: t.profitRank, accRank: t.accRank, missed: t.missed,
      products: reveal ? t.products.map(p => ({ slot: p.slot, cell: p.cell, sales: p.sales, competitors: p.competitors })) : null,
    };
  }
  return {
    round: rec.round, processedAt: rec.processedAt, teams, cellCounts: rec.cellCounts,
    totals: rec.totals, averages: rec.averages, news: rec.news,
    top10: rec.top10.map(p => (reveal ? p : { teamId: p.teamId, slot: p.slot, sales: p.sales })),
  };
}

function online(game, teamId) {
  return Date.now() - (lastSeen.get(`${game.code}:${teamId}`) || 0) < 15000;
}

function view(game, auth) {
  const subs = game.decisions[game.round] || {};
  const v = {
    code: game.code, title: game.title, phase: game.phase, round: game.round,
    deadline: game.deadline, serverNow: Date.now(), version: game.version,
    settings: publicSettings(game.settings),
    teams: game.teams.map(t => ({
      id: t.id, name: t.name, color: t.color, acc: t.acc, submitted: !!subs[t.id],
      online: online(game, t.id),
      activeProducts: t.products.filter(p => p.status === 'active').length,
    })),
    history: game.history.map(r => publicRecord(r, game.settings.revealPositions)),
    role: auth.role,
  };
  if (auth.role === 'team') {
    const t = auth.team;
    v.me = {
      id: t.id, name: t.name, color: t.color, acc: t.acc, products: t.products,
      decision: subs[t.id] || null,
      draft: (game.drafts && game.drafts[t.id] && game.drafts[t.id].round === game.round) ? game.drafts[t.id].actions : null,
      // Only this team's own past actions and full product detail; never other teams'.
      history: game.history.map(r => ({
        round: r.round, actions: r.teams[t.id] ? r.teams[t.id].actions : [],
        products: r.teams[t.id] ? r.teams[t.id].products : [], missed: r.teams[t.id] ? r.teams[t.id].missed : true,
      })),
    };
  }
  if (auth.role === 'admin') {
    v.admin = {
      decisions: subs,
      teams: game.teams.map(t => ({ id: t.id, name: t.name, color: t.color, acc: t.acc, products: t.products, joinedAt: t.joinedAt })),
      fullHistory: game.history,
    };
  }
  return v;
}

// ---------------------------------------------------------------- export
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(game) {
  const name = id => (game.teams.find(t => t.id === id) || {}).name || id;
  const rows = [['Round', 'Team', 'Sales', 'Positioning cost', 'Withdrawal penalty', 'Net profit', 'Accumulated profit', 'Profit rank', 'Accumulated rank', 'Market share %', 'Products', 'Missed submission', 'Actions', 'Product detail']];
  for (const r of game.history) {
    for (const [id, t] of Object.entries(r.teams)) {
      const actions = t.actions.map(a => a.type === 'launch' ? `launch #${a.slot} ${a.cell} (${a.cost})` : a.type === 'move' ? `move #${a.slot} ${a.from}->${a.cell} (${a.cost})` : `withdraw #${a.slot} ${a.from} (penalty ${a.cost})`).join('; ');
      const detail = t.products.map(p => `#${p.slot} ${p.cell}: ${p.sales}`).join('; ');
      rows.push([r.round, name(id), t.sales, t.positioningCost, t.penalty, t.profit, t.acc, t.profitRank, t.accRank, t.marketShare, t.productCount, t.missed ? 'yes' : 'no', actions, detail]);
    }
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\n');
}

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','games',code,...]
  const method = req.method;

  if (parts[1] === 'health') return send(res, 200, { ok: true, games: games.size });
  if (parts[1] === 'rules') return send(res, 200, { demand: E.DEMAND, rows: E.ROWS, segments: E.SEGMENTS, defaults: E.DEFAULT_SETTINGS });

  if (parts[1] !== 'games') throw new HttpError(404, 'Not found');

  // POST /api/games : create a game (facilitator)
  if (parts.length === 2 && method === 'POST') {
    const body = await readBody(req);
    const pin = String(body.adminPin || '').trim();
    if (pin.length < 4) throw new HttpError(400, 'Facilitator PIN must be at least 4 characters.');
    const s = body.settings || {};
    const settings = {
      ...E.DEFAULT_SETTINGS,
      totalRounds: intIn(s.totalRounds, 1, 8, 8),
      maxTeams: intIn(s.maxTeams, 1, 10, 10),
      autoProcess: s.autoProcess !== false,
      roundSeconds: intIn(s.roundSeconds, 0, 3600, 0),
      resultsSeconds: intIn(s.resultsSeconds, 0, 3600, 0),
      revealPositions: s.revealPositions !== false,
    };
    const code = newCode();
    const adminToken = token();
    const game = {
      code, title: cleanName(body.title, 60) || 'Positioning Strategy Game', createdAt: Date.now(),
      settings, admin: { pinHash: hashPin(code, pin), token: adminToken },
      phase: 'lobby', round: 0, deadline: null, teams: [], decisions: {}, drafts: {}, history: [], version: 0,
    };
    games.set(code, game);
    save(game);
    return send(res, 201, { code, adminToken });
  }

  const game = getGame(parts[2]);
  const action = parts.slice(3).join('/');
  const auth = authOf(req, url, game);
  if (auth.role === 'team') lastSeen.set(`${game.code}:${auth.team.id}`, Date.now());

  if (action === 'state' && method === 'GET') return send(res, 200, view(game, auth));

  if (action === 'stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\ndata: ${JSON.stringify({ version: game.version })}\n\n`);
    const entry = { res, teamId: auth.role === 'team' ? auth.team.id : null };
    if (!streams.has(game.code)) streams.set(game.code, new Set());
    streams.get(game.code).add(entry);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { /* closed */ }
      if (entry.teamId) lastSeen.set(`${game.code}:${entry.teamId}`, Date.now());
    }, 10000);
    req.on('close', () => { clearInterval(ping); streams.get(game.code)?.delete(entry); });
    return;
  }

  if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await readBody(req);

  // Optimistic guard: clients send the round they are looking at, so a double
  // click or a stale tab can never skip a round.
  if (body.round !== undefined && Number(body.round) !== game.round) {
    throw new HttpError(409, `The game has moved on (now round ${game.round}, ${game.phase}). Refreshing...`);
  }

  switch (action) {
    case 'join': {
      const name = cleanName(body.teamName, 30);
      const pin = String(body.pin || '').trim();
      if (!name) throw new HttpError(400, 'Enter a team name.');
      if (pin.length < 4) throw new HttpError(400, 'Team PIN must be at least 4 characters.');
      const existing = game.teams.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (existing.pinHash !== hashPin(game.code, `team:${pin}`)) throw new HttpError(403, 'That team name is taken and the PIN does not match. Choose another name, or enter your team\'s PIN to rejoin.');
        return send(res, 200, { teamId: existing.id, token: existing.token, rejoined: true });
      }
      if (game.phase !== 'lobby') throw new HttpError(409, 'This game has already started - new teams cannot join. Existing teams can rejoin with their name and PIN.');
      if (game.teams.length >= game.settings.maxTeams) throw new HttpError(409, `This game is full (${game.settings.maxTeams} teams).`);
      const used = new Set(game.teams.map(t => t.color));
      const color = E.TEAM_COLORS.find(c => !used.has(c.hex)) || E.TEAM_COLORS[game.teams.length % E.TEAM_COLORS.length];
      const team = {
        id: `t${crypto.randomBytes(4).toString('hex')}`, name, color: color.hex, colorName: color.name,
        pinHash: hashPin(game.code, `team:${pin}`), token: token(), joinedAt: Date.now(),
        ...E.newTeamState(game.settings),
      };
      game.teams.push(team);
      save(game);
      return send(res, 201, { teamId: team.id, token: team.token, rejoined: false });
    }

    case 'admin/login': {
      if (game.admin.pinHash !== hashPin(game.code, String(body.pin || '').trim())) throw new HttpError(403, 'Wrong facilitator PIN.');
      return send(res, 200, { adminToken: game.admin.token });
    }

    case 'draft': { // autosave of an unsubmitted plan, so a refresh or a second laptop keeps it
      requireTeam(auth);
      if (game.phase !== 'decision') return send(res, 200, { ok: true });
      const actions = Array.isArray(body.actions) ? body.actions.slice(0, 40) : [];
      game.drafts = game.drafts || {};
      game.drafts[auth.team.id] = { round: game.round, actions };
      save(game);
      return send(res, 200, { ok: true });
    }

    case 'decision': {
      requireTeam(auth);
      if (game.phase !== 'decision') throw new HttpError(409, 'Decisions are closed for this round.');
      const ev = E.evaluateDecision(auth.team, body.actions, game.settings);
      if (!ev.ok) return send(res, 422, { error: ev.errors.join(' '), errors: ev.errors, cost: ev.cost });
      decisionsFor(game, game.round)[auth.team.id] = {
        actions: body.actions.map(a => ({ type: a.type, slot: a.slot, cell: a.cell })),
        lines: ev.lines, cost: ev.cost, submittedAt: Date.now(),
      };
      maybeAutoProcess(game);
      save(game);
      return send(res, 200, { ok: true, cost: ev.cost });
    }

    case 'decision/cancel': {
      requireTeam(auth);
      if (game.phase !== 'decision') throw new HttpError(409, 'Decisions are closed for this round.');
      delete decisionsFor(game, game.round)[auth.team.id];
      save(game);
      return send(res, 200, { ok: true });
    }

    case 'admin/start': {
      requireAdmin(auth);
      if (game.phase !== 'lobby') throw new HttpError(409, 'The game has already started.');
      if (!game.teams.length) throw new HttpError(409, 'At least one team must join before starting.');
      startRound(game, 1);
      save(game);
      return send(res, 200, { ok: true });
    }

    case 'admin/process': {
      requireAdmin(auth);
      if (!processCurrentRound(game, 'facilitator')) throw new HttpError(409, 'There is no open decision round to process.');
      save(game);
      return send(res, 200, { ok: true });
    }

    case 'admin/next': {
      requireAdmin(auth);
      if (!advance(game)) throw new HttpError(409, 'Results are not being shown right now.');
      save(game);
      return send(res, 200, { ok: true });
    }

    case 'admin/settings': {
      requireAdmin(auth);
      const s = game.settings;
      if (body.autoProcess !== undefined) s.autoProcess = !!body.autoProcess;
      if (body.revealPositions !== undefined) s.revealPositions = !!body.revealPositions;
      if (body.roundSeconds !== undefined) s.roundSeconds = intIn(body.roundSeconds, 0, 3600, 0);
      if (body.resultsSeconds !== undefined) s.resultsSeconds = intIn(body.resultsSeconds, 0, 3600, 0);
      if (body.totalRounds !== undefined) s.totalRounds = intIn(body.totalRounds, Math.max(1, game.round), 8, s.totalRounds);
      maybeAutoProcess(game);
      save(game);
      return send(res, 200, { ok: true });
    }

    case 'admin/timer': { // set / extend / clear the countdown for the current phase
      requireAdmin(auth);
      const secs = intIn(body.seconds, 0, 3600, 0);
      if (body.mode === 'clear' || secs === 0) game.deadline = null;
      else if (body.mode === 'extend' && game.deadline) game.deadline += secs * 1000;
      else game.deadline = Date.now() + secs * 1000;
      save(game);
      return send(res, 200, { ok: true });
    }

    case 'admin/remove-team': {
      requireAdmin(auth);
      if (game.phase !== 'lobby') throw new HttpError(409, 'Teams can only be removed before the game starts.');
      game.teams = game.teams.filter(t => t.id !== body.teamId);
      save(game);
      return send(res, 200, { ok: true });
    }

    case 'admin/team-pin': {
      requireAdmin(auth);
      const team = game.teams.find(t => t.id === body.teamId);
      if (!team) throw new HttpError(404, 'Team not found.');
      const pin = String(body.pin || '').trim();
      if (pin.length < 4) throw new HttpError(400, 'PIN must be at least 4 characters.');
      team.pinHash = hashPin(game.code, `team:${pin}`);
      save(game);
      return send(res, 200, { ok: true });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
}

function exportRoute(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // export/<code>.<ext>
  const m = /^([A-Z0-9]+)\.(csv|json)$/i.exec(parts[1] || '');
  if (!m) throw new HttpError(404, 'Not found');
  const game = getGame(m[1]);
  requireAdmin(authOf(req, url, game));
  if (m[2].toLowerCase() === 'csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="positioning-${game.code}.csv"` });
    return res.end(exportCsv(game));
  }
  const safe = { ...game, admin: undefined, teams: game.teams.map(({ token: _t, pinHash: _p, ...t }) => t) };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="positioning-${game.code}.json"` });
  return res.end(JSON.stringify(safe, null, 2));
}

// ---------------------------------------------------------------- static
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/engine.js') return sendFile(res, path.join(__dirname, 'engine.js'));
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/how-to-play') p = '/how-to-play.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  return sendFile(res, file);
}

function sendFile(res, file) {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (url.pathname.startsWith('/export/')) exportRoute(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error - please retry.' : e.message });
    else res.end();
  }
});

if (require.main === module) {
  loadAll();
  server.listen(PORT, () => console.log(`Positioning game running on http://localhost:${PORT}`));
}

module.exports = { server, games, loadAll };
