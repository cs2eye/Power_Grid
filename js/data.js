// Static game data: power plants, resource market, payouts, rules tables and the map.
(function (root) {
  const PG = (root.PG = root.PG || {});

  // [number, resource, inputs, cities powered]
  // resource: coal | oil | hybrid (coal or oil) | garbage | uranium | eco (no fuel)
  const PLANT_LIST = [
    [3, 'oil', 2, 1], [4, 'coal', 2, 1], [5, 'hybrid', 2, 1], [6, 'garbage', 1, 1],
    [7, 'oil', 3, 2], [8, 'coal', 3, 2], [9, 'oil', 1, 1], [10, 'coal', 2, 2],
    [11, 'uranium', 1, 2], [12, 'hybrid', 2, 2], [13, 'eco', 0, 1], [14, 'garbage', 2, 2],
    [15, 'coal', 2, 3], [16, 'oil', 2, 3], [17, 'uranium', 1, 2], [18, 'eco', 0, 2],
    [19, 'garbage', 2, 3], [20, 'coal', 3, 5], [21, 'hybrid', 2, 4], [22, 'eco', 0, 2],
    [23, 'uranium', 1, 3], [24, 'garbage', 2, 4], [25, 'coal', 2, 5], [26, 'oil', 2, 5],
    [27, 'eco', 0, 3], [28, 'uranium', 1, 4], [29, 'hybrid', 1, 4], [30, 'garbage', 3, 6],
    [31, 'coal', 3, 6], [32, 'oil', 3, 6], [33, 'eco', 0, 4], [34, 'uranium', 1, 5],
    [35, 'oil', 1, 5], [36, 'coal', 3, 7], [37, 'eco', 0, 4], [38, 'garbage', 3, 7],
    [39, 'uranium', 1, 6], [40, 'oil', 2, 6], [42, 'coal', 2, 6], [44, 'eco', 0, 5],
    [46, 'hybrid', 3, 7], [50, 'eco', 0, 6],
  ];
  const PLANTS = {};
  for (const [num, type, inputs, output] of PLANT_LIST) PLANTS[num] = { num, type, inputs, output };

  const RESOURCES = ['coal', 'oil', 'garbage', 'uranium'];

  // Price of each market slot, cheapest first. The market fills from the expensive end.
  const tri = (n) => Array.from({ length: n * 3 }, (_, i) => Math.floor(i / 3) + 1);
  const SLOT_PRICES = {
    coal: tri(8),
    oil: tri(8),
    garbage: tri(8),
    uranium: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16],
  };
  const RESOURCE_TOTAL = { coal: 24, oil: 24, garbage: 24, uranium: 12 };
  const RESOURCE_START = { coal: 24, oil: 18, garbage: 6, uranium: 2 };

  // Resupply per round, indexed [step-1].
  const RESUPPLY = {
    2: { coal: [3, 4, 3], oil: [2, 2, 4], garbage: [1, 2, 3], uranium: [1, 1, 1] },
    3: { coal: [4, 5, 3], oil: [2, 3, 4], garbage: [1, 2, 3], uranium: [1, 1, 1] },
    4: { coal: [5, 6, 4], oil: [3, 4, 5], garbage: [2, 3, 4], uranium: [1, 2, 2] },
    5: { coal: [5, 7, 5], oil: [4, 5, 6], garbage: [3, 3, 5], uranium: [2, 3, 2] },
    6: { coal: [7, 9, 6], oil: [5, 6, 7], garbage: [3, 5, 6], uranium: [2, 3, 3] },
  };

  // Cash paid for powering N cities.
  const PAYOUT = [10, 22, 33, 44, 54, 64, 73, 82, 90, 98, 105, 112, 118, 124, 129, 134, 138, 142, 145, 148, 150];

  const RULES = {
    2: { regions: 3, removePlants: 8, maxPlants: 4, step2: 10, end: 21 },
    3: { regions: 3, removePlants: 8, maxPlants: 3, step2: 7, end: 17 },
    4: { regions: 4, removePlants: 4, maxPlants: 3, step2: 7, end: 17 },
    5: { regions: 5, removePlants: 0, maxPlants: 3, step2: 7, end: 15 },
    6: { regions: 5, removePlants: 0, maxPlants: 3, step2: 6, end: 14 },
  };

  const CITY_SLOT_COST = [10, 15, 20];

  const REGIONS = {
    nw: { name: 'Northwest', adj: ['sw', 'mw', 'sc'] },
    sw: { name: 'Southwest', adj: ['nw', 'sc'] },
    sc: { name: 'South Central', adj: ['nw', 'sw', 'mw', 'se'] },
    mw: { name: 'Midwest', adj: ['nw', 'sc', 'ne', 'se'] },
    ne: { name: 'Northeast', adj: ['mw', 'se'] },
    se: { name: 'Southeast', adj: ['sc', 'mw', 'ne'] },
  };

  // id: [name, region, lat, lon]
  const CITY_LIST = {
    sea: ['Seattle', 'nw', 47.6, -122.3], por: ['Portland', 'nw', 45.5, -122.7],
    boi: ['Boise', 'nw', 43.6, -116.2], bil: ['Billings', 'nw', 45.8, -108.5],
    che: ['Cheyenne', 'nw', 41.1, -104.8], den: ['Denver', 'nw', 39.7, -105.0],
    oma: ['Omaha', 'nw', 41.3, -96.0],
    sfo: ['San Francisco', 'sw', 37.8, -122.4], lax: ['Los Angeles', 'sw', 34.1, -118.2],
    san: ['San Diego', 'sw', 32.7, -117.2], las: ['Las Vegas', 'sw', 36.2, -115.1],
    slc: ['Salt Lake City', 'sw', 40.8, -111.9], phx: ['Phoenix', 'sw', 33.4, -112.1],
    saf: ['Santa Fe', 'sw', 35.7, -105.9],
    kcy: ['Kansas City', 'sc', 39.1, -94.6], okc: ['Oklahoma City', 'sc', 35.5, -97.5],
    dal: ['Dallas', 'sc', 32.8, -96.8], hou: ['Houston', 'sc', 29.8, -95.4],
    mem: ['Memphis', 'sc', 35.1, -90.0], msy: ['New Orleans', 'sc', 30.0, -90.1],
    bhm: ['Birmingham', 'sc', 33.5, -86.8],
    far: ['Fargo', 'mw', 46.9, -96.8], dlh: ['Duluth', 'mw', 46.8, -92.1],
    msp: ['Minneapolis', 'mw', 45.0, -93.3], chi: ['Chicago', 'mw', 41.9, -87.6],
    stl: ['St. Louis', 'mw', 38.6, -90.2], cin: ['Cincinnati', 'mw', 39.1, -84.5],
    knx: ['Knoxville', 'mw', 36.0, -83.9],
    det: ['Detroit', 'ne', 42.3, -83.0], buf: ['Buffalo', 'ne', 42.9, -78.9],
    pit: ['Pittsburgh', 'ne', 40.4, -80.0], bos: ['Boston', 'ne', 42.4, -71.1],
    nyc: ['New York', 'ne', 40.7, -74.0], phl: ['Philadelphia', 'ne', 39.95, -75.2],
    was: ['Washington', 'ne', 38.9, -77.0],
    orf: ['Norfolk', 'se', 36.9, -76.3], ral: ['Raleigh', 'se', 35.8, -78.6],
    atl: ['Atlanta', 'se', 33.7, -84.4], sav: ['Savannah', 'se', 32.1, -81.1],
    jax: ['Jacksonville', 'se', 30.3, -81.7], tpa: ['Tampa', 'se', 27.9, -82.5],
    mia: ['Miami', 'se', 25.8, -80.2],
  };

  const EDGE_LIST = `
    sea-por sea-boi sea-bil por-boi por-sfo boi-bil boi-che boi-slc boi-sfo bil-che bil-far bil-msp
    che-den che-oma che-msp den-oma den-kcy den-saf den-slc oma-msp oma-chi oma-kcy
    sfo-lax sfo-slc sfo-las lax-san lax-las san-las san-phx las-slc las-saf las-phx phx-saf
    saf-okc saf-dal saf-hou saf-kcy
    kcy-okc kcy-stl kcy-mem okc-dal okc-mem dal-hou dal-mem dal-msy hou-msy mem-msy mem-bhm mem-stl
    msy-bhm msy-jax bhm-atl bhm-jax
    far-dlh far-msp dlh-msp dlh-chi dlh-det msp-chi chi-stl chi-cin chi-det stl-cin stl-atl
    cin-knx cin-det cin-pit cin-ral knx-atl
    det-buf det-pit buf-pit buf-nyc bos-nyc nyc-phl phl-was pit-was pit-ral was-orf
    orf-ral ral-atl ral-sav atl-sav sav-jax jax-tpa tpa-mia`;

  // Connection cost from straight-line distance (~30 miles per Elektro), with
  // a surcharge for routes crossing the Rockies and Sierra.
  const MOUNTAIN = new Set(['sfo-slc', 'boi-slc', 'den-slc', 'boi-che', 'boi-sfo', 'den-saf', 'sea-boi', 'por-boi']);
  function miles(a, b) {
    const R = 3959, rad = Math.PI / 180;
    const dLat = (b[2] - a[2]) * rad, dLon = (b[3] - a[3]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[2] * rad) * Math.cos(b[2] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const EDGES = EDGE_LIST.trim().split(/\s+/).map((pair) => {
    const [a, b] = pair.split('-');
    let cost = Math.round(miles(CITY_LIST[a], CITY_LIST[b]) / 30);
    if (MOUNTAIN.has(pair)) cost = Math.round(cost * 1.35);
    return { a, b, cost: Math.max(0, cost) };
  });

  const CITIES = {};
  for (const [id, [name, region, lat, lon]] of Object.entries(CITY_LIST)) {
    CITIES[id] = { id, name, region, lat, lon };
  }

  Object.assign(PG, {
    PLANTS, RESOURCES, SLOT_PRICES, RESOURCE_TOTAL, RESOURCE_START, RESUPPLY, PAYOUT,
    RULES, CITY_SLOT_COST, REGIONS, CITIES, EDGES,
  });
})(typeof window !== 'undefined' ? window : globalThis);
