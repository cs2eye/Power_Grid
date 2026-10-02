// Plays complete AI-only games and checks rule invariants after every action.
// Run with: node test/simulate.js [games]
const assert = require('assert');
require('../js/data.js');
require('../js/engine.js');
require('../js/ai.js');
const { Engine: E, AI, RESOURCES, RESOURCE_TOTAL, PLANTS } = globalThis.PG;

const games = Number(process.argv[2] || 60);
const COLORS = ['red', 'blue', 'green', 'purple'];

function checkInvariants(s) {
  for (const r of RESOURCES) {
    const held = s.players.reduce((sum, p) => sum + p.resources[r], 0);
    assert.strictEqual(s.resMarket[r] + s.supply[r] + held, RESOURCE_TOTAL[r], `${r} not conserved`);
    assert(s.resMarket[r] >= 0 && s.supply[r] >= 0, `${r} negative`);
  }
  for (const p of s.players) {
    assert(p.money >= 0, `${p.name} has negative money`);
    if (!s.discard) assert(p.plants.length <= s.rules.maxPlants, `${p.name} has too many plants`);
    assert(E.canHold(p.plants, p.resources) || s.discard, `${p.name} stores too much`);
  }
  for (const [id, owners] of Object.entries(s.cityOwners)) {
    assert(owners.length <= s.step, `${id} over capacity`);
    assert.strictEqual(new Set(owners).size, owners.length, `${id} duplicate owner`);
  }
  const marketCards = new Set(s.market);
  assert.strictEqual(marketCards.size, s.market.length, 'duplicate plant in market');
  for (const n of s.market) assert(PLANTS[n], `unknown plant ${n}`);
}

const stats = {};
for (let g = 0; g < games; g++) {
  const n = 2 + (g % 3);
  const s = E.newGame({
    seed: 1000 + g,
    players: Array.from({ length: n }, (_, i) => ({ name: `AI ${i + 1}`, color: COLORS[i], isAI: true })),
  });
  let actions = 0;
  while (s.phase !== 'gameover') {
    const pend = E.pending(s);
    const action = AI.decide(s, pend);
    E.act(s, action);
    checkInvariants(s);
    if (++actions > 20000 || s.round > 80) throw new Error(`Game ${g} (${n}p) did not finish: round ${s.round}`);
  }
  const st = (stats[n] ||= { games: 0, rounds: 0, step3: 0, winCities: 0 });
  st.games++;
  st.rounds += s.round;
  st.step3 += s.step === 3 ? 1 : 0;
  st.winCities += s.lastPower[s.winner];
}
for (const [n, st] of Object.entries(stats)) {
  console.log(`${n} players: ${st.games} games, avg ${(st.rounds / st.games).toFixed(1)} rounds, ` +
    `reached step 3 in ${st.step3}, winner powered ${(st.winCities / st.games).toFixed(1)} cities on average`);
}
console.log('All games finished with invariants intact.');
