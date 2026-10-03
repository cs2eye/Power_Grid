// Browser UI: renders the state and turns clicks into engine actions.
(function () {
  const { Engine: E, AI, PLANTS, RESOURCES, CITIES, EDGES, REGIONS, PAYOUT, SLOT_PRICES } = window.PG;

  const PLAYER_COLORS = [
    { name: 'Blue', value: '#2f6fd6' },
    { name: 'Red', value: '#d8432b' },
    { name: 'Green', value: '#22966a' },
    { name: 'Violet', value: '#8b52cc' },
  ];
  const AI_NAMES = ['Volta', 'Tesla', 'Ampère'];
  const SAVE_KEY = 'power-grid-save-v1';
  const PREF_KEY = 'power-grid-prefs-v1';
  const SPEEDS = { Normal: 750, Fast: 200, Slow: 1400 };
  // Where to put a city's name when the default (below) would collide.
  const LABEL_SIDE = { nyc: 'r', phl: 'r', bos: 'r', was: 'l', bhm: 'l', lax: 'l', las: 'a', orf: 'r', det: 'l', buf: 'a', mem: 'a', tpa: 'l' };

  let game = null;
  let ui = freshUI();
  let prefs = loadJSON(PREF_KEY) || { speed: 'Normal', name: 'You', color: PLAYER_COLORS[0].value, opponents: 1 };
  let aiTimer = null;

  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function freshUI() {
    return { picked: null, bid: 0, resCart: { coal: 0, oil: 0, garbage: 0, uranium: 0 }, buildCart: [], powerSel: null, error: '', key: '' };
  }
  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }

  // ---------- game lifecycle ----------
  function startGame(opts) {
    const humanColor = opts.color;
    const others = PLAYER_COLORS.map((c) => c.value).filter((c) => c !== humanColor);
    const players = [{ name: opts.name || 'You', color: humanColor, isAI: false }];
    for (let i = 0; i < opts.opponents; i++) players.push({ name: AI_NAMES[i], color: others[i], isAI: true });
    const regions = opts.regionMode === 'pick' ? opts.regions : null;
    game = E.newGame({ players, regions, hideAIMoney: opts.hideMoney });
    ui = freshUI();
    update();
  }

  function update() {
    saveJSON(SAVE_KEY, game);
    const pend = E.pending(game);
    const key = `${game.round}|${game.phase}|${pend.type}|${pend.player}|${game.auction?.current?.bid ?? ''}`;
    if (key !== ui.key) {
      const keepPick = pend.type === 'choose' && ui.key.split('|')[2] === 'choose';
      const picked = keepPick ? ui.picked : null;
      ui = { ...freshUI(), key, picked };
      prepareHumanTurn(pend);
    }
    render();
    scheduleAI();
  }

  function human() { return game.players.find((p) => !p.isAI); }
  function isHumanTurn(pend) { return pend.type !== 'gameover' && !game.players[pend.player].isAI; }

  function prepareHumanTurn(pend) {
    if (!isHumanTurn(pend)) return;
    const me = game.players[pend.player];
    if (pend.type === 'bid') ui.bid = game.auction.current.bid + 1;
    if (pend.type === 'power') ui.powerSel = new Set(E.bestPower(me).plants);
  }

  function scheduleAI() {
    clearTimeout(aiTimer);
    const pend = E.pending(game);
    if (pend.type === 'gameover' || !game.players[pend.player].isAI) return;
    aiTimer = setTimeout(() => {
      const action = AI.decide(game, pend);
      try { E.act(game, action); } catch (err) { console.error('AI move rejected', action, err); E.act(game, fallback(pend)); }
      update();
    }, SPEEDS[prefs.speed] || 750);
  }

  function fallback(pend) {
    switch (pend.type) {
      case 'choose': return pend.canPass ? { type: 'pass' } : { type: 'choose', plant: E.currentPlants(game)[0] };
      case 'bid': return { type: 'pass' };
      case 'resources': return { type: 'buy', purchase: {} };
      case 'build': return { type: 'build', cities: [] };
      case 'power': return { type: 'power', plants: [] };
      default: return { type: 'pass' };
    }
  }

  function humanAct(action) {
    try {
      E.act(game, action);
      ui.error = '';
      update();
    } catch (err) {
      ui.error = err.message;
      render();
    }
  }

  // ---------- rendering ----------
  function render() {
    const pend = E.pending(game);
    renderStatus(pend);
    renderMap(pend);
    renderPlayers(pend);
    renderAction(pend);
    renderPlantMarket(pend);
    renderResources(pend);
    renderLog();
  }

  const PHASE_NAMES = { auction: 'Auction', resources: 'Buy resources', build: 'Build cities', power: 'Bureaucracy', gameover: 'Game over' };

  function renderStatus() {
    const lead = E.maxCities(game);
    $('status').innerHTML = [
      `<span class="chip">Round ${game.round}</span>`,
      `<span class="chip">Step ${game.step}</span>`,
      `<span class="chip live">${PHASE_NAMES[game.phase]}</span>`,
      `<span class="chip">Lead ${lead} / ${game.rules.end} cities</span>`,
    ].join('');
    $('btn-speed').textContent = `AI speed: ${prefs.speed}`;
  }

  // Map projection, fitted to the regions in play.
  function projection() {
    const k = Math.cos((38 * Math.PI) / 180);
    const pts = game.activeCities.map((id) => [CITIES[id].lon * k, -CITIES[id].lat]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = 1000, pad = 46;
    const scale = (W - pad * 2) / Math.max(maxX - minX, (maxY - minY) * 1.1);
    const H = Math.round((maxY - minY) * scale + pad * 2 + 10);
    const proj = (id) => [pad + (CITIES[id].lon * k - minX) * scale, pad + (-CITIES[id].lat - minY) * scale];
    return { W, H, proj };
  }

  function renderMap(pend) {
    const { W, H, proj } = projection();
    const svg = $('map');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const humanBuilding = pend.type === 'build' && isHumanTurn(pend);
    const me = human();
    const active = new Set(game.activeCities);
    let html = '';

    for (const e of EDGES) {
      if (!active.has(e.a) || !active.has(e.b)) continue;
      const [x1, y1] = proj(e.a), [x2, y2] = proj(e.b);
      html += `<line class="edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`;
    }
    for (const e of EDGES) {
      if (!active.has(e.a) || !active.has(e.b)) continue;
      const [x1, y1] = proj(e.a), [x2, y2] = proj(e.b);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      html += `<g class="edge-cost"><circle cx="${mx}" cy="${my}" r="9"></circle><text x="${mx}" y="${my}">${e.cost}</text></g>`;
    }

    let labels = '';
    const cartCost = humanBuilding && ui.buildCart.length ? E.buildCost(game, me.id, ui.buildCart) : null;
    for (const id of game.activeCities) {
      const [x, y] = proj(id);
      const owners = game.cityOwners[id];
      let cls = 'city';
      let tip = `${CITIES[id].name} (${REGIONS[CITIES[id].region].name})`;
      let focusable = false;
      if (humanBuilding) {
        if (ui.buildCart.includes(id)) { cls += ' selected'; focusable = true; tip += ' — selected, click to remove'; }
        else {
          const cost = E.buildCost(game, me.id, [...ui.buildCart, id]);
          if (cost.ok) {
            const extra = cost.total - (cartCost ? cartCost.total : 0);
            cls += ' buildable'; focusable = true; tip += ` — adds ${extra} Elektro`;
          } else cls += ' blocked';
        }
      }
      let slots = '';
      for (let i = 0; i < 3; i++) {
        const owner = owners[i];
        const sx = x - 15 + i * 11;
        if (owner !== undefined) {
          slots += `<rect x="${sx}" y="${y - 4.5}" width="9" height="9" rx="1.5" fill="${game.players[owner].color}" stroke="var(--ink)" stroke-width="0.8"></rect>`;
        } else {
          slots += `<rect class="slot${i >= game.step ? ' locked' : ''}" x="${sx}" y="${y - 4.5}" width="9" height="9" rx="1.5"></rect>`;
        }
      }
      html += `<g class="${cls}" data-city="${id}"${focusable ? ' tabindex="0" role="button"' : ''}>
        <title>${esc(tip)}</title>
        <rect class="body" x="${x - 19}" y="${y - 8.5}" width="38" height="17" rx="5"></rect>
        ${slots}
      </g>`;
      const side = LABEL_SIDE[id];
      const [lx, ly, anchor] = side === 'r' ? [x + 23, y + 4, 'start'] : side === 'l' ? [x - 23, y + 4, 'end'] : side === 'a' ? [x, y - 14, 'middle'] : [x, y + 22, 'middle'];
      labels += `<text class="city-label${cls.includes('selected') ? ' selected' : ''}" x="${lx}" y="${ly}" text-anchor="${anchor}">${esc(CITIES[id].name)}</text>`;
    }
    svg.innerHTML = html + `<g aria-hidden="true">${labels}</g>`;

    $('map-hint').textContent = humanBuilding
      ? 'Click cities with an orange outline to add them to your build. Hover a city to see what it adds.'
      : `Regions in play: ${game.regions.map((r) => REGIONS[r].name).join(', ')}. Numbers on lines are connection costs.`;
  }

  function plantCard(n, opts = {}) {
    const p = PLANTS[n];
    const tag = opts.button ? 'button' : 'div';
    const toks = p.type === 'eco' ? `<span class="tok eco"></span>` : Array.from({ length: p.inputs }, () => `<span class="tok ${p.type}"></span>`).join('');
    const label = `Plant ${n}: ${p.type === 'eco' ? 'no fuel' : `${p.inputs} ${p.type === 'hybrid' ? 'coal or oil' : p.type}`}, powers ${p.output}`;
    const attrs = opts.button ? ` type="button" data-plant="${n}"${opts.disabled ? ' disabled' : ''}` : '';
    return `<${tag} class="plant ${p.type}${opts.small ? ' small' : ''}${opts.future ? ' future' : ''}${opts.picked ? ' picked' : ''}"${attrs} title="${esc(label)}" aria-label="${esc(label)}">
      <span class="pnum">${n}</span>
      <span class="prow">${toks}</span>
      <span class="prow">→ ${p.output}<span class="house"></span></span>
    </${tag}>`;
  }

  function renderPlantMarket(pend) {
    const humanChoosing = pend.type === 'choose' && isHumanTurn(pend);
    const me = human();
    const cur = E.currentPlants(game), fut = E.futurePlants(game);
    const auctioned = game.auction?.current?.plant;
    const row = (list, tag, future) => `<div class="market-row"><span class="tag">${tag}</span>${list.map((n) =>
      plantCard(n, { button: humanChoosing && !future, disabled: n > me.money, future, picked: n === ui.picked || n === auctioned })).join('') || '<span class="meta">empty</span>'}</div>`;
    let html = row(cur, game.step === 3 ? 'For sale' : 'Current market — for sale', false);
    if (game.step !== 3) html += row(fut, 'Future market', true);
    $('plants').innerHTML = html;
    const deckPlants = game.deck.filter((c) => c !== E.STEP3).length;
    $('deck-count').textContent = `${deckPlants} in deck`;
  }

  function renderResources(pend) {
    const showCart = pend.type === 'resources' && isHumanTurn(pend);
    let html = '';
    for (const r of RESOURCES) {
      const prices = SLOT_PRICES[r];
      const count = game.resMarket[r];
      const filledFrom = prices.length - count;
      const cartTo = filledFrom + (showCart ? ui.resCart[r] : 0);
      const groups = [];
      prices.forEach((price, i) => {
        let g = groups[groups.length - 1];
        if (!g || g.price !== price) groups.push((g = { price, toks: [] }));
        const cls = i < filledFrom ? 'empty' : i < cartTo ? 'cart' : '';
        g.toks.push(`<span class="tok ${r} ${cls}"></span>`);
      });
      html += `<div class="resrow"><div class="resname"><span class="rname"><span class="tok ${r}"></span>${r}</span><span class="supply">${count} for sale · ${game.supply[r]} in reserve</span></div>
        <div class="cells">${groups.map((g) => `<div class="cell"><span class="price">${g.price}</span><span class="slots">${g.toks.join('')}</span></div>`).join('')}</div></div>`;
    }
    $('resources').innerHTML = html;
  }

  function renderPlayers(pend) {
    const ordinal = (n) => ['1st', '2nd', '3rd', '4th'][n - 1];
    const hide = game.options?.hideAIMoney && game.phase !== 'gameover';
    $('players').innerHTML = game.players.map((p) => {
      const pid = p.id;
      const turn = game.order.indexOf(pid) + 1;
      const money = hide && p.isAI ? '<b title="Hidden">?</b>' : `<b>${p.money}</b>`;
      const isActive = pend.type !== 'gameover' && pend.player === pid;
      const cap = E.capacityOf(p.plants);
      const held = RESOURCES.filter((r) => p.resources[r]).map((r) => `<span><span class="tok ${r}"></span>${p.resources[r]}</span>`).join('') || '<span class="meta">no fuel stored</span>';
      const last = game.lastPower[pid];
      return `<article class="pboard${isActive ? ' active' : ''}">
        <header><span class="turn" style="--pc:${p.color}" title="${ordinal(turn)} in turn order" aria-label="${ordinal(turn)} in turn order">${turn}</span><h3>${esc(p.name)}</h3>
          <span class="order">${p.isAI ? 'computer' : 'you'}</span></header>
        <div class="stats">
          <div class="stat">${money}<span>Elektro</span></div>
          <div class="stat"><b>${p.cities.length}</b><span>Cities</span></div>
          <div class="stat"><b>${cap}</b><span>Capacity</span></div>
        </div>
        <div class="mini-plants">${p.plants.map((n) => plantCard(n, { small: true })).join('') || '<span class="meta">no plants yet</span>'}</div>
        <div class="held">${held}${last !== undefined ? `<span class="meta">powered ${last} last round</span>` : ''}</div>
      </article>`;
    }).join('');
  }

  function renderLog() {
    const items = game.log.slice(-80).reverse();
    $('log').innerHTML = items.map((l) => `<li><span class="r">R${l.round}</span><span>${esc(l.text)}</span></li>`).join('');
  }

  function stepper(id, value, min, max) {
    return `<span class="stepper"><button type="button" data-step="${id}" data-d="-1" aria-label="Decrease"${value <= min ? ' disabled' : ''}>−</button><input id="${id}" class="num" type="number" inputmode="numeric" value="${value}" min="${min}" max="${max}"><button type="button" data-step="${id}" data-d="1" aria-label="Increase"${value >= max ? ' disabled' : ''}>+</button></span>`;
  }

  function renderAction(pend) {
    const el = $('action');
    const err = ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : '';

    if (pend.type === 'gameover') {
      const rows = game.ranking.map((pid) => {
        const p = game.players[pid];
        return `<li><b>${esc(p.name)}</b> — powered ${game.lastPower[pid]}, ${p.cities.length} cities, ${p.money} Elektro</li>`;
      }).join('');
      const won = !game.players[game.winner].isAI;
      el.innerHTML = `<h2>${won ? 'You win' : `${esc(game.players[game.winner].name)} wins`}</h2>
        <p>Most cities powered in the final round wins; money breaks ties.</p>
        <ol class="ranking">${rows}</ol>
        <div class="row"><button type="button" class="primary" data-act="new">Play again</button></div>`;
      return;
    }

    const p = game.players[pend.player];
    if (p.isAI) {
      const what = { choose: 'is choosing a plant', bid: 'is deciding on a bid', discard: 'is scrapping a plant', resources: 'is buying resources', build: 'is building', power: 'is powering cities' }[pend.type];
      let extra = '';
      if (game.auction?.current) {
        const c = game.auction.current;
        extra = `<p>Plant <b>${c.plant}</b> — high bid <b class="num">${c.bid}</b> by ${esc(game.players[c.high].name)}</p>`;
      }
      el.innerHTML = `<h2>Opponent's turn</h2>${extra}<p class="thinking"><span class="pulse"></span>${esc(p.name)} ${what}…</p>`;
      return;
    }

    const me = p;
    switch (pend.type) {
      case 'choose': {
        const picked = ui.picked && E.currentPlants(game).includes(ui.picked) ? ui.picked : null;
        let body = `<p>Pick a plant from the current market to put up for auction${pend.canPass ? ', or pass for this round' : '. Everyone must buy a plant in round 1'}.</p>`;
        if (picked) {
          const pl = PLANTS[picked];
          const bid = Math.max(picked, Math.min(ui.bid || picked, me.money));
          ui.bid = bid;
          body += `<div class="row">${plantCard(picked)}<div><p>Fuel: ${pl.type === 'eco' ? 'none' : `${pl.inputs} ${pl.type === 'hybrid' ? 'coal or oil' : pl.type}`}</p><p>Powers ${pl.output} ${pl.output === 1 ? 'city' : 'cities'}</p></div></div>
            <div class="row"><label for="bid-input">Opening bid</label>${stepper('bid-input', bid, picked, me.money)}</div>
            <div class="row"><button type="button" class="primary" data-act="open">Open auction at ${bid}</button></div>`;
        }
        if (pend.canPass) body += `<div class="row"><button type="button" data-act="pass">Pass this round</button></div>`;
        el.innerHTML = `<h2>Your turn: auction</h2>${body}${err}`;
        return;
      }
      case 'bid': {
        const c = game.auction.current;
        const min = c.bid + 1;
        const can = me.money >= min;
        const bid = Math.max(min, Math.min(ui.bid, me.money));
        ui.bid = bid;
        el.innerHTML = `<h2>Your bid</h2>
          <div class="row">${plantCard(c.plant)}<div><p>High bid <b class="num">${c.bid}</b> by ${esc(game.players[c.high].name)}</p><p class="meta">You have ${me.money} Elektro</p></div></div>
          ${can ? `<div class="row"><label for="bid-input">Your bid</label>${stepper('bid-input', bid, min, me.money)}</div>` : '<p>You cannot afford to raise.</p>'}
          <div class="row">${can ? `<button type="button" class="primary" data-act="bid">Bid ${bid}</button>` : ''}<button type="button" data-act="pass-bid">Pass</button></div>${err}`;
        return;
      }
      case 'discard': {
        const options = me.plants.filter((n) => n !== game.discard.newPlant);
        el.innerHTML = `<h2>Scrap a plant</h2><p>You can own ${game.rules.maxPlants} plants. Choose an older one to scrap. Fuel that no longer fits is returned to the supply.</p>
          <div class="row">${options.map((n) => `<button type="button" data-act="discard" data-n="${n}">Scrap ${n}</button>`).join('')}</div>${err}`;
        return;
      }
      case 'resources': {
        let cost = 0;
        const after = { ...me.resources };
        const rows = RESOURCES.map((r) => {
          const n = ui.resCart[r];
          const c = E.resourceCost(game, r, n);
          cost += c;
          after[r] += n;
          const max = game.resMarket[r];
          const next = n < max ? E.unitPrice(game, r, n) : null;
          return `<div class="buyrow"><span class="rname"><span class="tok ${r}"></span>${r}</span>${stepper(`res-${r}`, n, 0, max)}<span class="meta">${n ? `${c} total · ` : ''}${next !== null ? `next ${next}` : 'sold out'}</span></div>`;
        }).join('');
        const fits = E.canHold(me.plants, after);
        const caps = E.storageCaps(me.plants);
        const capText = ['coal', 'oil', 'garbage', 'uranium', 'hybrid'].filter((r) => caps[r]).map((r) => `${caps[r]} ${r === 'hybrid' ? 'coal/oil' : r}`).join(', ') || 'nothing';
        el.innerHTML = `<h2>Your turn: buy resources</h2>
          <p>Your plants can store ${capText}. Each plant needs one load to run.</p>
          ${rows}
          <div class="summary"><span>Cost ${cost}</span><span>Left ${me.money - cost}</span></div>
          ${!fits ? '<p class="err">That is more than your plants can store.</p>' : ''}
          <div class="row"><button type="button" class="primary" data-act="buy"${!fits || cost > me.money ? ' disabled' : ''}>${cost ? `Buy for ${cost}` : 'Buy nothing'}</button>
          <button type="button" data-act="suggest-res">Fill one load each</button></div>${err}`;
        return;
      }
      case 'build': {
        const cart = ui.buildCart;
        const cost = cart.length ? E.buildCost(game, me.id, cart) : { ok: true, total: 0, slots: 0, connection: 0 };
        const fueled = poweredNow(me);
        el.innerHTML = `<h2>Your turn: build</h2>
          <p>Click cities on the map. Each costs ${game.step === 1 ? '10' : '10 / 15' + (game.step === 3 ? ' / 20' : '')} for the slot plus connections from your network.</p>
          ${cart.length ? `<ol class="cart-list">${cart.map((id) => `<li>${esc(CITIES[id].name)}</li>`).join('')}</ol>` : '<p class="meta">No cities selected.</p>'}
          <div class="summary"><span>Slots ${cost.slots} + links ${cost.connection} = ${cost.total}</span><span>Left ${me.money - cost.total}</span></div>
          <p class="meta">You'll have ${me.cities.length + cart.length} cities; your fuelled plants can power ${fueled}.</p>
          <div class="row"><button type="button" class="primary" data-act="build"${cost.total > me.money ? ' disabled' : ''}>${cart.length ? `Build ${cart.length} for ${cost.total}` : 'Build nothing'}</button>
          ${cart.length ? '<button type="button" data-act="clear-build">Clear</button>' : ''}
          <button type="button" data-act="suggest-build">Suggest</button></div>${err}`;
        return;
      }
      case 'power': {
        const sel = [...ui.powerSel];
        const ok = E.canRun(sel, me.resources);
        const powered = ok ? Math.min(E.capacityOf(sel), me.cities.length) : 0;
        const checks = me.plants.map((n) => {
          const pl = PLANTS[n];
          return `<label class="check"><input type="checkbox" data-power="${n}"${ui.powerSel.has(n) ? ' checked' : ''}>${plantCard(n, { small: true })}<span>${pl.type === 'eco' ? 'no fuel' : `burns ${pl.inputs} ${pl.type === 'hybrid' ? 'coal/oil' : pl.type}`}</span></label>`;
        }).join('');
        el.innerHTML = `<h2>Your turn: power cities</h2>
          <p>Choose which plants to run. You own ${me.cities.length} ${me.cities.length === 1 ? 'city' : 'cities'}.</p>
          ${checks || '<p class="meta">You have no plants.</p>'}
          ${!ok ? '<p class="err">Not enough fuel for that combination.</p>' : ''}
          <div class="summary"><span>Powering ${powered}</span><span>Income ${PAYOUT[Math.min(powered, 20)]}</span></div>
          ${game.endTriggered ? '<p><b>Final round.</b> Most cities powered wins.</p>' : ''}
          <div class="row"><button type="button" class="primary" data-act="power"${ok ? '' : ' disabled'}>Power ${powered} and collect ${PAYOUT[Math.min(powered, 20)]}</button></div>${err}`;
        return;
      }
    }
  }

  function poweredNow(me) {
    return E.bestPower({ ...me, cities: new Array(99).fill('x') }).powered;
  }

  // ---------- events ----------
  function readNumber(id, fallbackValue) {
    const v = parseInt($(id)?.value, 10);
    return Number.isFinite(v) ? v : fallbackValue;
  }

  $('action').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const pend = E.pending(game);

    if (btn.dataset.step) {
      const id = btn.dataset.step, d = Number(btn.dataset.d);
      const input = $(id);
      const v = Math.max(Number(input.min), Math.min(Number(input.max), readNumber(id, 0) + d));
      setStepValue(id, v);
      return;
    }

    switch (btn.dataset.act) {
      case 'new': openSetup(); break;
      case 'open': humanAct({ type: 'choose', plant: ui.picked, bid: readNumber('bid-input', ui.picked) }); break;
      case 'pass': humanAct({ type: 'pass' }); break;
      case 'bid': humanAct({ type: 'bid', amount: readNumber('bid-input', ui.bid) }); break;
      case 'pass-bid': humanAct({ type: 'pass' }); break;
      case 'discard': humanAct({ type: 'discard', plant: Number(btn.dataset.n) }); break;
      case 'buy': humanAct({ type: 'buy', purchase: { ...ui.resCart } }); break;
      case 'suggest-res': ui.resCart = suggestResources(game.players[pend.player]); ui.error = ''; render(); break;
      case 'build': humanAct({ type: 'build', cities: ui.buildCart.slice() }); break;
      case 'clear-build': ui.buildCart = []; ui.error = ''; render(); break;
      case 'suggest-build': ui.buildCart = AI.decide(game, pend).cities; ui.error = ''; render(); break;
      case 'power': humanAct({ type: 'power', plants: [...ui.powerSel] }); break;
    }
  });

  function setStepValue(id, v) {
    if (id === 'bid-input') ui.bid = v;
    else if (id.startsWith('res-')) ui.resCart[id.slice(4)] = v;
    render();
    $(id)?.focus();
  }

  $('action').addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.power) {
      const n = Number(t.dataset.power);
      if (t.checked) ui.powerSel.add(n); else ui.powerSel.delete(n);
      render();
      return;
    }
    if (t.type === 'number') {
      const v = Math.max(Number(t.min), Math.min(Number(t.max), readNumber(t.id, Number(t.min))));
      setStepValue(t.id, v);
    }
  });

  // Buy one load for every fuelled plant, cheapest fuel first for hybrids.
  function suggestResources(me) {
    const cart = { coal: 0, oil: 0, garbage: 0, uranium: 0 };
    const have = { ...me.resources };
    const sim = { resMarket: { ...game.resMarket } };
    let budget = me.money;
    const buy = (r) => {
      if (sim.resMarket[r] <= 0 || E.unitPrice(sim, r) > budget) return false;
      budget -= E.unitPrice(sim, r);
      cart[r]++; sim.resMarket[r]--; return true;
    };
    for (const n of me.plants) {
      const p = PLANTS[n];
      if (p.type === 'eco') continue;
      for (let k = 0; k < p.inputs; k++) {
        if (p.type === 'hybrid') {
          if (have.coal > 0) { have.coal--; continue; }
          if (have.oil > 0) { have.oil--; continue; }
          const pc = sim.resMarket.coal ? E.unitPrice(sim, 'coal') : Infinity;
          const po = sim.resMarket.oil ? E.unitPrice(sim, 'oil') : Infinity;
          if (pc <= po) buy('coal') || buy('oil'); else buy('oil') || buy('coal');
        } else if (have[p.type] > 0) have[p.type]--;
        else buy(p.type);
      }
    }
    return cart;
  }

  $('plants').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-plant]');
    if (!btn) return;
    ui.picked = Number(btn.dataset.plant);
    ui.bid = ui.picked;
    ui.error = '';
    render();
  });

  function toggleCity(id) {
    const pend = E.pending(game);
    if (pend.type !== 'build' || !isHumanTurn(pend)) return;
    const i = ui.buildCart.indexOf(id);
    if (i >= 0) ui.buildCart.splice(i, 1);
    else {
      const cost = E.buildCost(game, pend.player, [...ui.buildCart, id]);
      if (!cost.ok) { ui.error = cost.error; render(); return; }
      ui.buildCart.push(id);
    }
    ui.error = '';
    render();
  }
  $('map').addEventListener('click', (ev) => {
    const g = ev.target.closest('[data-city]');
    if (g && (g.classList.contains('buildable') || g.classList.contains('selected'))) toggleCity(g.dataset.city);
  });
  $('map').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const g = ev.target.closest('[data-city]');
    if (!g) return;
    ev.preventDefault();
    const id = g.dataset.city;
    toggleCity(id);
    document.querySelector(`[data-city="${id}"]`)?.focus();
  });

  $('btn-speed').addEventListener('click', () => {
    const names = Object.keys(SPEEDS);
    prefs.speed = names[(names.indexOf(prefs.speed) + 1) % names.length];
    saveJSON(PREF_KEY, prefs);
    renderStatus();
  });

  // ---------- setup dialog ----------
  function openSetup() {
    $('opt-name').value = prefs.name;
    $('opt-opponents').value = String(prefs.opponents);
    $('opt-colors').innerHTML = PLAYER_COLORS.map((c) => `<label title="${c.name}"><input type="radio" name="color" value="${c.value}"${c.value === prefs.color ? ' checked' : ''}><span style="background:${c.value}"></span><b hidden>${c.name}</b></label>`).join('');
    $('opt-hide').checked = !!prefs.hideMoney;
    $(prefs.regionMode === 'pick' ? 'opt-region-pick' : 'opt-region-random').checked = true;
    const chosen = prefs.regions || [];
    $('opt-regions').innerHTML = Object.entries(REGIONS).map(([id, r]) =>
      `<label><input type="checkbox" name="region" value="${id}"${chosen.includes(id) ? ' checked' : ''}> ${r.name}</label>`).join('');
    $('setup-error').hidden = true;
    refreshRegionPicker();
    $('setup').hidden = false;
    $('opt-name').focus();
  }

  function regionsNeeded() {
    return window.PG.RULES[Number($('opt-opponents').value) + 1].regions;
  }
  function chosenRegions() {
    return [...document.querySelectorAll('#opt-regions input:checked')].map((i) => i.value);
  }
  // Explain what's needed and whether the current pick works.
  function refreshRegionPicker() {
    const picking = $('opt-region-pick').checked;
    const need = regionsNeeded();
    document.querySelectorAll('#opt-regions input').forEach((i) => { i.disabled = !picking; });
    $('opt-regions').classList.toggle('off', !picking);
    const picked = chosenRegions();
    let hint;
    if (!picking) hint = `${need} neighbouring regions will be picked at random.`;
    else if (picked.length !== need) hint = `Pick ${need} regions that border each other (${picked.length} picked).`;
    else if (!E.regionsValid(picked, need)) hint = 'Those regions don\'t all connect. Pick regions that border each other.';
    else hint = 'Good: those regions connect.';
    $('region-hint').textContent = hint;
    $('region-hint').classList.toggle('ok', picking && E.regionsValid(picked, need));
  }
  $('setup-form').addEventListener('change', (ev) => {
    if (ev.target.name === 'region' || ev.target.name === 'regionMode' || ev.target.id === 'opt-opponents') {
      $('setup-error').hidden = true;
      refreshRegionPicker();
    }
  });
  $('btn-new').addEventListener('click', openSetup);
  $('setup-cancel').addEventListener('click', () => { $('setup').hidden = true; });
  $('setup-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = new FormData(ev.target);
    prefs = {
      ...prefs,
      name: String(form.get('name') || 'You').trim().slice(0, 16) || 'You',
      opponents: Number(form.get('opponents')) || 1,
      color: String(form.get('color') || PLAYER_COLORS[0].value),
      hideMoney: form.get('hideMoney') === 'on',
      regionMode: form.get('regionMode') === 'pick' ? 'pick' : 'random',
      regions: chosenRegions(),
    };
    if (prefs.regionMode === 'pick' && !E.regionsValid(prefs.regions, regionsNeeded())) {
      $('setup-error').textContent = `Choose exactly ${regionsNeeded()} regions that border each other, or switch to Random.`;
      $('setup-error').hidden = false;
      return;
    }
    saveJSON(PREF_KEY, prefs);
    $('setup').hidden = true;
    startGame(prefs);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('setup').hidden) $('setup').hidden = true;
  });

  // ---------- boot ----------
  const saved = loadJSON(SAVE_KEY);
  if (saved && saved.version === 1 && saved.players && saved.phase) {
    game = saved;
    update();
  } else {
    startGame(prefs);
  }
})();
