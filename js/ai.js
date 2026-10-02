// Heuristic computer opponent. `decide(state, pending)` returns an action for the
// engine. It never mutates the state it is given.
(function (root) {
  const PG = (root.PG = root.PG || {});
  const E = PG.Engine;
  const { PLANTS, RESOURCES, CITY_SLOT_COST, CITIES, PAYOUT } = PG;

  const clone = (x) => JSON.parse(JSON.stringify(x));

  // Expected Elektro per run of a plant at today's market prices.
  function fuelCost(s, n) {
    const p = PLANTS[n];
    if (p.type === 'eco') return 0;
    if (p.type === 'hybrid') return Math.min(E.resourceCost(s, 'coal', Math.min(p.inputs, s.resMarket.coal)) + (p.inputs > s.resMarket.coal ? 99 : 0),
      E.resourceCost(s, 'oil', Math.min(p.inputs, s.resMarket.oil)) + (p.inputs > s.resMarket.oil ? 99 : 0));
    const avail = s.resMarket[p.type];
    if (avail < p.inputs) return p.inputs * 9;
    return E.resourceCost(s, p.type, p.inputs);
  }

  // Keep the best plants up to the plant limit.
  function bestKeep(s, plants) {
    const sorted = plants.slice().sort((a, b) => PLANTS[b].output - PLANTS[a].output || b - a);
    return sorted.slice(0, s.rules.maxPlants);
  }

  function growthPerRound(s) {
    return s.step === 1 ? 3 : s.step === 2 ? 4 : 5;
  }

  // How much this AI would pay for a plant. 0 means not interested.
  function plantValue(s, pid, n) {
    const me = s.players[pid];
    const cur = E.capacityOf(me.plants);
    const next = E.capacityOf(bestKeep(s, [...me.plants, n]));
    const gain = next - cur;
    if (gain <= 0) return 0;
    const target = me.cities.length + growthPerRound(s);
    const p = PLANTS[n];
    const runCost = fuelCost(s, n);
    let value = n;
    if (cur < target) value += Math.min(gain, target - cur) * 3;
    else if (gain < 2 && s.round > 1) return 0;
    if (p.type === 'eco') value += 4;
    value -= Math.max(0, runCost - p.output * 3);
    // Keep money for fuel and a city or two.
    const reserve = Math.min(me.money * 0.5, runCost + (me.cities.length ? 15 : 10));
    return Math.max(0, Math.min(Math.round(value), me.money - Math.round(reserve)));
  }

  function choosePlant(s, pend) {
    const me = s.players[pend.player];
    let best = null;
    for (const n of E.currentPlants(s)) {
      if (n > me.money) continue;
      const value = plantValue(s, pend.player, n);
      if (value < n) continue;
      const p = PLANTS[n];
      const gain = E.capacityOf(bestKeep(s, [...me.plants, n])) - E.capacityOf(me.plants);
      const score = gain * 10 + p.output * 2 - fuelCost(s, n) * 1.5 - n * 0.4 + (p.type === 'eco' ? 4 : 0);
      if (!best || score > best.score) best = { n, score };
    }
    if (!best) {
      if (!pend.canPass) {
        const cheapest = Math.min(...E.currentPlants(s));
        return { type: 'choose', plant: cheapest, bid: cheapest };
      }
      return { type: 'pass' };
    }
    const cap = E.capacityOf(me.plants);
    const comfortable = cap >= me.cities.length + growthPerRound(s) + 1;
    if (pend.canPass && comfortable && best.score < 25) return { type: 'pass' };
    return { type: 'choose', plant: best.n, bid: best.n };
  }

  function bid(s, pend) {
    const c = s.auction.current;
    const me = s.players[pend.player];
    const limit = Math.min(me.money, plantValue(s, pend.player, c.plant) + (s.round === 1 ? 2 : 0));
    if (c.bid + 1 <= limit) return { type: 'bid', amount: c.bid + 1 };
    return { type: 'pass' };
  }

  function discard(s, pend) {
    const me = s.players[pend.player];
    const options = me.plants.filter((n) => n !== s.discard.newPlant);
    options.sort((a, b) => PLANTS[a].output - PLANTS[b].output || a - b);
    return { type: 'discard', plant: options[0] };
  }

  // Buy fuel for the most efficient plants first, as far as the network can use them.
  function resources(s, pend) {
    const me = s.players[pend.player];
    const sim = clone(s);
    const purchase = { coal: 0, oil: 0, garbage: 0, uranium: 0 };
    const held = { ...me.resources };
    const reserved = { coal: 0, oil: 0, garbage: 0, uranium: 0 };
    let budget = me.money;
    let spent = 0;
    const cityCost = CITY_SLOT_COST[Math.min(s.step, 3) - 1] + 10;

    const plants = me.plants.slice().sort((a, b) => {
      const ea = PLANTS[a].output / (fuelCost(s, a) + 1), eb = PLANTS[b].output / (fuelCost(s, b) + 1);
      return eb - ea;
    });
    let capPlanned = 0;

    const buyOne = (r) => {
      if (sim.resMarket[r] <= 0) return false;
      const price = E.unitPrice(sim, r);
      const after = { ...held };
      after[r]++;
      if (price > budget || !E.canHold(me.plants, after)) return false;
      budget -= price; spent += price;
      sim.resMarket[r]--; held[r]++; purchase[r]++;
      return true;
    };
    const take = (r) => {
      if (held[r] - reserved[r] > 0) { reserved[r]++; return true; }
      if (buyOne(r)) { reserved[r]++; return true; }
      return false;
    };

    for (const n of plants) {
      const p = PLANTS[n];
      const affordableNew = Math.max(0, Math.floor((budget - fuelCost(s, n)) / cityCost));
      const wanted = Math.min(me.cities.length + Math.max(1, affordableNew), s.rules.end + 2);
      if (capPlanned >= wanted) break;
      if (p.type === 'eco') { capPlanned += p.output; continue; }
      let ok = true;
      for (let k = 0; k < p.inputs && ok; k++) {
        if (p.type === 'hybrid') {
          const spareC = held.coal - reserved.coal, spareO = held.oil - reserved.oil;
          if (spareC > 0) reserved.coal++;
          else if (spareO > 0) reserved.oil++;
          else {
            const pc = sim.resMarket.coal ? E.unitPrice(sim, 'coal') : Infinity;
            const po = sim.resMarket.oil ? E.unitPrice(sim, 'oil') : Infinity;
            ok = pc <= po ? take('coal') || take('oil') : take('oil') || take('coal');
          }
        } else {
          ok = take(p.type);
        }
      }
      if (ok) capPlanned += p.output;
    }

    // With spare cash, stock up on cheap fuel for the best plant.
    if (budget > 70 && plants.length) {
      const n = plants.find((x) => PLANTS[x].type !== 'eco');
      if (n) {
        const p = PLANTS[n];
        const r = p.type === 'hybrid' ? (E.unitPrice(sim, 'coal') <= E.unitPrice(sim, 'oil') ? 'coal' : 'oil') : p.type;
        for (let k = 0; k < p.inputs; k++) {
          if (!sim.resMarket[r] || E.unitPrice(sim, r) > 3 || budget - E.unitPrice(sim, r) < 50) break;
          buyOne(r);
        }
      }
    }
    return { type: 'buy', purchase };
  }

  // Greedy: keep adding the cheapest reachable city while it pays off.
  function build(s, pend) {
    const me = s.players[pend.player];
    const d = E.distances(s.regions);
    const fueled = Math.min(E.capacityOf(me.plants), poweredCapacity(me));
    let target = Math.max(E.capacityOf(me.plants), me.cities.length);
    if (me.money > 100) target = Math.max(target, me.cities.length + 2);
    if (s.round <= 2 && me.cities.length === 0) target = Math.max(target, 1);
    if (s.step === 1 && s.round > 2) target = Math.max(target, me.cities.length + 1);
    let budget = me.money - (s.round > 1 ? 4 : 0);

    // Stop short of ending the game unless this network would win.
    const others = s.players.filter((p) => p.id !== me.id);
    const rivalBest = Math.max(...others.map((p) => Math.min(p.cities.length, E.capacityOf(p.plants))));
    const rivalMoney = Math.max(...others.map((p) => p.money));
    const mayEnd = (count) => {
      const mine = Math.min(count, fueled);
      if (s.round >= 25) return true; // fuel-starved standoff: let the game end
      return mine > rivalBest || (mine === rivalBest && me.money > rivalMoney + 20);
    };

    const chosen = [];
    const slots = E.slotsAllowed(s);
    while (me.cities.length + chosen.length < target) {
      const network = [...me.cities, ...chosen];
      let best = null;
      for (const id of s.activeCities) {
        const owners = s.cityOwners[id];
        if (owners.length >= slots || owners.includes(me.id) || chosen.includes(id)) continue;
        let conn = network.length ? Math.min(...network.map((n) => d[n][id])) : 0;
        let score = CITY_SLOT_COST[owners.length] + conn;
        if (!network.length) score += startPenalty(s, id, d, me.id);
        if (!best || score < best.score) best = { id, score };
      }
      if (!best) break;
      const total = E.buildCost(s, me.id, [...chosen, best.id]);
      if (!total.ok || total.total > budget) break;
      const count = me.cities.length + chosen.length + 1;
      if (count >= s.rules.end && !mayEnd(count)) break;
      chosen.push(best.id);
    }
    return { type: 'build', cities: chosen };
  }

  // Prefer a first city with cheap, uncontested neighbours.
  function startPenalty(s, id, d, myId) {
    const near = s.activeCities.filter((c) => c !== id).map((c) => d[id][c]).sort((a, b) => a - b);
    let pen = (near[0] + near[1] + near[2]) / 2;
    for (const c of s.activeCities) {
      const others = s.cityOwners[c].filter((o) => o !== myId).length;
      if (others && d[id][c] < 12) pen += 6;
    }
    return pen;
  }

  function poweredCapacity(me) {
    const big = { ...me, cities: new Array(99).fill('x') };
    return E.bestPower(big).powered;
  }

  function power(s, pend) {
    return { type: 'power', plants: E.bestPower(s.players[pend.player]).plants };
  }

  function decide(s, pend) {
    switch (pend.type) {
      case 'choose': return choosePlant(s, pend);
      case 'bid': return bid(s, pend);
      case 'discard': return discard(s, pend);
      case 'resources': return resources(s, pend);
      case 'build': return build(s, pend);
      case 'power': return power(s, pend);
      default: return null;
    }
  }

  PG.AI = { decide, plantValue };
})(typeof window !== 'undefined' ? window : globalThis);
