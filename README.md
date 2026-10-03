# Power Grid vs Computer

A browser version of the board game Power Grid for one human against 1–3 computer opponents.
It's plain HTML, CSS and JavaScript with no build step and no dependencies.

## Play

Open `index.html` in a browser, either by double-clicking it or by serving the folder
(`python3 -m http.server`). The game saves to your browser after every move, so a reload picks up
where you left off. Use **New game** to change your name, colour or number of opponents, pick which regions
are in play (or leave it random), and hide the computer players' money. **AI speed** changes
how fast the computer moves. Player boards stay in fixed places; the numbered badge on each
board shows that player's current position in turn order.

## What's implemented

- **Map:** 42 US cities in six regions. Each game uses a random connected set of regions
  (3 regions for 2–3 players, 4 for 4 players). Connection costs come from distance, with a
  surcharge across the Rockies and the Sierra.
- **All five phases:** turn order, plant auctions (with forced buying in round 1 and scrapping
  plants over the limit), resource buying with storage limits, building with cheapest-route
  connection costs, and bureaucracy with payouts and market restocking.
- **Steps 1–3:** Step 2 starts when a network reaches 10 cities (2 players) or 7 cities (3–4);
  Step 3 starts when its card comes up. Obsolete plants leave the market, and the market
  restocks at each player count's own rates.
- **Game end:** 21 cities (2 players) or 17 cities (3–4). The most cities powered in that round
  wins, then money, then cities.

Plant stats, resource prices, restocking tables and payouts follow the published game.
This version changes one thing: when the Step 3 card comes up during an auction, the rest of
that auction phase draws no replacement plants.

## Computer opponents

`js/ai.js` uses heuristics. It values plants by how much capacity they add and how much they
cost to fuel, holds back cash for fuel and cities, buys fuel for its most efficient plants
first, builds the cheapest reachable cities up to what it can power, and won't end the game
unless it expects to win.

## Code layout

| File | Purpose |
| --- | --- |
| `js/data.js` | Plants, resource tables, payouts, map |
| `js/engine.js` | Rules engine with a JSON-serialisable state, `pending()` and `act()` |
| `js/ai.js` | Computer player |
| `js/ui.js` | Rendering and input |
| `test/simulate.js` | Plays complete AI-only games and checks invariants |

## Tests

```
npm test
```

This plays 120 complete games with 2–4 computer players. After every action it checks that
resources are conserved, money never goes negative, city slots and plant limits hold, and
that every game finishes.
