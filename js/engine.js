// Rules engine. The whole game lives in one plain JSON state object so it can be
// saved, restored and replayed. The UI and AI ask `pending(state)` who must act
// next, then call `act(state, action)`.
(function (root) {
  const PG = (root.PG = root.PG || {});
  const { PLANTS, RESOURCES, SLOT_PRICES, RESOURCE_TOTAL, RESOURCE_START, RESUPPLY, PAYOUT,
    RULES, CITY_SLOT_COST, REGIONS, CITIES, EDGES } = PG;

  const STEP3 = 'STEP3';
  const START_MONEY = 50;

  // ---------- random numbers (seeded, stored in state) ----------
  function rand(s) {
    let t = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffle(s, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand(s) * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function log(s, text) {
    s.log.push({ round: s.round, text });
    if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
  }

  // ---------- map / distances ----------
  const distCache = new Map();
  function distances(regions) {
    const key = regions.slice().sort().join(',');
    if (distCache.has(key)) return distCache.get(key);
    const ids = Object.keys(CITIES).filter((id) => regions.includes(CITIES[id].region));
    const d = {};
    for (const a of ids) {
      d[a] = {};
      for (const b of ids) d[a][b] = a === b ? 0 : Infinity;
    }
    for (const e of EDGES) {
      if (d[e.a] && d[e.b]) {
        d[e.a][e.b] = Math.min(d[e.a][e.b], e.cost);
        d[e.b][e.a] = Math.min(d[e.b][e.a], e.cost);
      }
    }
    for (const k of ids) for (const i of ids) for (const j of ids) {
      if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
    }
    distCache.set(key, d);
    return d;
  }

  // True when `list` names `count` distinct regions that form one connected area.
  function regionsValid(list, count) {
    if (!Array.isArray(list) || list.length !== count || new Set(list).size !== count) return false;
    if (!list.every((r) => REGIONS[r])) return false;
    const seen = new Set([list[0]]);
    const queue = [list[0]];
    while (queue.length) {
      for (const r of REGIONS[queue.shift()].adj) {
        if (list.includes(r) && !seen.has(r)) { seen.add(r); queue.push(r); }
      }
    }
    return seen.size === count;
  }

  function pickRegions(s, count) {
    const all = Object.keys(REGIONS);
    const chosen = [all[Math.floor(rand(s) * all.length)]];
    while (chosen.length < count) {
      const options = all.filter((r) => !chosen.includes(r) && chosen.some((c) => REGIONS[c].adj.includes(r)));
      chosen.push(options[Math.floor(rand(s) * options.length)]);
    }
    return chosen;
  }

  // ---------- plant helpers ----------
  function capacityOf(plants) {
    return plants.reduce((sum, n) => sum + PLANTS[n].output, 0);
  }

  function storageCaps(plants) {
    const c = { coal: 0, oil: 0, garbage: 0, uranium: 0, hybrid: 0 };
    for (const n of plants) {
      const p = PLANTS[n];
      if (p.type !== 'eco') c[p.type] += p.inputs * 2;
    }
    return c;
  }

  function canHold(plants, res) {
    const c = storageCaps(plants);
    return res.garbage <= c.garbage && res.uranium <= c.uranium &&
      res.coal <= c.coal + c.hybrid && res.oil <= c.oil + c.hybrid &&
      res.coal + res.oil <= c.coal + c.oil + c.hybrid;
  }

  // Remove resources that no longer fit after a plant is discarded. Returns what was lost.
  function trimResources(plants, res) {
    const c = storageCaps(plants);
    const lost = { coal: 0, oil: 0, garbage: 0, uranium: 0 };
    const cut = (r, max) => { if (res[r] > max) { lost[r] += res[r] - max; res[r] = max; } };
    cut('garbage', c.garbage);
    cut('uranium', c.uranium);
    cut('coal', c.coal + c.hybrid);
    cut('oil', c.oil + c.hybrid);
    let overflow = Math.max(0, res.coal - c.coal) + Math.max(0, res.oil - c.oil) - c.hybrid;
    while (overflow > 0) {
      const r = res.oil - c.oil >= res.coal - c.coal ? 'oil' : 'coal';
      res[r]--; lost[r]++; overflow--;
    }
    return lost;
  }

  // Resources needed to run a set of plants: fixed types plus a coal/oil "hybrid" amount.
  function fuelNeeds(plants) {
    const need = { coal: 0, oil: 0, garbage: 0, uranium: 0, hybrid: 0 };
    for (const n of plants) {
      const p = PLANTS[n];
      if (p.type !== 'eco') need[p.type] += p.inputs;
    }
    return need;
  }

  function canRun(plants, res) {
    const n = fuelNeeds(plants);
    if (res.coal < n.coal || res.oil < n.oil || res.garbage < n.garbage || res.uranium < n.uranium) return false;
    return res.coal - n.coal + res.oil - n.oil >= n.hybrid;
  }

  // The set of plants that powers the most cities, using the least fuel.
  function bestPower(player) {
    const plants = player.plants;
    let best = { plants: [], powered: 0, fuel: 0 };
    for (let mask = 1; mask < 1 << plants.length; mask++) {
      const set = plants.filter((_, i) => mask & (1 << i));
      if (!canRun(set, player.resources)) continue;
      const powered = Math.min(capacityOf(set), player.cities.length);
      const fuel = set.reduce((sum, x) => sum + PLANTS[x].inputs, 0);
      if (powered > best.powered || (powered === best.powered && fuel < best.fuel)) {
        best = { plants: set, powered, fuel };
      }
    }
    return best;
  }

  // ---------- resource market ----------
  function unitPrice(s, r, k = 0) {
    const prices = SLOT_PRICES[r];
    const idx = prices.length - s.resMarket[r] + k;
    return idx < prices.length ? prices[idx] : Infinity;
  }
  function resourceCost(s, r, n) {
    let cost = 0;
    for (let k = 0; k < n; k++) cost += unitPrice(s, r, k);
    return cost;
  }

  // ---------- power plant market ----------
  function maxCities(s) {
    return Math.max(...s.players.map((p) => p.cities.length));
  }
  function currentPlants(s) {
    return s.step === 3 ? s.market.slice() : s.market.slice(0, 4);
  }
  function futurePlants(s) {
    return s.step === 3 ? [] : s.market.slice(4);
  }

  function sortMarket(s) {
    s.market.sort((a, b) => a - b);
  }

  // Draw one card into the market. Plants at or below the leading city count are
  // discarded and replaced immediately.
  function drawPlant(s) {
    while (s.deck.length) {
      const card = s.deck.shift();
      if (card === STEP3) {
        s.step3Pending = true;
        log(s, 'The Step 3 card was drawn. Step 3 begins at the end of this phase.');
        return;
      }
      if (card <= maxCities(s)) {
        log(s, `Plant ${card} was drawn but is already obsolete and was removed.`);
        continue;
      }
      s.market.push(card);
      sortMarket(s);
      return;
    }
  }

  function removeObsoletePlants(s) {
    let changed = true;
    while (changed) {
      changed = false;
      const low = s.market.find((n) => n <= maxCities(s));
      if (low !== undefined) {
        s.market.splice(s.market.indexOf(low), 1);
        log(s, `Plant ${low} is obsolete and was removed from the market.`);
        if (!s.step3Pending) drawPlant(s);
        changed = true;
      }
    }
  }

  function removeLowestPlant(s) {
    if (!s.market.length) return;
    const low = s.market.shift();
    log(s, `Plant ${low} was removed from the market.`);
  }

  function startStep3(s) {
    s.step3Pending = false;
    s.step = 3;
    removeLowestPlant(s);
    shuffle(s, s.deck);
    while (s.market.length < 6 && s.deck.length) drawPlant(s);
    log(s, 'Step 3: cities hold three players and all plants in the market are for sale.');
  }

  // ---------- turn order ----------
  function determineOrder(s) {
    const idx = s.players.map((_, i) => i);
    idx.sort((a, b) => {
      const pa = s.players[a], pb = s.players[b];
      if (pb.cities.length !== pa.cities.length) return pb.cities.length - pa.cities.length;
      return Math.max(0, ...pb.plants) - Math.max(0, ...pa.plants);
    });
    s.order = idx;
  }

  // ---------- setup ----------
  function newGame(opts) {
    const n = opts.players.length;
    if (!RULES[n]) throw new Error('Power Grid supports 2 to 4 players here.');
    const s = {
      version: 1,
      rng: (opts.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0,
      rules: RULES[n],
      options: { hideAIMoney: !!opts.hideAIMoney },
      players: opts.players.map((p, i) => ({
        id: i, name: p.name, color: p.color, isAI: !!p.isAI,
        money: START_MONEY, plants: [], cities: [],
        resources: { coal: 0, oil: 0, garbage: 0, uranium: 0 },
      })),
      cityOwners: {},
      market: [3, 4, 5, 6, 7, 8, 9, 10],
      deck: [],
      resMarket: { ...RESOURCE_START },
      supply: {},
      step: 1,
      step3Pending: false,
      round: 1,
      phase: 'auction',
      order: [],
      auction: null,
      discard: null,
      turnPos: 0,
      powerQueue: [],
      lastPower: {},
      endTriggered: false,
      winner: null,
      ranking: null,
      log: [],
    };
    for (const r of RESOURCES) s.supply[r] = RESOURCE_TOTAL[r] - RESOURCE_START[r];
    if (opts.regions && !regionsValid(opts.regions, s.rules.regions)) {
      throw new Error(`Choose ${s.rules.regions} regions that border each other.`);
    }
    s.regions = opts.regions ? opts.regions.slice() : pickRegions(s, s.rules.regions);
    s.activeCities = Object.keys(CITIES).filter((id) => s.regions.includes(CITIES[id].region));
    for (const id of s.activeCities) s.cityOwners[id] = [];

    let deck = Object.keys(PLANTS).map(Number).filter((x) => x > 10 && x !== 13);
    shuffle(s, deck);
    deck = deck.slice(s.rules.removePlants);
    s.deck = [13, ...deck, STEP3];

    s.order = shuffle(s, s.players.map((_, i) => i));
    log(s, `New game on ${s.regions.map((r) => REGIONS[r].name).join(', ')}.`);
    startAuctionPhase(s);
    return s;
  }

  // ---------- phase 2: auction ----------
  function startAuctionPhase(s) {
    s.phase = 'auction';
    s.auction = { done: [], anyBought: false, current: null, chooserPos: 0 };
    advanceChooser(s);
  }

  function advanceChooser(s) {
    const a = s.auction;
    while (a.chooserPos < s.order.length && a.done.includes(s.order[a.chooserPos])) a.chooserPos++;
    if (a.chooserPos >= s.order.length) endAuctionPhase(s);
  }

  function endAuctionPhase(s) {
    if (!s.auction.anyBought) {
      log(s, 'Nobody bought a plant this round.');
      removeLowestPlant(s);
      if (!s.step3Pending) drawPlant(s);
    }
    if (s.step3Pending) startStep3(s);
    if (s.round === 1) determineOrder(s);
    s.auction = null;
    s.phase = 'resources';
    s.turnPos = 0;
  }

  function resolveAuction(s) {
    const a = s.auction, c = a.current;
    const winner = s.players[c.high];
    winner.money -= c.bid;
    winner.plants.push(c.plant);
    winner.plants.sort((x, y) => x - y);
    s.market.splice(s.market.indexOf(c.plant), 1);
    a.done.push(c.high);
    a.anyBought = true;
    a.current = null;
    log(s, `${winner.name} bought plant ${c.plant} for ${c.bid} Elektro.`);
    if (!s.step3Pending) drawPlant(s);
    if (winner.plants.length > s.rules.maxPlants) {
      s.discard = { player: winner.id, newPlant: c.plant };
      return;
    }
    advanceChooser(s);
  }

  function nextBidder(c) {
    if (c.active.length > 1 && c.active[c.pos] === c.high) c.pos = (c.pos + 1) % c.active.length;
  }

  // ---------- pending decision ----------
  function pending(s) {
    switch (s.phase) {
      case 'auction':
        if (s.discard) return { type: 'discard', player: s.discard.player };
        if (s.auction.current) {
          const c = s.auction.current;
          return { type: 'bid', player: c.active[c.pos] };
        }
        return { type: 'choose', player: s.order[s.auction.chooserPos], canPass: s.round > 1 };
      case 'resources':
        return { type: 'resources', player: s.order[s.order.length - 1 - s.turnPos] };
      case 'build':
        return { type: 'build', player: s.order[s.order.length - 1 - s.turnPos] };
      case 'power':
        return { type: 'power', player: s.powerQueue[0] };
      default:
        return { type: 'gameover' };
    }
  }

  // ---------- building ----------
  function slotsAllowed(s) {
    return s.step;
  }

  // Cost to add `cityIds` to a player's network. Connection cost is the cheapest
  // order of attaching the new cities one at a time.
  function buildCost(s, playerIdx, cityIds) {
    const player = s.players[playerIdx];
    const d = distances(s.regions);
    const seen = new Set();
    let slotCost = 0;
    for (const id of cityIds) {
      if (!s.cityOwners[id]) return { ok: false, error: `${CITIES[id]?.name || id} is not in play.` };
      if (seen.has(id) || player.cities.includes(id)) return { ok: false, error: `You already have ${CITIES[id].name}.` };
      const owners = s.cityOwners[id];
      if (owners.length >= slotsAllowed(s)) return { ok: false, error: `${CITIES[id].name} is full in Step ${s.step}.` };
      slotCost += CITY_SLOT_COST[owners.length];
      seen.add(id);
    }
    const connection = connectionCost(d, player.cities, cityIds);
    return { ok: true, total: slotCost + connection, slots: slotCost, connection };
  }

  function connectionCost(d, network, adds) {
    if (!adds.length) return 0;
    const attach = (net, order) => {
      const nodes = net.slice();
      let total = 0;
      for (const c of order) {
        total += nodes.length ? Math.min(...nodes.map((n) => d[n][c])) : 0;
        nodes.push(c);
      }
      return total;
    };
    if (adds.length <= 6) {
      let best = Infinity;
      const permute = (arr, k) => {
        if (k === arr.length) { best = Math.min(best, attach(network, arr)); return; }
        for (let i = k; i < arr.length; i++) {
          [arr[k], arr[i]] = [arr[i], arr[k]];
          permute(arr, k + 1);
          [arr[k], arr[i]] = [arr[i], arr[k]];
        }
      };
      permute(adds.slice(), 0);
      return best;
    }
    // Large sets: attach the nearest remaining city each time.
    const nodes = network.slice(), left = adds.slice();
    let total = 0;
    if (!nodes.length) nodes.push(left.shift());
    while (left.length) {
      let bi = 0, bc = Infinity;
      left.forEach((c, i) => {
        const cost = Math.min(...nodes.map((n) => d[n][c]));
        if (cost < bc) { bc = cost; bi = i; }
      });
      total += bc;
      nodes.push(left.splice(bi, 1)[0]);
    }
    return total;
  }

  // ---------- phase 5: bureaucracy ----------
  function resupply(s) {
    const table = RESUPPLY[s.players.length];
    for (const r of RESOURCES) {
      const room = SLOT_PRICES[r].length - s.resMarket[r];
      const add = Math.min(table[r][s.step - 1], s.supply[r], room);
      s.resMarket[r] += add;
      s.supply[r] -= add;
    }
  }

  function finishBureaucracy(s) {
    if (s.endTriggered) {
      const ranking = s.players.map((p) => p.id).sort((a, b) => {
        const pa = s.players[a], pb = s.players[b];
        return (s.lastPower[b] - s.lastPower[a]) || (pb.money - pa.money) || (pb.cities.length - pa.cities.length);
      });
      s.ranking = ranking;
      s.winner = ranking[0];
      s.phase = 'gameover';
      log(s, `Game over. ${s.players[s.winner].name} wins by powering ${s.lastPower[s.winner]} cities.`);
      return;
    }
    resupply(s);
    if (s.step3Pending) {
      startStep3(s);
    } else if (s.step === 3) {
      removeLowestPlant(s);
      drawPlant(s);
      if (s.step3Pending) startStep3(s);
    } else if (s.market.length) {
      const high = s.market.pop();
      s.deck.push(high);
      log(s, `Plant ${high} went to the bottom of the deck.`);
      drawPlant(s);
      if (s.step3Pending) startStep3(s);
    }
    s.round++;
    determineOrder(s);
    startAuctionPhase(s);
  }

  // ---------- actions ----------
  function act(s, action) {
    const p = pending(s);
    if (p.type === 'gameover') throw new Error('The game is over.');
    const player = s.players[p.player];

    if (p.type === 'choose') {
      if (action.type === 'pass') {
        if (!p.canPass) throw new Error('Everyone must buy a plant in the first round.');
        s.auction.done.push(p.player);
        log(s, `${player.name} passed on buying a plant.`);
        advanceChooser(s);
        return;
      }
      if (action.type !== 'choose') throw new Error('Choose a plant or pass.');
      const plant = action.plant, bid = action.bid ?? plant;
      if (!currentPlants(s).includes(plant)) throw new Error(`Plant ${plant} is not for sale right now.`);
      if (bid < plant) throw new Error(`The opening bid must be at least ${plant}.`);
      if (bid > player.money) throw new Error('You cannot afford that bid.');
      const active = [];
      for (let k = 0; k < s.players.length; k++) {
        const id = (p.player + k) % s.players.length;
        if (!s.auction.done.includes(id)) active.push(id);
      }
      s.auction.current = { plant, bid, high: p.player, active, pos: 0 };
      log(s, `${player.name} opened plant ${plant} at ${bid}.`);
      const c = s.auction.current;
      c.pos = active.length > 1 ? 1 : 0;
      if (active.length === 1) resolveAuction(s);
      return;
    }

    if (p.type === 'bid') {
      const c = s.auction.current;
      if (action.type === 'bid') {
        if (action.amount <= c.bid) throw new Error(`Bid more than ${c.bid}.`);
        if (action.amount > player.money) throw new Error('You cannot afford that bid.');
        c.bid = action.amount;
        c.high = p.player;
        c.pos = (c.pos + 1) % c.active.length;
        nextBidder(c);
        log(s, `${player.name} bid ${action.amount}.`);
        return;
      }
      if (action.type !== 'pass') throw new Error('Bid or pass.');
      c.active.splice(c.pos, 1);
      if (c.pos >= c.active.length) c.pos = 0;
      if (c.active.length === 1) { resolveAuction(s); return; }
      nextBidder(c);
      return;
    }

    if (p.type === 'discard') {
      const n = action.plant;
      if (action.type !== 'discard' || !player.plants.includes(n) || n === s.discard.newPlant) {
        throw new Error('Discard one of your older plants.');
      }
      player.plants.splice(player.plants.indexOf(n), 1);
      const lost = trimResources(player.plants, player.resources);
      for (const r of RESOURCES) s.supply[r] += lost[r];
      const lostText = RESOURCES.filter((r) => lost[r]).map((r) => `${lost[r]} ${r}`).join(', ');
      log(s, `${player.name} scrapped plant ${n}${lostText ? ` and lost ${lostText}` : ''}.`);
      s.discard = null;
      advanceChooser(s);
      return;
    }

    if (p.type === 'resources') {
      if (action.type !== 'buy') throw new Error('Buy resources or skip.');
      const buy = action.purchase || {};
      let cost = 0;
      const after = { ...player.resources };
      for (const r of RESOURCES) {
        const n = buy[r] || 0;
        if (n < 0 || !Number.isInteger(n)) throw new Error('Invalid amount.');
        if (n > s.resMarket[r]) throw new Error(`Only ${s.resMarket[r]} ${r} is for sale.`);
        cost += resourceCost(s, r, n);
        after[r] += n;
      }
      if (cost > player.money) throw new Error('You cannot afford those resources.');
      if (!canHold(player.plants, after)) throw new Error('Your plants cannot store that many resources.');
      for (const r of RESOURCES) s.resMarket[r] -= buy[r] || 0;
      player.money -= cost;
      player.resources = after;
      const bought = RESOURCES.filter((r) => buy[r]).map((r) => `${buy[r]} ${r}`).join(', ');
      log(s, bought ? `${player.name} bought ${bought} for ${cost}.` : `${player.name} bought no resources.`);
      s.turnPos++;
      if (s.turnPos >= s.players.length) { s.phase = 'build'; s.turnPos = 0; }
      return;
    }

    if (p.type === 'build') {
      if (action.type !== 'build') throw new Error('Build cities or skip.');
      const ids = action.cities || [];
      if (ids.length) {
        const cost = buildCost(s, p.player, ids);
        if (!cost.ok) throw new Error(cost.error);
        if (cost.total > player.money) throw new Error(`Those cities cost ${cost.total}, more than you have.`);
        player.money -= cost.total;
        for (const id of ids) {
          player.cities.push(id);
          s.cityOwners[id].push(p.player);
        }
        log(s, `${player.name} built in ${ids.map((id) => CITIES[id].name).join(', ')} for ${cost.total}.`);
        removeObsoletePlants(s);
      } else {
        log(s, `${player.name} built nothing.`);
      }
      s.turnPos++;
      if (s.turnPos >= s.players.length) endBuildPhase(s);
      return;
    }

    if (p.type === 'power') {
      if (action.type !== 'power') throw new Error('Choose plants to run.');
      const set = action.plants || [];
      if (!set.every((n) => player.plants.includes(n)) || new Set(set).size !== set.length) {
        throw new Error('You can only run your own plants.');
      }
      if (!canRun(set, player.resources)) throw new Error('Not enough resources to run those plants.');
      const need = fuelNeeds(set);
      const res = player.resources;
      for (const r of RESOURCES) { res[r] -= need[r]; s.supply[r] += need[r]; }
      let hybrid = need.hybrid;
      let useCoal = action.hybridCoal ?? null;
      if (useCoal === null) {
        useCoal = 0;
        let c = res.coal, o = res.oil;
        for (let k = 0; k < hybrid; k++) {
          if (c >= o) { c--; useCoal++; } else o--;
        }
      }
      useCoal = Math.max(hybrid - res.oil, Math.min(useCoal, res.coal, hybrid));
      res.coal -= useCoal; res.oil -= hybrid - useCoal;
      s.supply.coal += useCoal; s.supply.oil += hybrid - useCoal;
      const powered = Math.min(capacityOf(set), player.cities.length);
      const income = PAYOUT[Math.min(powered, PAYOUT.length - 1)];
      player.money += income;
      s.lastPower[p.player] = powered;
      log(s, `${player.name} powered ${powered} ${powered === 1 ? 'city' : 'cities'} and earned ${income}.`);
      s.powerQueue.shift();
      if (!s.powerQueue.length) finishBureaucracy(s);
      return;
    }
    throw new Error('Unknown action.');
  }

  function endBuildPhase(s) {
    const lead = maxCities(s);
    if (s.step === 1 && lead >= s.rules.step2) {
      s.step = 2;
      log(s, 'Step 2: a second player may now build in each city.');
      removeLowestPlant(s);
      if (!s.step3Pending) drawPlant(s);
    }
    if (lead >= s.rules.end) {
      s.endTriggered = true;
      log(s, `A network reached ${lead} cities. This is the final round.`);
    }
    s.phase = 'power';
    s.powerQueue = s.players.map((p) => p.id);
    s.lastPower = {};
  }

  PG.Engine = {
    STEP3, newGame, pending, regionsValid, act, distances, buildCost, connectionCost, capacityOf, storageCaps,
    canHold, canRun, fuelNeeds, bestPower, unitPrice, resourceCost, currentPlants, futurePlants,
    maxCities, slotsAllowed,
  };
})(typeof window !== 'undefined' ? window : globalThis);
