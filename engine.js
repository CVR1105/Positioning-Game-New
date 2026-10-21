(function (root) {
'use strict';
// Pure game logic for the Marketing & Positioning Simulation Game.
// No I/O here: server.js owns persistence, auth and networking.

const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']; // A = best style/look, J = basic
const COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];                      // 10 = best quality

// Market demand per positioning cell (from the "Mkt Info" sheet). J1 = START (no demand).
const DEMAND = [
  [50, 50, 100, 50, 100, 150, 300, 600, 1000, 1500],   // A
  [50, 100, 200, 100, 50, 100, 150, 300, 600, 1000],   // B
  [100, 200, 400, 200, 100, 50, 100, 150, 300, 600],   // C
  [200, 400, 800, 400, 200, 100, 50, 100, 150, 300],   // D
  [100, 200, 400, 200, 100, 50, 100, 50, 100, 150],    // E
  [100, 150, 300, 150, 100, 50, 50, 100, 50, 100],     // F
  [150, 300, 600, 300, 150, 50, 100, 200, 100, 50],    // G
  [300, 600, 1000, 600, 300, 100, 200, 400, 200, 100], // H
  [150, 300, 600, 300, 150, 200, 400, 800, 400, 200],  // I
  [0, 150, 300, 150, 50, 100, 200, 400, 200, 100],     // J (J1 = START)
];

const SEGMENTS = {
  A10: 'Status Seekers',
  D3: 'Fashion Conscious',
  H3: 'Budget Conscious',
  I8: 'Quality Focused',
};

const START = 'J1';

const DEFAULT_SETTINGS = {
  totalRounds: 8,
  maxTeams: 10,
  startBudget: 5000,
  maxProducts: 20,
  cellCost: 200,
  loyaltyRate: 0.10,
  autoProcess: true,      // process the round as soon as every team has submitted
  roundSeconds: 0,        // 0 = no decision timer
  resultsSeconds: 0,      // 0 = facilitator opens the next round manually
  revealPositions: true,  // show competitors' product cells/sales in results (as in the original game)
};

const TEAM_COLORS = [
  { name: 'Blue', hex: '#3987e5' },
  { name: 'Orange', hex: '#d95926' },
  { name: 'Aqua', hex: '#199e70' },
  { name: 'Yellow', hex: '#c98500' },
  { name: 'Magenta', hex: '#d55181' },
  { name: 'Green', hex: '#2f9e2f' },
  { name: 'Violet', hex: '#9085e9' },
  { name: 'Red', hex: '#e66767' },
  { name: 'Brown', hex: '#a8754a' },
  { name: 'Slate', hex: '#8a9bb0' },
];

function parseCell(cell) {
  if (typeof cell !== 'string') return null;
  const m = /^([A-J])(10|[1-9])$/.exec(cell.trim().toUpperCase());
  if (!m) return null;
  return { r: ROWS.indexOf(m[1]), c: Number(m[2]) - 1, id: m[1] + m[2] };
}

function demandOf(cell) {
  const p = parseCell(cell);
  return p ? DEMAND[p.r][p.c] : 0;
}

// Horizontal/vertical moves only, so cost is Manhattan distance x cell cost.
function distance(a, b) {
  const pa = parseCell(a), pb = parseCell(b);
  if (!pa || !pb) return 0;
  return Math.abs(pa.r - pb.r) + Math.abs(pa.c - pb.c);
}

function loyaltyBonus(streak, rate) {
  return Math.pow(1 + rate, streak) - 1;
}

// Penalty for withdrawing a launched product (house rule: double penalty).
//  - loss-making product (lifetime sales < lifetime positioning spend): 2 x lifetime loss
//  - otherwise: 2 x the cost of taking it back to START (the original sheet's withdrawal cost)
function withdrawPenalty(product, settings) {
  const loss = product.lifeCost - product.lifeSales;
  if (loss > 0) return { penalty: 2 * loss, basis: 'loss', loss };
  const exit = distance(product.cell, START) * settings.cellCost;
  return { penalty: 2 * exit, basis: 'exit', exitCost: exit };
}

function activeProducts(team) {
  return team.products.filter(p => p.status === 'active');
}

// Validate a team's decision and compute its cost. Returns {ok, errors, cost, lines}.
function evaluateDecision(team, actions, settings) {
  const errors = [];
  const lines = [];
  let positioning = 0, penalties = 0;
  if (!Array.isArray(actions)) return { ok: false, errors: ['Decision must be a list of actions.'], cost: 0, lines };
  if (actions.length > 40) return { ok: false, errors: ['Too many actions.'], cost: 0, lines };

  const touched = new Set();
  let launches = 0;
  for (const a of actions) {
    if (!a || typeof a !== 'object') { errors.push('Invalid action.'); continue; }
    if (a.type === 'launch') {
      const p = parseCell(a.cell);
      if (!p) { errors.push(`Invalid cell "${a.cell}".`); continue; }
      if (p.id === START) { errors.push('A new product cannot be launched in J1 (START) - it has no demand.'); continue; }
      launches++;
      const cost = distance(START, p.id) * settings.cellCost;
      positioning += cost;
      lines.push({ type: 'launch', cell: p.id, cost });
    } else if (a.type === 'move' || a.type === 'withdraw') {
      const prod = team.products.find(x => x.slot === Number(a.slot));
      if (!prod) { errors.push(`Product #${a.slot} does not exist.`); continue; }
      if (prod.status !== 'active') { errors.push(`Product #${a.slot} has already been withdrawn.`); continue; }
      if (touched.has(prod.slot)) { errors.push(`Product #${prod.slot} has more than one action this round.`); continue; }
      touched.add(prod.slot);
      if (a.type === 'move') {
        const p = parseCell(a.cell);
        if (!p) { errors.push(`Invalid cell "${a.cell}".`); continue; }
        if (p.id === prod.cell) { errors.push(`Product #${prod.slot} is already in ${p.id}.`); continue; }
        if (p.id === START) { errors.push('Products cannot be moved back to J1 (START). Use withdraw instead.'); continue; }
        const cost = distance(prod.cell, p.id) * settings.cellCost;
        positioning += cost;
        lines.push({ type: 'move', slot: prod.slot, from: prod.cell, cell: p.id, cost });
      } else {
        const w = withdrawPenalty(prod, settings);
        penalties += w.penalty;
        lines.push({ type: 'withdraw', slot: prod.slot, from: prod.cell, cost: w.penalty, basis: w.basis });
      }
    } else {
      errors.push(`Unknown action type "${a.type}".`);
    }
  }

  if (team.products.length + launches > settings.maxProducts) {
    errors.push(`Maximum ${settings.maxProducts} products per team during the game (withdrawn products still count). You have used ${team.products.length}.`);
  }
  const cost = positioning + penalties;
  if (cost > team.acc) {
    errors.push(`Total cost ${cost} exceeds your budget (accumulated profit) of ${team.acc}.`);
  }
  // House rule: at least one move every round. Only waived when no move is affordable.
  if (lines.length === 0 && errors.length === 0) {
    if (team.acc >= settings.cellCost) errors.push('You must make at least one move this round (launch, reposition or withdraw a product).');
  }
  return { ok: errors.length === 0, errors, cost, positioning, penalties, lines };
}

function newTeamState(settings) {
  return { acc: settings.startBudget, products: [] };
}

// Process one round for all teams. Mutates teams; returns the round record.
// decisions: { [teamId]: actions[] | undefined } (undefined = team did not submit)
function processRound(teams, decisions, round, settings) {
  const perTeam = {};

  // 1. Apply decisions (costs, launches, repositions, withdrawals).
  for (const team of teams) {
    const actions = decisions[team.id];
    const missed = actions === undefined;
    let ev = missed ? { ok: true, lines: [], positioning: 0, penalties: 0, cost: 0 } : evaluateDecision(team, actions, settings);
    if (!ev.ok) ev = { ok: true, lines: [], positioning: 0, penalties: 0, cost: 0, rejected: ev.errors }; // safety net; validated on submit
    const movedSlots = new Set();
    const roundCostBySlot = {};
    for (const line of ev.lines) {
      if (line.type === 'launch') {
        const slot = team.products.length + 1;
        team.products.push({
          slot, cell: line.cell, status: 'active', launchedRound: round, streak: 0,
          lastSales: 0, lifeSales: 0, lifeCost: line.cost, withdrawnRound: null, penaltyPaid: 0,
          path: [{ round, cell: line.cell }],
        });
        line.slot = slot;
        movedSlots.add(slot);
        roundCostBySlot[slot] = line.cost;
      } else if (line.type === 'move') {
        const prod = team.products.find(p => p.slot === line.slot);
        prod.cell = line.cell;
        prod.lifeCost += line.cost;
        prod.path.push({ round, cell: line.cell });
        movedSlots.add(prod.slot);
        roundCostBySlot[prod.slot] = line.cost;
      } else if (line.type === 'withdraw') {
        const prod = team.products.find(p => p.slot === line.slot);
        prod.status = 'withdrawn';
        prod.withdrawnRound = round;
        prod.penaltyPaid = line.cost;
        prod.lastSales = 0;
        prod.path.push({ round, cell: null });
      }
    }
    perTeam[team.id] = {
      missed, rejected: ev.rejected || null, actions: ev.lines,
      positioningCost: ev.positioning, penalty: ev.penalties, costs: ev.cost,
      movedSlots, roundCostBySlot, accBefore: team.acc,
    };
  }

  // 2. Count competing products per cell.
  const cellCounts = {};
  for (const team of teams) for (const p of activeProducts(team)) cellCounts[p.cell] = (cellCounts[p.cell] || 0) + 1;

  // 3. Sales: equal share of cell demand x (1 + compounding loyalty bonus for unmoved products).
  const allProducts = [];
  let totalSales = 0;
  for (const team of teams) {
    const t = perTeam[team.id];
    let sales = 0;
    const products = [];
    for (const p of activeProducts(team)) {
      const fresh = t.movedSlots.has(p.slot);
      p.streak = fresh ? 0 : p.streak + 1;
      const bonus = loyaltyBonus(p.streak, settings.loyaltyRate);
      const share = demandOf(p.cell) / cellCounts[p.cell];
      const s = Math.round(share * (1 + bonus));
      p.lastSales = s;
      p.lifeSales += s;
      sales += s;
      const rec = {
        slot: p.slot, cell: p.cell, sales: s, baseShare: Math.round(share), competitors: cellCounts[p.cell],
        loyalty: Math.round(bonus * 1000) / 10, status: p.launchedRound === round ? 'new' : (fresh ? 'moved' : 'held'),
        roundCost: t.roundCostBySlot[p.slot] || 0, lifeSales: p.lifeSales, lifeCost: p.lifeCost,
      };
      products.push(rec);
      allProducts.push({ teamId: team.id, ...rec });
    }
    t.sales = sales;
    t.products = products;
    totalSales += sales;
  }

  // 4. Profit, accumulated profit, ranks.
  for (const team of teams) {
    const t = perTeam[team.id];
    t.profit = t.sales - t.costs;
    team.acc += t.profit;
    t.acc = team.acc;
    t.marketShare = totalSales > 0 ? Math.round((t.sales / totalSales) * 1000) / 10 : 0;
    t.bestProduct = t.products.reduce((m, p) => Math.max(m, p.sales), 0);
    t.productCount = t.products.length;
    t.withdrawnCount = team.products.filter(p => p.status === 'withdrawn').length;
    delete t.movedSlots; delete t.roundCostBySlot;
  }
  const rankBy = key => {
    const sorted = [...teams].sort((a, b) => perTeam[b.id][key] - perTeam[a.id][key]);
    sorted.forEach((tm, i) => {
      // ties share the same rank
      const prev = sorted[i - 1];
      perTeam[tm.id][key + 'Rank'] = prev && perTeam[prev.id][key] === perTeam[tm.id][key] ? perTeam[prev.id][key + 'Rank'] : i + 1;
    });
  };
  rankBy('profit');
  rankBy('acc');

  const n = teams.length || 1;
  const sum = k => teams.reduce((s, tm) => s + perTeam[tm.id][k], 0);
  const totals = {
    sales: totalSales, costs: sum('costs'), profit: sum('profit'), acc: sum('acc'),
    products: allProducts.length,
  };
  const averages = {
    sales: Math.round(totals.sales / n), costs: Math.round(totals.costs / n),
    profit: Math.round(totals.profit / n), acc: Math.round(totals.acc / n),
    products: Math.round((totals.products / n) * 10) / 10,
  };
  const top10 = [...allProducts].sort((a, b) => b.sales - a.sales).slice(0, 10)
    .map(p => ({ teamId: p.teamId, slot: p.slot, cell: p.cell, sales: p.sales }));

  return { round, processedAt: Date.now(), teams: perTeam, cellCounts, totals, averages, top10 };
}

// Headlines for the results "news ticker", built only from public information.
function buildNews(record, prevRecord, teams) {
  const name = id => (teams.find(t => t.id === id) || {}).name || 'A team';
  const news = [];
  const ids = Object.keys(record.teams);
  const leader = ids.find(id => record.teams[id].accRank === 1);
  if (leader) news.push(`${name(leader)} lead the market with ${record.teams[leader].acc.toLocaleString('en-US')} accumulated profit.`);
  if (prevRecord) {
    const prevLeader = Object.keys(prevRecord.teams).find(id => prevRecord.teams[id].accRank === 1);
    if (prevLeader && leader && prevLeader !== leader) news.push(`New market leader! ${name(leader)} overtake ${name(prevLeader)}.`);
    for (const id of ids) {
      const before = prevRecord.teams[id];
      if (!before) continue;
      const jump = before.accRank - record.teams[id].accRank;
      if (jump >= 2) news.push(`${name(id)} climb ${jump} places to #${record.teams[id].accRank}.`);
      if (jump <= -2) news.push(`${name(id)} slip ${-jump} places to #${record.teams[id].accRank}.`);
    }
  }
  const bestProfit = ids.reduce((b, id) => (!b || record.teams[id].profit > record.teams[b].profit ? id : b), null);
  if (bestProfit) news.push(`Most profitable this round: ${name(bestProfit)} (+${record.teams[bestProfit].profit.toLocaleString('en-US')}).`);
  for (const [cell, seg] of Object.entries(SEGMENTS)) {
    const c = record.cellCounts[cell] || 0;
    if (c >= 3) news.push(`${seg} segment (${cell}) is crowded: ${c} products are splitting ${demandOf(cell)} points of demand.`);
    else if (c === 0) news.push(`Opportunity: nobody serves the ${seg} segment (${cell}, ${demandOf(cell)} points).`);
  }
  if (record.top10[0]) news.push(`Best-selling product: ${name(record.top10[0].teamId)} #${record.top10[0].slot} in ${record.top10[0].cell} with ${record.top10[0].sales} sales.`);
  const withdrawals = ids.reduce((s, id) => s + record.teams[id].actions.filter(a => a.type === 'withdraw').length, 0);
  if (withdrawals) news.push(`${withdrawals} product${withdrawals > 1 ? 's were' : ' was'} withdrawn from the market this round - double penalties applied.`);
  const launches = ids.reduce((s, id) => s + record.teams[id].actions.filter(a => a.type === 'launch').length, 0);
  if (launches) news.push(`${launches} new product${launches > 1 ? 's' : ''} entered the market this round.`);
  return news;
}

const Engine = {
  ROWS, COLS, DEMAND, SEGMENTS, START, DEFAULT_SETTINGS, TEAM_COLORS,
  parseCell, demandOf, distance, loyaltyBonus, withdrawPenalty, activeProducts,
  evaluateDecision, newTeamState, processRound, buildNews,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
