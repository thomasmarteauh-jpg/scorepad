// ---- Database setup (Dexie = a friendly wrapper around the browser's IndexedDB storage) ----
const db = new Dexie("ScorePadDB");

db.version(1).stores({
  // "++id" means an auto-incrementing id is generated for each new row.
  games: "++id, name, createdAt, isComplete",
  players: "++id, name",
  scores: "++id, gameId, roundIndex, playerId",
});

db.version(2).stores({
  // Compound indexes speed up the round-sheet lookups (by game+round, and by game+round+player).
  games: "++id, name, createdAt, isComplete",
  players: "++id, name",
  scores: "++id, gameId, roundIndex, playerId, [gameId+roundIndex], [gameId+roundIndex+playerId]",
});

db.version(3).stores({
  // contractSets holds named lists of round contracts (e.g. "Standard").
  // Each record's "contracts" property is a plain array, so it isn't indexed here.
  games: "++id, name, createdAt, isComplete",
  players: "++id, name",
  scores: "++id, gameId, roundIndex, playerId, [gameId+roundIndex], [gameId+roundIndex+playerId]",
  contractSets: "++id, name",
});

// A "mode" (stored in the contractSets table) is a named round list plus its
// purchase rules. Purchases are counted once per player for the whole game —
// they don't reset each round — and each one adds a penalty to that player's total.
db.version(4)
  .stores({
    games: "++id, name, createdAt, isComplete",
    players: "++id, name",
    scores: "++id, gameId, roundIndex, playerId, [gameId+roundIndex], [gameId+roundIndex+playerId]",
    contractSets: "++id, name",
    purchases: "++id, gameId, playerId, [gameId+playerId]",
  })
  .upgrade((tx) =>
    tx
      .table("contractSets")
      .toCollection()
      .modify((set) => {
        if (set.purchasesPerPlayer === undefined) set.purchasesPerPlayer = DEFAULT_PURCHASES_PER_PLAYER;
        if (set.penaltyPerPurchase === undefined) set.penaltyPerPurchase = DEFAULT_PENALTY_PER_PURCHASE;
      })
  );

// Buys now belong to the round they were made in, which is what lets the chart
// place them in time. Rows recorded before this carried only a per-game total,
// so they're attributed to round 1 — totals stay correct either way.
db.version(5)
  .stores({
    games: "++id, name, createdAt, isComplete",
    players: "++id, name",
    scores: "++id, gameId, roundIndex, playerId, [gameId+roundIndex], [gameId+roundIndex+playerId]",
    contractSets: "++id, name",
    purchases: "++id, gameId, playerId, roundIndex, [gameId+playerId], [gameId+roundIndex], [gameId+roundIndex+playerId]",
  })
  .upgrade((tx) =>
    tx
      .table("purchases")
      .toCollection()
      .modify((row) => {
        if (row.roundIndex === undefined) row.roundIndex = 1;
      })
  );

// One row per buy, each carrying the card that was taken (both fields null if
// the card wasn't recorded). Rows previously held a count, so they're expanded
// into that many cardless buys — the totals they produce are unchanged.
db.version(6)
  .stores({
    games: "++id, name, createdAt, isComplete",
    players: "++id, name",
    scores: "++id, gameId, roundIndex, playerId, [gameId+roundIndex], [gameId+roundIndex+playerId]",
    contractSets: "++id, name",
    purchases: "++id, gameId, playerId, roundIndex, [gameId+playerId], [gameId+roundIndex], [gameId+roundIndex+playerId]",
  })
  .upgrade(async (tx) => {
    const table = tx.table("purchases");
    const rows = await table.toArray();
    const expanded = [];
    for (const row of rows) {
      const count = row.count === undefined ? 1 : row.count;
      for (let i = 0; i < count; i++) {
        expanded.push({
          gameId: row.gameId,
          roundIndex: row.roundIndex === undefined ? 1 : row.roundIndex,
          playerId: row.playerId,
          rank: null,
          suit: null,
        });
      }
    }
    await table.clear();
    if (expanded.length) await table.bulkAdd(expanded);
  });

const CARD_RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const CARD_SUITS = [
  { code: "S", symbol: "♠", red: false },
  { code: "H", symbol: "♥", red: true },
  { code: "D", symbol: "♦", red: true },
  { code: "C", symbol: "♣", red: false },
];

function suitInfo(code) {
  return CARD_SUITS.find((s) => s.code === code) || null;
}

function cardLabel(row) {
  const suit = suitInfo(row.suit);
  return row.rank && suit ? `${row.rank}${suit.symbol}` : "?";
}

const DEFAULT_CONTRACTS = [
  "2 sets of 3",
  "1 set of 4",
  "2 sets of 4",
  "1 set of 5",
  "2 sets of 5",
  "1 set of 6",
];

const DEFAULT_PURCHASES_PER_PLAYER = 5;
const DEFAULT_PENALTY_PER_PURCHASE = 20;

// Modes saved before purchases existed (or restored from an older backup)
// won't have these fields, so always read them through these helpers.
function purchaseLimitOf(mode) {
  const value = mode && mode.purchasesPerPlayer;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PURCHASES_PER_PLAYER;
}

function penaltyOf(mode) {
  const value = mode && mode.penaltyPerPurchase;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PENALTY_PER_PURCHASE;
}

function parseNonNegativeInt(text, fallback) {
  const value = parseInt(String(text).trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function ensureDefaultContractSet() {
  const count = await db.contractSets.count();
  if (count === 0) {
    await db.contractSets.add({
      name: "Standard",
      contracts: DEFAULT_CONTRACTS.slice(),
      purchasesPerPlayer: DEFAULT_PURCHASES_PER_PLAYER,
      penaltyPerPurchase: DEFAULT_PENALTY_PER_PURCHASE,
    });
  }
}

// Keep in step with CACHE_VERSION in sw.js. Settings compares the two: this
// one is whichever app.js the page actually loaded, while the cache version
// reflects the service worker in charge. A mismatch means an update has been
// fetched but the old worker is still serving, which is exactly the state
// that used to be invisible.
const APP_VERSION = "21";

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

// ---- Shared elements ----
const newGameBtn = document.getElementById("new-game-btn");

// ---- Simple hash router ----
// The address after "#" tells us which screen to show, e.g. "#/new-game"
// or "#/scorecard/3". Changing location.hash is how we "navigate".
function navigate(path) {
  location.hash = `#/${path}`;
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  newGameBtn.style.display = id === "games-screen" ? "" : "none";
  // Home shows its own logo and name, so the app header is redundant there.
  document.body.classList.toggle("on-home", id === "home-screen");
}

async function handleRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);

  if (parts[0] === "home") {
    await enterHomeScreen();
  } else if (parts[0] === "games") {
    await enterGamesScreen();
  } else if (parts[0] === "new-game") {
    await enterNewGameScreen();
  } else if (parts[0] === "scorecard" && parts[1]) {
    await enterScorecardScreen(Number(parts[1]));
  } else if (parts[0] === "summary" && parts[1]) {
    await enterSummaryScreen(Number(parts[1]));
  } else if (parts[0] === "settings") {
    await enterSettingsScreen();
  } else if (parts[0] === "stats") {
    await enterStatsScreen();
  } else if (parts[0] === "contract-set" && parts[1]) {
    await enterContractSetScreen(Number(parts[1]));
  } else {
    // No hash — how the app opens from the home screen icon.
    await enterHomeScreen();
  }
}

window.addEventListener("hashchange", handleRoute);

// Ranks players lowest-total-first (lowest total wins).
// purchasePoints maps a playerId to the penalty points they've accrued from
// purchases; pass it wherever totals need to match the scorecard's Total row.
function computeStandings(players, scores, purchasePoints) {
  const standings = players.map((player) => ({
    player,
    total:
      scores.filter((s) => s.playerId === player.id).reduce((sum, s) => sum + s.points, 0) +
      ((purchasePoints && purchasePoints.get(player.id)) || 0),
  }));
  standings.sort((a, b) => a.total - b.total);
  return standings;
}

function makeCell(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

// Resolves the mode a game is played under, falling back to the first mode
// available if the game predates modes or its mode was deleted.
async function getModeForGame(game) {
  let mode = game.contractSetId ? await db.contractSets.get(game.contractSetId) : null;
  if (!mode) {
    mode = await db.contractSets.orderBy("id").first();
  }
  return mode || { name: "Standard", contracts: DEFAULT_CONTRACTS };
}

// playerId -> total buys for the game. Each row is a single buy, so this is a
// count of rows; the limit still applies across the whole game, and the clamp
// covers a mode whose limit was lowered after the fact.
function totalBuysByPlayer(rows, limit) {
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.playerId, (totals.get(row.playerId) || 0) + 1);
  }
  for (const [playerId, count] of totals) totals.set(playerId, Math.min(count, limit));
  return totals;
}

function buysToPoints(buysByPlayer, penalty) {
  return new Map([...buysByPlayer].map(([playerId, count]) => [playerId, count * penalty]));
}

// playerId -> penalty points owed for purchases in this game.
async function getPurchasePointsForGame(game, mode) {
  const resolvedMode = mode || (await getModeForGame(game));
  const rows = await db.purchases.where("gameId").equals(game.id).toArray();
  return buysToPoints(totalBuysByPlayer(rows, purchaseLimitOf(resolvedMode)), penaltyOf(resolvedMode));
}

// ==================================================
// Screen 0: home
// ==================================================
const homeContinueBtn = document.getElementById("home-continue-btn");
const homeNewGameBtn = document.getElementById("home-new-game-btn");
const homeGamesBtn = document.getElementById("home-games-btn");
const homeSettingsBtn = document.getElementById("home-settings-btn");
const homeVersionEl = document.getElementById("home-version");

async function enterHomeScreen() {
  showScreen("home-screen");
  homeVersionEl.textContent = `Version ${APP_VERSION}`;

  // Offer the most recent unfinished game, which is nearly always the one
  // you're coming back to.
  const games = await db.games.orderBy("createdAt").reverse().toArray();
  const inProgress = games.find((game) => !game.isComplete);

  homeContinueBtn.hidden = !inProgress;
  if (inProgress) {
    homeContinueBtn.textContent = `Continue — ${inProgress.name}`;
    homeContinueBtn.onclick = () => navigate(`scorecard/${inProgress.id}`);
  }

  // Whichever action is topmost should read as the primary one.
  homeNewGameBtn.classList.toggle("btn-primary", !inProgress);
  homeNewGameBtn.classList.toggle("btn-secondary", !!inProgress);
}

homeNewGameBtn.addEventListener("click", () => navigate("new-game"));
homeGamesBtn.addEventListener("click", () => navigate("games"));
homeSettingsBtn.addEventListener("click", () => navigate("settings"));
document.getElementById("games-home-btn").addEventListener("click", () => navigate("home"));

// ==================================================
// Screen 1: games list
// ==================================================
const gamesListEl = document.getElementById("games-list");

async function enterGamesScreen() {
  showScreen("games-screen");
  await renderGamesList();
  await renderBackupNudge();
}

async function renderGamesList() {
  const games = await db.games.orderBy("createdAt").reverse().toArray();

  gamesListEl.innerHTML = "";

  if (games.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No games yet";
    gamesListEl.appendChild(empty);
    return;
  }

  // Fetched once and grouped in memory rather than queried per game.
  const [players, allScores, allPurchases, modes] = await Promise.all([
    db.players.toArray(),
    db.scores.toArray(),
    db.purchases.toArray(),
    db.contractSets.toArray(),
  ]);

  const ctx = {
    playerById: new Map(players.map((p) => [p.id, p])),
    modeById: new Map(modes.map((m) => [m.id, m])),
    fallbackMode: modes[0],
    scoresByGame: groupBy(allScores, "gameId"),
    purchasesByGame: groupBy(allPurchases, "gameId"),
  };

  for (const game of games) {
    gamesListEl.appendChild(buildGameRow(game, describeGame(game, ctx)));
  }
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

// The sub-line under a game's name: how far along it is, or who won.
function describeGame(game, ctx) {
  const gameScores = ctx.scoresByGame.get(game.id) || [];
  const mode = ctx.modeById.get(game.contractSetId) || ctx.fallbackMode;
  const contracts = (mode && mode.contracts) || DEFAULT_CONTRACTS;

  if (game.isComplete) {
    const winner = winnerNameFor(game, gameScores, mode, ctx);
    return winner ? `Completed · Winner: ${winner}` : "Completed";
  }

  const roundsPlayed = gameScores.reduce((max, s) => Math.max(max, s.roundIndex), 0);
  // The round they're on now, capped at the mode's last round.
  const currentRound = Math.min(roundsPlayed + 1, contracts.length);
  return `In progress · Round ${currentRound} of ${contracts.length}`;
}

function winnerNameFor(game, gameScores, mode, ctx) {
  if (gameScores.length === 0) return null;

  const purchasePoints = buysToPoints(
    totalBuysByPlayer(ctx.purchasesByGame.get(game.id) || [], purchaseLimitOf(mode)),
    penaltyOf(mode)
  );

  const gamePlayers = game.playerIds.map((id) => ctx.playerById.get(id)).filter(Boolean);
  if (gamePlayers.length === 0) return null;

  return computeStandings(gamePlayers, gameScores, purchasePoints)[0].player.name;
}

const PENCIL_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
  <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
</svg>`;

// A game row is a swipeable card: the content slides left to reveal a red
// Delete behind it, mirroring the iOS swipe-to-delete pattern.
function buildGameRow(game, statusText) {
  const row = document.createElement("div");
  row.className = "game-row";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "game-row-delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.setAttribute("aria-label", `Delete ${game.name}`);
  deleteBtn.addEventListener("click", () => {
    // confirm() first, synchronously — see the note in handleUndoLastRound.
    if (!confirm(`Delete "${game.name}"? This also removes its scores.`)) return;
    deleteGame(game.id);
  });

  const content = document.createElement("div");
  content.className = "game-row-content";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "game-item";
  openBtn.textContent = game.name;
  if (statusText) openBtn.appendChild(makeCell("span", statusText, "game-status"));
  openBtn.addEventListener("click", () => {
    // A swipe shouldn't also open the game; and while open, a tap just closes.
    if (row.dataset.suppressClick || row.classList.contains("is-open")) {
      setRowOpen(row, false);
      return;
    }
    navigate(`scorecard/${game.id}`);
  });

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "game-edit-btn";
  editBtn.innerHTML = PENCIL_SVG;
  editBtn.setAttribute("aria-label", `Rename ${game.name}`);
  editBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (row.dataset.suppressClick) return;
    // prompt() first, synchronously — same iOS gesture rule as confirm().
    const next = prompt("Rename game", game.name);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    db.games.update(game.id, { name: trimmed }).then(renderGamesList);
  });

  content.appendChild(openBtn);
  content.appendChild(editBtn);
  row.appendChild(deleteBtn);
  row.appendChild(content);
  attachSwipeToDelete(row, content);
  return row;
}

const SWIPE_OPEN_X = -88;

function setRowOpen(row, open) {
  const content = row.querySelector(".game-row-content");
  row.classList.toggle("is-open", open);
  content.style.transform = `translateX(${open ? SWIPE_OPEN_X : 0}px)`;
}

function closeAllGameRows(except) {
  for (const row of gamesListEl.querySelectorAll(".game-row.is-open")) {
    if (row !== except) setRowOpen(row, false);
  }
}

function attachSwipeToDelete(row, content) {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let axisDecided = false;
  let horizontal = false;
  let offset = 0;

  content.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startX = event.clientX;
    startY = event.clientY;
    tracking = true;
    axisDecided = false;
    horizontal = false;
    offset = row.classList.contains("is-open") ? SWIPE_OPEN_X : 0;
    content.style.transition = "none";
  });

  content.addEventListener("pointermove", (event) => {
    if (!tracking) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!axisDecided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axisDecided = true;
      // A mostly-vertical drag is the user scrolling the list; leave it alone.
      horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) {
        closeAllGameRows(row);
        try {
          content.setPointerCapture(event.pointerId);
        } catch (err) {
          /* capture is a nicety; the drag still tracks without it */
        }
      }
    }
    if (!horizontal) return;

    const base = row.classList.contains("is-open") ? SWIPE_OPEN_X : 0;
    offset = Math.max(SWIPE_OPEN_X, Math.min(0, base + dx));
    content.style.transform = `translateX(${offset}px)`;
  });

  const settle = () => {
    if (!tracking) return;
    tracking = false;
    content.style.transition = "";
    if (!horizontal) return;

    setRowOpen(row, offset < SWIPE_OPEN_X / 2);
    // Swallow the click that the browser fires at the end of a drag.
    row.dataset.suppressClick = "1";
    setTimeout(() => delete row.dataset.suppressClick, 60);
  };

  content.addEventListener("pointerup", settle);
  content.addEventListener("pointercancel", settle);
}

async function deleteGame(gameId) {
  await db.transaction("rw", db.games, db.scores, db.purchases, async () => {
    await db.scores.where("gameId").equals(gameId).delete();
    await db.purchases.where("gameId").equals(gameId).delete();
    await db.games.delete(gameId);
  });
  await renderGamesList();
}

newGameBtn.addEventListener("click", () => navigate("new-game"));
document.getElementById("settings-nav-btn").addEventListener("click", () => navigate("settings"));

// ==================================================
// Screen 2: new game setup
// ==================================================
const playerCountValueEl = document.getElementById("player-count-value");
const playerCountMinusBtn = document.getElementById("player-count-minus");
const playerCountPlusBtn = document.getElementById("player-count-plus");
const playerNameFieldsEl = document.getElementById("player-name-fields");
const playerNamesDatalistEl = document.getElementById("player-names-datalist");
const contractSetSelectEl = document.getElementById("contract-set-select");
const newGameErrorEl = document.getElementById("new-game-error");

let playerCount = 4;

// Names already taken, loaded when the screen opens so the suggested name can
// be built synchronously — prompt() can't wait on a query. See the note in
// handleUndoLastRound about async gaps breaking dialogs on iOS.
let existingGameNames = new Set();

// Includes the time, not just the date, so two games on the same evening
// aren't identically named. Two within the same minute get a counter.
function defaultGameName(date) {
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const base = `Game — ${day}, ${time}`;

  if (!existingGameNames.has(base)) return base;
  let suffix = 2;
  while (existingGameNames.has(`${base} (${suffix})`)) suffix++;
  return `${base} (${suffix})`;
}

async function enterNewGameScreen() {
  showScreen("new-game-screen");
  playerCount = 4;
  newGameErrorEl.hidden = true;
  existingGameNames = new Set((await db.games.toArray()).map((g) => g.name));
  await populatePlayerDatalist();
  await populateContractSetSelect();
  renderPlayerNameFields();
  updatePlayerCountControls();
}

async function populatePlayerDatalist() {
  const players = (await db.players.orderBy("name").toArray()).filter((p) => !p.hidden);
  playerNamesDatalistEl.innerHTML = "";
  for (const player of players) {
    const option = document.createElement("option");
    option.value = player.name;
    playerNamesDatalistEl.appendChild(option);
  }
}

async function populateContractSetSelect() {
  const contractSets = await db.contractSets.toArray();
  contractSetSelectEl.innerHTML = "";
  for (const set of contractSets) {
    const option = document.createElement("option");
    option.value = String(set.id);
    option.textContent = set.name;
    contractSetSelectEl.appendChild(option);
  }
}

function renderPlayerNameFields() {
  // Keep any names already typed if the player count changes.
  const existingValues = Array.from(playerNameFieldsEl.querySelectorAll("input")).map((i) => i.value);

  playerNameFieldsEl.innerHTML = "";
  for (let i = 0; i < playerCount; i++) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "player-name-input";
    input.placeholder = `Player ${i + 1} name`;
    input.setAttribute("list", "player-names-datalist");
    input.setAttribute("autocomplete", "off");
    input.value = existingValues[i] || "";
    playerNameFieldsEl.appendChild(input);
  }
}

function updatePlayerCountControls() {
  playerCountValueEl.textContent = String(playerCount);
  playerCountMinusBtn.disabled = playerCount <= MIN_PLAYERS;
  playerCountPlusBtn.disabled = playerCount >= MAX_PLAYERS;
}

playerCountMinusBtn.addEventListener("click", () => {
  if (playerCount > MIN_PLAYERS) {
    playerCount--;
    renderPlayerNameFields();
    updatePlayerCountControls();
  }
});

playerCountPlusBtn.addEventListener("click", () => {
  if (playerCount < MAX_PLAYERS) {
    playerCount++;
    renderPlayerNameFields();
    updatePlayerCountControls();
  }
});

document.getElementById("cancel-new-game-btn").addEventListener("click", () => navigate("games"));

document.getElementById("start-game-btn").addEventListener("click", async () => {
  const inputs = Array.from(playerNameFieldsEl.querySelectorAll(".player-name-input"));
  const names = inputs.map((i) => i.value.trim());

  if (names.some((n) => n.length === 0)) {
    newGameErrorEl.textContent = "Enter a name for every player.";
    newGameErrorEl.hidden = false;
    return;
  }

  const lowerNames = names.map((n) => n.toLowerCase());
  if (new Set(lowerNames).size !== lowerNames.length) {
    newGameErrorEl.textContent = "Player names must be unique.";
    newGameErrorEl.hidden = false;
    return;
  }

  newGameErrorEl.hidden = true;

  // prompt() runs before any await — see the note in handleUndoLastRound about
  // async gaps breaking dialogs on iOS. The suggested name carries the time as
  // well as the date, so two games on the same day stay tellable apart.
  const createdAt = new Date();
  const suggestedName = defaultGameName(createdAt);
  const enteredName = prompt("Name this game", suggestedName);
  // Backing out of the naming shouldn't discard the line-up they just entered.
  const gameName = (enteredName === null ? suggestedName : enteredName.trim()) || suggestedName;

  // Reuse an existing player record if the name matches one we already know,
  // otherwise create a new player. This is what powers the autocomplete list.
  const playerIds = [];
  for (const name of names) {
    const existing = await db.players.where("name").equalsIgnoreCase(name).first();
    if (existing) {
      // Someone hidden who's playing again clearly isn't retired after all.
      if (existing.hidden) await db.players.update(existing.id, { hidden: false });
      playerIds.push(existing.id);
    } else {
      playerIds.push(await db.players.add({ name }));
    }
  }

  const gameId = await db.games.add({
    name: gameName,
    createdAt: createdAt.getTime(),
    playerIds,
    contractSetId: Number(contractSetSelectEl.value),
    isComplete: false,
  });

  // Browsers weigh how much the app is actually used, so ask again now that
  // there's real data to protect — it's a no-op if already granted.
  ensurePersistentStorage();

  navigate(`scorecard/${gameId}`);
});

// ==================================================
// Screen 3: scorecard
// ==================================================
const scorecardTitleEl = document.getElementById("scorecard-title");
const scorecardHeaderRowEl = document.getElementById("scorecard-header-row");
const scorecardBodyEl = document.getElementById("scorecard-body");
const scorecardPurchasesRowEl = document.getElementById("scorecard-purchases-row");
const scorecardTotalsRowEl = document.getElementById("scorecard-totals-row");
const addRoundBtn = document.getElementById("add-round-btn");
const undoRoundBtn = document.getElementById("undo-round-btn");
const backToGamesBtn = document.getElementById("back-to-games-btn");
const viewSummaryBtn = document.getElementById("view-summary-btn");
const buysStripTitleEl = document.getElementById("buys-strip-title");
const buysStripListEl = document.getElementById("buys-strip-list");
const logBuyBtn = document.getElementById("log-buy-btn");

let currentGameId = null;
let currentPlayers = [];
let currentMode = null;
let currentContracts = DEFAULT_CONTRACTS;
let currentScores = [];
let currentPurchaseCounts = new Map();
let currentPurchaseRows = [];
let scorecardRoundCount = 1;

async function enterScorecardScreen(gameId) {
  const game = await db.games.get(gameId);
  if (!game) {
    navigate("games");
    return;
  }

  showScreen("scorecard-screen");
  currentGameId = gameId;
  currentPlayers = await Promise.all(game.playerIds.map((id) => db.players.get(id)));
  currentMode = await getModeForGame(game);
  currentContracts =
    Array.isArray(currentMode.contracts) && currentMode.contracts.length ? currentMode.contracts : DEFAULT_CONTRACTS;
  scorecardTitleEl.textContent = game.name;

  const scores = await db.scores.where("gameId").equals(gameId).toArray();
  const maxScoredRound = scores.reduce((max, s) => Math.max(max, s.roundIndex), 0);
  scorecardRoundCount = Math.max(1, maxScoredRound);

  renderScorecardHeader(currentPlayers);
  await refreshScorecardBody();

  backToGamesBtn.onclick = () => navigate("games");
  addRoundBtn.onclick = () => {
    if (isAtFinalRound()) return;
    scorecardRoundCount++;
    refreshScorecardBody();
  };
  undoRoundBtn.onclick = handleUndoLastRound;
  viewSummaryBtn.onclick = () => navigate(`summary/${currentGameId}`);
}

function renderScorecardHeader(players) {
  scorecardHeaderRowEl.innerHTML = "";
  scorecardHeaderRowEl.appendChild(makeCell("th", "Round", "round-col"));
  for (const player of players) {
    const th = makeCell("th", player.name);
    th.title = player.name; // headers ellipsize, so keep the full name reachable
    scorecardHeaderRowEl.appendChild(th);
  }
}

// Shortens a contract like "2 sets of 3" to "2/3" so it fits the round column.
// Contract text is user-editable, so anything that doesn't match returns null
// and the row just shows its number.
function abbreviateContract(text) {
  const match = /^\s*(\d+)\s*sets?\s+of\s+(\d+)\s*$/i.exec(text || "");
  return match ? `${match[1]}/${match[2]}` : null;
}

// The contract names the round, so no number is needed: round 1 of the
// standard set reads "2/3". Contracts that don't fit the "N sets of M" shape
// show their own text; the number is only a fallback for rounds beyond the
// mode's list (older data, or a mode shortened after the fact).
function roundLabel(round) {
  const contract = currentContracts[round - 1];
  return abbreviateContract(contract) || contract || String(round);
}

// True once the game has reached the last round its mode defines.
function isAtFinalRound() {
  return scorecardRoundCount >= currentContracts.length;
}

async function refreshScorecardBody() {
  currentScores = await db.scores.where("gameId").equals(currentGameId).toArray();

  currentPurchaseRows = await db.purchases.where("gameId").equals(currentGameId).toArray();
  currentPurchaseCounts = totalBuysByPlayer(currentPurchaseRows, purchaseLimitOf(currentMode));

  renderScorecardBody(currentPlayers, currentScores);
  renderScorecardPurchases(currentPlayers);
  renderBuysStrip();
  renderScorecardTotals(currentPlayers, currentScores);
  syncPurchasesRowOffset();
  updateScorecardActions();
}

// At the mode's last round the game can't be extended any further, and
// finishing up (View Summary) becomes the highlighted action. Undo stays
// available so a final round reached by accident can still be walked back.
function updateScorecardActions() {
  const finished = isAtFinalRound();

  addRoundBtn.disabled = finished;
  // Only truly nothing to undo when we're down to a single, unscored round.
  undoRoundBtn.disabled = currentScores.length === 0 && scorecardRoundCount <= 1;

  viewSummaryBtn.classList.toggle("btn-primary", finished);
  viewSummaryBtn.classList.toggle("btn-secondary", !finished);
}

function renderScorecardBody(players, scores) {
  const scoreByRoundAndPlayer = new Map(scores.map((s) => [`${s.roundIndex}:${s.playerId}`, s.points]));

  scorecardBodyEl.innerHTML = "";
  for (let round = 1; round <= scorecardRoundCount; round++) {
    const tr = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.className = "round-col";
    // A table cell won't honour a hard width, so the text sits in an inner
    // block that clips it — otherwise a long custom contract name would
    // stretch the frozen column and eat the space this change just freed up.
    labelCell.appendChild(makeCell("span", roundLabel(round), "round-col-text"));
    labelCell.title = currentContracts[round - 1] || `Round ${round}`;
    tr.appendChild(labelCell);
    for (const player of players) {
      const points = scoreByRoundAndPlayer.get(`${round}:${player.id}`);
      const isEmpty = points === undefined;
      const td = makeCell("td", isEmpty ? "–" : String(points), "score-cell");
      if (isEmpty) td.classList.add("is-empty");
      td.dataset.round = String(round);
      tr.appendChild(td);
    }
    scorecardBodyEl.appendChild(tr);
  }
}

// Read-only running total per player. Buys are recorded against the round they
// happened in, from that round's entry sheet, so there's nothing to adjust here.
function renderScorecardPurchases(players) {
  const limit = purchaseLimitOf(currentMode);

  scorecardPurchasesRowEl.innerHTML = "";
  const label = document.createElement("td");
  label.className = "round-col purchases-label";
  label.appendChild(makeCell("span", "Buys"));
  label.appendChild(makeCell("span", "used"));
  scorecardPurchasesRowEl.appendChild(label);

  for (const player of players) {
    const count = currentPurchaseCounts.get(player.id) || 0;
    const td = document.createElement("td");
    td.className = "purchases-cell";
    td.appendChild(makeCell("span", `${count}/${limit}`, "purchase-total"));
    td.setAttribute("aria-label", `${player.name} used ${count} of ${limit} buys`);
    scorecardPurchasesRowEl.appendChild(td);
  }
}

// ---- Live buys for the round in play ----
// The round being played is the first unscored one, so buys logged mid-hand
// land on the right round without anyone having to say which.
function currentPlayRound() {
  const maxScored = currentScores.reduce((max, s) => Math.max(max, s.roundIndex), 0);
  return Math.max(1, Math.min(maxScored + 1, currentContracts.length));
}

function buysRemainingForPlayer(playerId) {
  const used = currentPurchaseRows.filter((row) => row.playerId === playerId).length;
  return purchaseLimitOf(currentMode) - used;
}

function renderBuysStrip() {
  const round = currentPlayRound();
  buysStripTitleEl.textContent = `Round ${round} buys`;

  const rows = currentPurchaseRows.filter((row) => row.roundIndex === round);
  buysStripListEl.innerHTML = "";

  if (rows.length === 0) {
    buysStripListEl.appendChild(makeCell("span", "None yet", "buys-strip-title"));
    return;
  }

  for (const row of rows) {
    const player = currentPlayers.find((p) => p.id === row.playerId);
    if (!player) continue;

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "buy-chip";
    chip.appendChild(makeCell("span", player.name));

    const suit = suitInfo(row.suit);
    const cardEl = makeCell("span", cardLabel(row), "buy-chip-card");
    if (suit && suit.red) cardEl.classList.add("is-red");
    chip.appendChild(cardEl);
    chip.appendChild(makeCell("span", "×", "buy-chip-remove"));

    chip.setAttribute("aria-label", `Remove ${player.name}'s buy, ${cardLabel(row)}`);
    chip.addEventListener("click", () => {
      // confirm() first, synchronously — see the note in handleUndoLastRound.
      if (!confirm(`Remove ${player.name}'s buy (${cardLabel(row)})?`)) return;
      db.purchases.delete(row.id).then(refreshScorecardBody);
    });

    buysStripListEl.appendChild(chip);
  }
}

// The footer has two sticky rows, so the purchases row has to sit exactly one
// totals-row height above the bottom rather than at 0.
function syncPurchasesRowOffset() {
  requestAnimationFrame(() => {
    const totalsHeight = scorecardTotalsRowEl.getBoundingClientRect().height;
    for (const td of scorecardPurchasesRowEl.children) {
      td.style.bottom = `${totalsHeight}px`;
    }
  });
}

function renderScorecardTotals(players, scores) {
  const penalty = penaltyOf(currentMode);
  const totals = players.map(
    (player) =>
      scores.filter((s) => s.playerId === player.id).reduce((sum, s) => sum + s.points, 0) +
      (currentPurchaseCounts.get(player.id) || 0) * penalty
  );
  const lowestTotal = totals.length ? Math.min(...totals) : 0;
  const highestTotal = totals.length ? Math.max(...totals) : 0;
  // Before anyone pulls ahead every player is joint first, which says nothing.
  const ranksMeaningful = lowestTotal !== highestTotal;

  scorecardTotalsRowEl.innerHTML = "";
  scorecardTotalsRowEl.appendChild(makeCell("td", "Total", "round-col"));
  totals.forEach((total) => {
    const td = document.createElement("td");
    td.appendChild(makeCell("span", String(total), "total-value"));

    if (ranksMeaningful) {
      // Competition ranking: a tie shares the place and consumes the next, so
      // two players on the lowest total are both 1st and the next is 3rd.
      const rank = 1 + totals.filter((other) => other < total).length;
      td.appendChild(makeCell("span", ordinal(rank), "rank-badge"));
    }

    if (total === lowestTotal) td.classList.add("leader-total");
    scorecardTotalsRowEl.appendChild(td);
  });
}

function ordinal(n) {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix}`;
}

// Tapping any cell in a round opens the sheet for that whole round, since
// the contract applies to every player at once.
scorecardBodyEl.addEventListener("click", (event) => {
  const cell = event.target.closest(".score-cell");
  if (!cell) return;
  openRoundSheet(Number(cell.dataset.round));
});

function handleUndoLastRound() {
  const maxScoredRound = currentScores.length ? Math.max(...currentScores.map((s) => s.roundIndex)) : 0;

  // Trailing empty rounds come from tapping "Add Round" by mistake. There's
  // nothing to lose, so drop the row straight away without asking.
  if (scorecardRoundCount > maxScoredRound && scorecardRoundCount > 1) {
    scorecardRoundCount--;
    refreshScorecardBody();
    return;
  }

  if (maxScoredRound === 0) return;

  // confirm() must run synchronously off the click, with no prior await —
  // otherwise iOS Safari can silently drop the dialog (the user gesture
  // that authorizes it expires once the code crosses an async boundary).
  const confirmed = confirm(`Undo round ${maxScoredRound}? This clears every player's score for that round.`);
  if (!confirmed) return;

  deleteRound(maxScoredRound);
}

async function deleteRound(lastRound) {
  // Buys belong to the round, so undoing it releases them back to the player.
  await db.scores.where("[gameId+roundIndex]").equals([currentGameId, lastRound]).delete();
  await db.purchases.where("[gameId+roundIndex]").equals([currentGameId, lastRound]).delete();

  if (lastRound === scorecardRoundCount && scorecardRoundCount > 1) {
    scorecardRoundCount--;
  }

  await refreshScorecardBody();
}

// ==================================================
// Buy logging (player, then card)
// ==================================================
const buyOverlayEl = document.getElementById("buy-overlay");
const buySheetEl = document.getElementById("buy-sheet");
const buySheetTitleEl = document.getElementById("buy-sheet-title");
const buySheetStepEl = document.getElementById("buy-sheet-step");
const buyPlayersEl = document.getElementById("buy-players");
const buyCardPickerEl = document.getElementById("buy-card-picker");
const buySuitsEl = document.getElementById("buy-suits");
const buyRanksEl = document.getElementById("buy-ranks");
const buyCloseBtn = document.getElementById("buy-close-btn");
const buyCancelBtn = document.getElementById("buy-cancel-btn");
const buySkipBtn = document.getElementById("buy-skip-btn");

let buyRound = 1;
let buyPlayerId = null;
let buySuit = null;

function openBuyDialog() {
  buyRound = currentPlayRound();
  buyPlayerId = null;
  buySuit = null;
  buySheetTitleEl.textContent = `Add a buy — round ${buyRound}`;
  renderBuyDialog();
  buyOverlayEl.hidden = false;
  buySheetEl.hidden = false;
}

function closeBuyDialog() {
  buyOverlayEl.hidden = true;
  buySheetEl.hidden = true;
}

function renderBuyDialog() {
  buySheetStepEl.textContent = buyPlayerId === null ? "Who bought?" : "Which card?";
  buyCardPickerEl.hidden = buyPlayerId === null;
  buySkipBtn.hidden = buyPlayerId === null;

  buyPlayersEl.innerHTML = "";
  for (const player of currentPlayers) {
    const remaining = buysRemainingForPlayer(player.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "buy-player-btn";
    if (player.id === buyPlayerId) btn.classList.add("is-active");
    btn.textContent = remaining > 0 ? player.name : `${player.name} (none left)`;
    btn.disabled = remaining <= 0;
    btn.addEventListener("click", () => {
      buyPlayerId = player.id;
      renderBuyDialog();
    });
    buyPlayersEl.appendChild(btn);
  }

  buySuitsEl.innerHTML = "";
  for (const suit of CARD_SUITS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "buy-suit-btn";
    if (suit.red) btn.classList.add("is-red");
    if (suit.code === buySuit) btn.classList.add("is-active");
    btn.textContent = suit.symbol;
    btn.setAttribute("aria-label", suit.code);
    btn.addEventListener("click", () => {
      buySuit = suit.code;
      renderBuyDialog();
    });
    buySuitsEl.appendChild(btn);
  }

  // Ranks stay out of reach until a suit is chosen, since picking one commits
  // the buy — three taps total: player, suit, rank.
  buyRanksEl.innerHTML = "";
  for (const rank of CARD_RANKS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "buy-rank-btn";
    btn.textContent = rank;
    btn.disabled = buySuit === null;
    btn.addEventListener("click", () => saveBuy(rank, buySuit));
    buyRanksEl.appendChild(btn);
  }
}

async function saveBuy(rank, suit) {
  if (buyPlayerId === null) return;

  await db.purchases.add({
    gameId: currentGameId,
    roundIndex: buyRound,
    playerId: buyPlayerId,
    rank: rank || null,
    suit: suit || null,
  });

  // Make sure the round being played is actually on the card.
  scorecardRoundCount = Math.max(scorecardRoundCount, buyRound);

  closeBuyDialog();
  await refreshScorecardBody();
}

logBuyBtn.addEventListener("click", openBuyDialog);
buyCloseBtn.addEventListener("click", closeBuyDialog);
buyCancelBtn.addEventListener("click", closeBuyDialog);
buyOverlayEl.addEventListener("click", closeBuyDialog);
buySkipBtn.addEventListener("click", () => saveBuy(null, null));

// ==================================================
// Round score entry sheet
// ==================================================
const sheetOverlayEl = document.getElementById("sheet-overlay");
const scoreSheetEl = document.getElementById("score-sheet");
const sheetRoundTitleEl = document.getElementById("sheet-round-title");
const sheetContractEl = document.getElementById("sheet-contract");
const sheetPlayersEl = document.getElementById("sheet-players");
const sheetCloseBtn = document.getElementById("sheet-close-btn");
const sheetCancelBtn = document.getElementById("sheet-cancel-btn");
const sheetSaveBtn = document.getElementById("sheet-save-btn");
const sheetKeypadEl = document.getElementById("sheet-keypad");
const sheetWentOutBtn = document.getElementById("sheet-wentout-btn");

let sheetRound = null;
let sheetEntries = [];
let sheetBuyRows = [];
let sheetActiveIndex = 0;

async function openRoundSheet(round) {
  sheetRound = round;
  sheetRoundTitleEl.textContent = `Round ${round}`;
  sheetContractEl.textContent = currentContracts[(round - 1) % currentContracts.length];

  const scores = await db.scores.where("[gameId+roundIndex]").equals([currentGameId, round]).toArray();
  const pointsByPlayerId = new Map(scores.map((s) => [s.playerId, s.points]));

  // Digits are held as strings so a half-typed "1" is distinguishable from a
  // deliberate 0, and so backspace behaves the way it looks.
  sheetEntries = currentPlayers.map((player) => {
    const existing = pointsByPlayerId.get(player.id);
    return existing !== undefined ? String(existing) : "";
  });

  // Buys are logged live from the scorecard, so here they're only shown —
  // each player's cards for this round, alongside their score.
  sheetBuyRows = currentPlayers.map((player) =>
    currentPurchaseRows.filter((row) => row.roundIndex === round && row.playerId === player.id)
  );

  sheetActiveIndex = 0;
  renderSheetPlayers();

  sheetOverlayEl.hidden = false;
  scoreSheetEl.hidden = false;
}

function renderSheetPlayers() {
  sheetPlayersEl.innerHTML = "";

  currentPlayers.forEach((player, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "sheet-player-row";
    if (index === sheetActiveIndex) row.classList.add("is-active");

    const value = sheetEntries[index];
    const buyRows = sheetBuyRows[index] || [];

    const nameWrap = document.createElement("span");
    nameWrap.className = "sheet-player-name";
    nameWrap.appendChild(makeCell("span", player.name));
    if (buyRows.length) {
      const cards = buyRows.map((r) => cardLabel(r)).join(" ");
      nameWrap.appendChild(makeCell("span", cards, "sheet-player-buys"));
    }
    row.appendChild(nameWrap);

    const valueEl = makeCell("span", value === "" ? "–" : value, "sheet-score-value");
    if (value === "") valueEl.classList.add("is-empty");
    row.appendChild(valueEl);

    row.setAttribute(
      "aria-label",
      `${player.name}, ${value === "" ? "no score yet" : value}${
        buyRows.length ? `, ${buyRows.length} buys this round` : ""
      }`
    );
    row.addEventListener("click", () => {
      sheetActiveIndex = index;
      renderSheetPlayers();
    });

    sheetPlayersEl.appendChild(row);
  });

  keepActiveRowVisible();
}

// With a full table the list scrolls, so advancing could otherwise move the
// active player out of sight. Scrolls the container directly rather than using
// scrollIntoView, which would also move the page behind the sheet.
function keepActiveRowVisible() {
  const row = sheetPlayersEl.children[sheetActiveIndex];
  if (!row) return;

  // Measured with rects so it doesn't depend on which ancestor happens to be
  // positioned.
  const list = sheetPlayersEl.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (rowRect.top < list.top) {
    sheetPlayersEl.scrollTop -= list.top - rowRect.top;
  } else if (rowRect.bottom > list.bottom) {
    sheetPlayersEl.scrollTop += rowRect.bottom - list.bottom;
  }
}

function advanceSheetPlayer() {
  sheetActiveIndex = (sheetActiveIndex + 1) % currentPlayers.length;
}

function pressKeypad(key) {
  const current = sheetEntries[sheetActiveIndex];

  if (key === "next") {
    advanceSheetPlayer();
  } else if (key === "backspace") {
    sheetEntries[sheetActiveIndex] = current.slice(0, -1);
  } else {
    // Keep a lone leading zero from turning into "05".
    const base = current === "0" ? "" : current;
    if (base.length >= 4) return;
    sheetEntries[sheetActiveIndex] = base + key;
  }

  renderSheetPlayers();
}

sheetKeypadEl.addEventListener("click", (event) => {
  const btn = event.target.closest(".keypad-btn");
  if (btn) pressKeypad(btn.dataset.key);
});

// Exactly one player goes out each round and scores nothing, so this is the
// single most common entry.
sheetWentOutBtn.addEventListener("click", () => {
  sheetEntries[sheetActiveIndex] = "0";
  advanceSheetPlayer();
  renderSheetPlayers();
});

function closeSheet() {
  sheetOverlayEl.hidden = true;
  scoreSheetEl.hidden = true;
  sheetRound = null;
}

sheetCloseBtn.addEventListener("click", closeSheet);
sheetCancelBtn.addEventListener("click", closeSheet);
sheetOverlayEl.addEventListener("click", closeSheet);

sheetSaveBtn.addEventListener("click", () => {
  const round = sheetRound;
  const points = sheetEntries.map((value) => Math.max(0, parseInt(value, 10) || 0));

  // Someone has to go out, so a round with no zero is nearly always a typo.
  // confirm() runs before any await — see the note in handleUndoLastRound.
  if (!points.some((p) => p === 0)) {
    if (!confirm("No one scored 0 this round. Usually the player who goes out does. Save anyway?")) return;
  }

  saveRoundScores(round, points);
});

// Buys aren't touched here — they're logged live from the scorecard as they
// happen, so scoring only writes the round's points.
async function saveRoundScores(round, points) {
  await db.transaction("rw", db.scores, async () => {
    for (let i = 0; i < currentPlayers.length; i++) {
      const playerId = currentPlayers[i].id;
      const existingScore = await db.scores
        .where("[gameId+roundIndex+playerId]")
        .equals([currentGameId, round, playerId])
        .first();
      if (existingScore) {
        await db.scores.update(existingScore.id, { points: points[i] });
      } else {
        await db.scores.add({ gameId: currentGameId, roundIndex: round, playerId, points: points[i] });
      }
    }
  });

  closeSheet();
  await refreshScorecardBody();
}

// ==================================================
// Screen 4: game summary (standings + cumulative chart)
// ==================================================
const summaryTitleEl = document.getElementById("summary-title");
const summaryBackBtn = document.getElementById("summary-back-btn");
const summaryHomeBtn = document.getElementById("summary-home-btn");
const standingsListEl = document.getElementById("standings-list");
const chartContainerEl = document.getElementById("chart-container");
const chartLegendEl = document.getElementById("chart-legend");
const chartRawToggleEl = document.getElementById("chart-raw-toggle");
const toggleCompleteBtn = document.getElementById("toggle-complete-btn");
const summaryNewGameBtn = document.getElementById("summary-new-game-btn");
const shareSummaryBtn = document.getElementById("share-summary-btn");
const shareStatusEl = document.getElementById("share-status");
const shareFallbackEl = document.getElementById("share-fallback");

let summaryData = null;

const CHART_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#9a6324"];

async function enterSummaryScreen(gameId) {
  const game = await db.games.get(gameId);
  if (!game) {
    navigate("games");
    return;
  }

  showScreen("summary-screen");
  const players = await Promise.all(game.playerIds.map((id) => db.players.get(id)));
  const scores = await db.scores.where("gameId").equals(gameId).toArray();
  const mode = await getModeForGame(game);
  const purchaseRows = await db.purchases.where("gameId").equals(gameId).toArray();
  const purchasePoints = buysToPoints(
    totalBuysByPlayer(purchaseRows, purchaseLimitOf(mode)),
    penaltyOf(mode)
  );

  summaryTitleEl.textContent = game.name;
  renderStandings(players, scores, purchasePoints);
  // Buys now belong to a round, so they show up as part of that round's climb
  // rather than a jump at the end.
  prepareCumulativeChart(players, scores, purchaseRows, mode);
  toggleCompleteBtn.textContent = game.isComplete ? "Reopen Game" : "Mark Game Complete";

  summaryData = { game, players, scores, purchaseRows, mode, purchasePoints };
  shareStatusEl.hidden = true;
  shareFallbackEl.hidden = true;

  summaryBackBtn.onclick = () => navigate(`scorecard/${gameId}`);
  // The house icon means the same thing everywhere it appears: back to the top.
  summaryHomeBtn.onclick = () => navigate("home");
  toggleCompleteBtn.onclick = async () => {
    await db.games.update(gameId, { isComplete: !game.isComplete });
    await enterSummaryScreen(gameId);
  };

  summaryNewGameBtn.onclick = () => {
    // Already finished? Nothing to ask about — just start the next game.
    if (game.isComplete) {
      navigate("new-game");
      return;
    }
    // confirm() first, synchronously — see the note in handleUndoLastRound.
    if (!confirm("Mark current game as complete?")) return;
    db.games.update(gameId, { isComplete: true }).then(() => navigate("new-game"));
  };
}

// ---- Share ----
const MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" };

// Laid out line by line rather than as a grid: chat apps use proportional
// fonts, so anything relying on aligned columns arrives looking broken.
function buildSummaryText(data) {
  const { game, players, scores, purchaseRows, mode, purchasePoints } = data;
  const contracts = (mode && mode.contracts) || DEFAULT_CONTRACTS;
  const roundsPlayed = scores.reduce((max, s) => Math.max(max, s.roundIndex), 0);

  const lines = [game.name];

  const date = new Date(game.createdAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  // Say what was actually played, not just what the mode allows — a game
  // finished early would otherwise claim its full round count.
  const roundsLabel =
    roundsPlayed === contracts.length ? `${contracts.length} rounds` : `${roundsPlayed} of ${contracts.length} rounds`;
  lines.push(`${date} · ${mode ? mode.name : "Standard"} · ${roundsLabel}`);
  if (!game.isComplete) {
    lines.push(`In progress · round ${Math.min(roundsPlayed + 1, contracts.length)} of ${contracts.length}`);
  }
  lines.push("");

  const standings = computeStandings(players, scores, purchasePoints);
  standings.forEach((entry, index) => {
    // Competition ranking, so tied players share a place and a medal.
    const rank = 1 + standings.filter((other) => other.total < entry.total).length;
    const marker = MEDALS[rank] || `${rank}.`;
    const buyPoints = (purchasePoints && purchasePoints.get(entry.player.id)) || 0;
    // Only worth splitting out for players who actually bought.
    const detail = buyPoints ? ` (rounds ${entry.total - buyPoints} · buys ${buyPoints})` : "";
    lines.push(`${marker} ${entry.player.name} — ${entry.total}${detail}`);
  });

  const buysByRoundAndPlayer = new Map();
  for (const row of purchaseRows) {
    const key = `${row.roundIndex}:${row.playerId}`;
    buysByRoundAndPlayer.set(key, (buysByRoundAndPlayer.get(key) || 0) + 1);
  }

  for (let round = 1; round <= roundsPlayed; round++) {
    lines.push("");
    lines.push(`Round ${round} — ${contracts[round - 1] || `Round ${round}`}`);
    lines.push(
      players
        .map((player) => {
          const score = scores.find((s) => s.roundIndex === round && s.playerId === player.id);
          const buys = buysByRoundAndPlayer.get(`${round}:${player.id}`) || 0;
          const buyNote = buys ? ` (+${buys} buy${buys === 1 ? "" : "s"})` : "";
          return `${player.name} ${score ? score.points : 0}${buyNote}`;
        })
        .join(" · ")
    );
  }

  lines.push("");
  lines.push(location.origin + location.pathname.replace(/index\.html$/, ""));

  return lines.join("\n");
}

// Last-resort copy for browsers without the async clipboard API.
function legacyCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (err) {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

shareSummaryBtn.addEventListener("click", async () => {
  if (!summaryData) return;
  const text = buildSummaryText(summaryData);

  if (navigator.share) {
    try {
      await navigator.share({ text });
      shareStatusEl.hidden = true;
      return;
    } catch (err) {
      // Dismissing the share sheet isn't a failure worth reporting.
      if (err.name === "AbortError") return;
    }
  }

  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      copied = false;
    }
  }
  if (!copied) copied = legacyCopy(text);

  if (copied) {
    shareStatusEl.textContent = "Summary copied — paste it wherever you like.";
    shareFallbackEl.hidden = true;
  } else {
    // Never leave the text unreachable: show it so it can be selected by hand.
    shareStatusEl.textContent = "Couldn't copy automatically — select the text below.";
    shareFallbackEl.value = text;
    shareFallbackEl.hidden = false;
    shareFallbackEl.focus();
    shareFallbackEl.select();
  }
  shareStatusEl.hidden = false;
});

function renderStandings(players, scores, purchasePoints) {
  const standings = computeStandings(players, scores, purchasePoints);
  // Only worth breaking the total apart when buys actually contributed.
  const anyBuys = standings.some((entry) => (purchasePoints && purchasePoints.get(entry.player.id)) || 0);

  standingsListEl.innerHTML = "";
  standings.forEach((entry, index) => {
    const li = document.createElement("li");
    li.className = "standing-row";
    if (index === 0) li.classList.add("is-winner");

    li.appendChild(makeCell("span", `${index + 1}.`, "standing-rank"));

    const nameWrap = document.createElement("div");
    nameWrap.className = "standing-name";
    nameWrap.appendChild(makeCell("span", entry.player.name));
    if (anyBuys) {
      const buyPoints = (purchasePoints && purchasePoints.get(entry.player.id)) || 0;
      const roundPoints = entry.total - buyPoints;
      nameWrap.appendChild(makeCell("span", `rounds ${roundPoints} · buys ${buyPoints}`, "standing-breakdown"));
    }
    li.appendChild(nameWrap);

    li.appendChild(makeCell("span", String(entry.total), "standing-total"));
    standingsListEl.appendChild(li);
  });
}

// The chart is redrawn when the raw-score toggle flips, so its inputs are kept.
let chartData = null;
let chartShowRaw = false;

function prepareCumulativeChart(players, scores, purchaseRows, mode) {
  const roundCount = scores.reduce((max, s) => Math.max(max, s.roundIndex), 0);
  const penalty = penaltyOf(mode);

  const buysByRoundAndPlayer = new Map();
  for (const row of purchaseRows) {
    const key = `${row.roundIndex}:${row.playerId}`;
    buysByRoundAndPlayer.set(key, (buysByRoundAndPlayer.get(key) || 0) + 1);
  }

  // Two running totals per player: one counting buy penalties in the round
  // they were made, one of round scores alone.
  const series = players.map((player) => {
    let withBuys = 0;
    let rawOnly = 0;
    const total = [];
    const raw = [];
    for (let round = 1; round <= roundCount; round++) {
      const score = scores.find((s) => s.roundIndex === round && s.playerId === player.id);
      const points = score ? score.points : 0;
      const buyPoints = (buysByRoundAndPlayer.get(`${round}:${player.id}`) || 0) * penalty;
      rawOnly += points;
      withBuys += points + buyPoints;
      total.push(withBuys);
      raw.push(rawOnly);
    }
    return { total, raw };
  });

  const hasBuys = series.some((s) => s.total[s.total.length - 1] !== s.raw[s.raw.length - 1]);
  chartData = { players, series, roundCount, hasBuys };

  chartRawToggleEl.hidden = !hasBuys;
  drawCumulativeChart();
}

function drawCumulativeChart() {
  chartLegendEl.innerHTML = "";
  if (!chartData || chartData.roundCount === 0) {
    chartContainerEl.innerHTML = '<p class="empty-state">No rounds scored yet</p>';
    chartRawToggleEl.hidden = true;
    return;
  }

  const { players, series, roundCount, hasBuys } = chartData;
  const showRaw = hasBuys && chartShowRaw;
  chartRawToggleEl.textContent = showRaw ? "Hide scores without buys" : "Show scores without buys";

  const maxValue = Math.max(1, ...series.flatMap((s) => s.total));
  const width = 320;
  const height = 220;
  const paddingLeft = 34;
  const paddingRight = 10;
  const paddingTop = 10;
  const paddingBottom = 30; // room for the round labels
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  // A single round has no span to spread across, so it sits at the left edge.
  const xFor = (round) => paddingLeft + (roundCount === 1 ? 0 : ((round - 1) / (roundCount - 1)) * plotWidth);
  const yFor = (value) => paddingTop + plotHeight - (value / maxValue) * plotHeight;
  const baseline = yFor(0);

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;

  // Axes
  svg += `<line x1="${paddingLeft}" y1="${baseline}" x2="${width - paddingRight}" y2="${baseline}" style="stroke: var(--border)" stroke-width="1" />`;
  svg += `<text x="2" y="${baseline + 4}" font-size="10" style="fill: var(--muted)">0</text>`;
  svg += `<text x="2" y="${yFor(maxValue) + 4}" font-size="10" style="fill: var(--muted)">${maxValue}</text>`;

  // Round ticks and labels along the bottom
  for (let round = 1; round <= roundCount; round++) {
    const x = xFor(round);
    svg += `<line x1="${x}" y1="${baseline}" x2="${x}" y2="${baseline + 4}" style="stroke: var(--border)" stroke-width="1" />`;
    svg += `<text x="${x}" y="${baseline + 16}" font-size="9" text-anchor="middle" style="fill: var(--muted)">${round}</text>`;
  }
  svg += `<text x="${paddingLeft + plotWidth / 2}" y="${height - 2}" font-size="9" text-anchor="middle" style="fill: var(--muted)">Round</text>`;

  players.forEach((player, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const { total, raw } = series[i];

    if (showRaw) {
      const rawPoints = raw.map((value, idx) => `${xFor(idx + 1)},${yFor(value)}`).join(" ");
      svg += `<polyline points="${rawPoints}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round" opacity="0.75" />`;
    }

    const totalPoints = total.map((value, idx) => `${xFor(idx + 1)},${yFor(value)}`).join(" ");
    svg += `<polyline points="${totalPoints}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;

    // A marker at each round makes overlapping lines easier to separate.
    total.forEach((value, idx) => {
      svg += `<circle cx="${xFor(idx + 1)}" cy="${yFor(value)}" r="3" fill="${color}" />`;
    });
  });

  svg += "</svg>";
  chartContainerEl.innerHTML = svg;

  players.forEach((player, i) => {
    const item = document.createElement("div");
    item.className = "chart-legend-item";

    const swatch = document.createElement("span");
    swatch.className = "chart-legend-swatch";
    swatch.style.background = CHART_COLORS[i % CHART_COLORS.length];

    item.appendChild(swatch);
    item.appendChild(makeCell("span", player.name));
    chartLegendEl.appendChild(item);
  });
}

chartRawToggleEl.addEventListener("click", () => {
  chartShowRaw = !chartShowRaw;
  drawCumulativeChart();
});

// ==================================================
// Screen 5: settings (players, contract sets, data)
// ==================================================
const settingsPlayersListEl = document.getElementById("settings-players-list");
const settingsContractSetsListEl = document.getElementById("settings-contract-sets-list");
const newContractSetBtn = document.getElementById("new-contract-set-btn");
const exportDataBtn = document.getElementById("export-data-btn");
const importDataInput = document.getElementById("import-data-input");
const dataStatusEl = document.getElementById("data-status");
const toggleHiddenPlayersBtn = document.getElementById("toggle-hidden-players-btn");
const storageStatusEl = document.getElementById("storage-status");
const requestPersistBtn = document.getElementById("request-persist-btn");
const versionInfoEl = document.getElementById("version-info");
const versionNoteEl = document.getElementById("version-note");
const backupStatusEl = document.getElementById("backup-status");
const backupNudgeEl = document.getElementById("backup-nudge");
const backupNudgeTextEl = document.getElementById("backup-nudge-text");
const backupNudgeExportBtn = document.getElementById("backup-nudge-export-btn");
const backupNudgeDismissBtn = document.getElementById("backup-nudge-dismiss-btn");

document.getElementById("settings-back-btn").addEventListener("click", () => navigate("games"));
document.getElementById("stats-nav-btn").addEventListener("click", () => navigate("stats"));

async function enterSettingsScreen() {
  showScreen("settings-screen");
  dataStatusEl.hidden = true;
  await renderSettingsPlayers();
  await renderSettingsContractSets();
  await renderStorageStatus();
  renderBackupStatus();
  await renderVersionInfo();
}

// ---- Version ----
// Reads the live cache name rather than asking the worker, so it reports what
// is actually installed on this device.
async function activeCacheVersion() {
  if (!window.caches) return null;
  try {
    const names = await caches.keys();
    for (const name of names) {
      const match = /^scorepad-cache-v(.+)$/.exec(name);
      if (match) return match[1];
    }
  } catch (err) {
    /* fall through */
  }
  return null;
}

async function renderVersionInfo() {
  const cached = await activeCacheVersion();

  if (cached && cached !== APP_VERSION) {
    versionInfoEl.textContent = `Version ${APP_VERSION} · offline copy v${cached}`;
    versionNoteEl.textContent = "An update is ready. Fully close the app and reopen it to finish.";
    versionNoteEl.hidden = false;
    return;
  }

  versionInfoEl.textContent = cached ? `Version ${APP_VERSION} · saved for offline use` : `Version ${APP_VERSION}`;
  versionNoteEl.hidden = true;
}

// ---- Persistent storage ----
// Games live in the browser's own storage, which the OS may clear when space
// runs low or the app sits unused for a long time. Asking for persistence
// marks the data as worth keeping. It's a request, not a guarantee — which is
// why Settings shows the current state and why Export Data is still the real
// backup.
async function ensurePersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return null;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (err) {
    return null;
  }
}

async function renderStorageStatus() {
  if (!navigator.storage || !navigator.storage.persisted) {
    storageStatusEl.textContent =
      "This browser can't protect saved games from being cleared automatically. Export regularly to keep a copy.";
    requestPersistBtn.hidden = true;
    return;
  }

  let persisted = false;
  try {
    persisted = await navigator.storage.persisted();
  } catch (err) {
    persisted = false;
  }

  storageStatusEl.textContent = persisted
    ? "Saved games are protected from automatic cleanup on this device."
    : "Saved games could be cleared if this device runs low on storage, or the app goes unused for a long time.";
  requestPersistBtn.hidden = persisted;
}

requestPersistBtn.addEventListener("click", async () => {
  const granted = await ensurePersistentStorage();
  await renderStorageStatus();
  if (granted === false) {
    storageStatusEl.textContent =
      "This device declined to protect saved games. Export regularly to keep a copy.";
  }
});

// ---- Backup reminders ----
// Kept in localStorage rather than the database: this records what *this
// device* has backed up, so it shouldn't travel inside an export. If the data
// is ever wiped, the counter goes with it, which is the right behaviour.
const BACKUP_BASELINE_KEY = "scorepad-backup-baseline";
const BACKUP_LAST_AT_KEY = "scorepad-backup-last-at";
const BACKUP_REMIND_AFTER = 5;

function readBackupBaseline() {
  const raw = Number(localStorage.getItem(BACKUP_BASELINE_KEY));
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

// Called on export, and on "Later" — dismissing simply defers the next nudge
// by another BACKUP_REMIND_AFTER games.
function markBackedUp(gameCount, exported = true) {
  localStorage.setItem(BACKUP_BASELINE_KEY, String(gameCount));
  if (exported) localStorage.setItem(BACKUP_LAST_AT_KEY, new Date().toISOString());
}

async function renderBackupNudge() {
  const gameCount = await db.games.count();
  const unbacked = gameCount - readBackupBaseline();

  if (unbacked < BACKUP_REMIND_AFTER) {
    backupNudgeEl.hidden = true;
    return;
  }

  const everExported = !!localStorage.getItem(BACKUP_LAST_AT_KEY);
  backupNudgeTextEl.textContent = everExported
    ? `${unbacked} games since your last backup. They exist only on this device.`
    : `${gameCount} games saved and never backed up. They exist only on this device.`;
  backupNudgeEl.hidden = false;
}

backupNudgeExportBtn.addEventListener("click", async () => {
  await exportAllData();
  await renderBackupNudge();
});

backupNudgeDismissBtn.addEventListener("click", async () => {
  markBackedUp(await db.games.count(), false);
  await renderBackupNudge();
});

function renderBackupStatus() {
  const lastAt = localStorage.getItem(BACKUP_LAST_AT_KEY);
  backupStatusEl.textContent = lastAt
    ? `Last backup: ${new Date(lastAt).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })}`
    : "Last backup: never";
}

// Players are never deleted — hiding keeps their past games and stats intact
// while taking them out of the list and the name suggestions.
let showHiddenPlayers = false;

async function renderSettingsPlayers() {
  const allPlayers = await db.players.orderBy("name").toArray();
  const hiddenCount = allPlayers.filter((p) => p.hidden).length;
  const players = showHiddenPlayers ? allPlayers : allPlayers.filter((p) => !p.hidden);

  toggleHiddenPlayersBtn.hidden = hiddenCount === 0;
  toggleHiddenPlayersBtn.textContent = showHiddenPlayers ? "Hide hidden" : `Show hidden (${hiddenCount})`;

  settingsPlayersListEl.innerHTML = "";
  if (players.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = allPlayers.length ? "All players are hidden" : "No players yet";
    settingsPlayersListEl.appendChild(empty);
    return;
  }

  for (const player of players) {
    const row = document.createElement("div");
    row.className = "settings-row";
    if (player.hidden) row.classList.add("is-hidden");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "player-name-input";
    input.value = player.name;
    input.addEventListener("change", async () => {
      const newName = input.value.trim();
      if (newName) {
        await db.players.update(player.id, { name: newName });
      } else {
        input.value = player.name;
      }
    });

    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "settings-row-action";
    actionBtn.textContent = player.hidden ? "Unhide" : "Hide";
    actionBtn.setAttribute("aria-label", `${player.hidden ? "Unhide" : "Hide"} ${player.name}`);
    actionBtn.addEventListener("click", async () => {
      await db.players.update(player.id, { hidden: !player.hidden });
      await renderSettingsPlayers();
    });

    row.appendChild(input);
    row.appendChild(actionBtn);
    settingsPlayersListEl.appendChild(row);
  }
}

toggleHiddenPlayersBtn.addEventListener("click", () => {
  showHiddenPlayers = !showHiddenPlayers;
  renderSettingsPlayers();
});

async function renderSettingsContractSets() {
  const contractSets = await db.contractSets.toArray();
  settingsContractSetsListEl.innerHTML = "";

  for (const set of contractSets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "contract-set-item";
    btn.textContent = set.name;
    btn.appendChild(makeCell("span", `${set.contracts.length} round${set.contracts.length === 1 ? "" : "s"}`));
    btn.addEventListener("click", () => navigate(`contract-set/${set.id}`));
    settingsContractSetsListEl.appendChild(btn);
  }
}

newContractSetBtn.addEventListener("click", async () => {
  const id = await db.contractSets.add({
    name: "New Mode",
    contracts: ["Round 1"],
    purchasesPerPlayer: DEFAULT_PURCHASES_PER_PLAYER,
    penaltyPerPurchase: DEFAULT_PENALTY_PER_PURCHASE,
  });
  navigate(`contract-set/${id}`);
});

// ==================================================
// Screen 7: player stats
// ==================================================
const statsListEl = document.getElementById("stats-list");

document.getElementById("stats-back-btn").addEventListener("click", () => navigate("settings"));

async function enterStatsScreen() {
  showScreen("stats-screen");
  const stats = await computePlayerStats();
  renderPlayerStats(stats);
}

// Walks every game once, in memory, rather than querying per game.
async function computePlayerStats() {
  const [games, players, allScores, allPurchases, modes] = await Promise.all([
    db.games.toArray(),
    db.players.toArray(),
    db.scores.toArray(),
    db.purchases.toArray(),
    db.contractSets.toArray(),
  ]);

  const playerById = new Map(players.map((p) => [p.id, p]));
  const modeById = new Map(modes.map((m) => [m.id, m]));
  const fallbackMode = modes[0];

  const scoresByGame = new Map();
  for (const score of allScores) {
    if (!scoresByGame.has(score.gameId)) scoresByGame.set(score.gameId, []);
    scoresByGame.get(score.gameId).push(score);
  }
  const purchasesByGame = new Map();
  for (const row of allPurchases) {
    if (!purchasesByGame.has(row.gameId)) purchasesByGame.set(row.gameId, []);
    purchasesByGame.get(row.gameId).push(row);
  }

  const statByPlayerId = new Map();
  const statFor = (playerId) => {
    if (!statByPlayerId.has(playerId)) {
      statByPlayerId.set(playerId, { player: playerById.get(playerId), played: 0, wins: 0, totalScore: 0, best: null, buys: 0 });
    }
    return statByPlayerId.get(playerId);
  };

  for (const game of games) {
    const gameScores = scoresByGame.get(game.id) || [];
    if (gameScores.length === 0) continue; // nothing was ever played

    const mode = modeById.get(game.contractSetId) || fallbackMode;
    const contracts = (mode && mode.contracts) || DEFAULT_CONTRACTS;
    const maxRound = gameScores.reduce((max, s) => Math.max(max, s.roundIndex), 0);

    // Counted when explicitly finished, or when it played out its full round list.
    if (!game.isComplete && maxRound < contracts.length) continue;

    const buysByPlayerId = totalBuysByPlayer(purchasesByGame.get(game.id) || [], purchaseLimitOf(mode));
    const purchasePoints = buysToPoints(buysByPlayerId, penaltyOf(mode));

    const gamePlayers = game.playerIds.map((id) => playerById.get(id)).filter(Boolean);
    if (gamePlayers.length === 0) continue;

    const standings = computeStandings(gamePlayers, gameScores, purchasePoints);
    const lowest = standings[0].total;

    for (const entry of standings) {
      const stat = statFor(entry.player.id);
      stat.played++;
      if (entry.total === lowest) stat.wins++; // ties all count as a win
      stat.totalScore += entry.total;
      stat.best = stat.best === null ? entry.total : Math.min(stat.best, entry.total);
      stat.buys += buysByPlayerId.get(entry.player.id) || 0;
    }
  }

  return [...statByPlayerId.values()]
    .filter((stat) => stat.player && !stat.player.hidden)
    .sort((a, b) => b.wins - a.wins || b.wins / b.played - a.wins / a.played || a.totalScore / a.played - b.totalScore / b.played);
}

function renderPlayerStats(stats) {
  statsListEl.innerHTML = "";

  if (stats.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No finished games yet";
    statsListEl.appendChild(empty);
    return;
  }

  for (const stat of stats) {
    const card = document.createElement("div");
    card.className = "stat-card";

    card.appendChild(makeCell("div", stat.player.name, "stat-name"));

    const winRate = Math.round((stat.wins / stat.played) * 100);
    card.appendChild(
      makeCell("span", `Played ${stat.played} · Won ${stat.wins} (${winRate}%)`, "stat-line")
    );

    const avgScore = Math.round(stat.totalScore / stat.played);
    const avgBuys = (stat.buys / stat.played).toFixed(1);
    card.appendChild(
      makeCell("span", `Avg score ${avgScore} · Best ${stat.best} · Avg buys ${avgBuys}`, "stat-line")
    );

    statsListEl.appendChild(card);
  }
}

async function exportAllData() {
  const [games, players, scores, contractSets, purchases] = await Promise.all([
    db.games.toArray(),
    db.players.toArray(),
    db.scores.toArray(),
    db.contractSets.toArray(),
    db.purchases.toArray(),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 2,
    games,
    players,
    scores,
    contractSets,
    purchases,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `scorepad-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  markBackedUp(games.length);
}

exportDataBtn.addEventListener("click", async () => {
  await exportAllData();
  renderBackupStatus();
});

importDataInput.addEventListener("change", async () => {
  const file = importDataInput.files[0];
  if (!file) return;

  // confirm() runs first, synchronously, before any await — see the note in
  // handleUndoLastRound about async gaps breaking the dialog on iOS.
  const confirmed = confirm(
    "Importing will replace all games, players, and modes currently saved in this browser. Continue?"
  );
  if (!confirmed) {
    importDataInput.value = "";
    return;
  }

  try {
    const payload = JSON.parse(await file.text());
    const hasAllTables = ["games", "players", "scores", "contractSets"].every((key) => Array.isArray(payload[key]));
    if (!hasAllTables) {
      throw new Error("This file doesn't look like a ScorePad export.");
    }

    // Older backups need the same normalising the on-device upgrades applied:
    // no purchases at all, or buys held as a count with no round and no card.
    // Their own ids are dropped since nothing references them.
    const purchases = [];
    for (const row of Array.isArray(payload.purchases) ? payload.purchases : []) {
      const roundIndex = row.roundIndex === undefined ? 1 : row.roundIndex;
      if (row.count === undefined) {
        purchases.push({
          gameId: row.gameId,
          roundIndex,
          playerId: row.playerId,
          rank: row.rank === undefined ? null : row.rank,
          suit: row.suit === undefined ? null : row.suit,
        });
      } else {
        for (let i = 0; i < row.count; i++) {
          purchases.push({ gameId: row.gameId, roundIndex, playerId: row.playerId, rank: null, suit: null });
        }
      }
    }

    await db.transaction("rw", db.games, db.players, db.scores, db.contractSets, db.purchases, async () => {
      await Promise.all([
        db.games.clear(),
        db.players.clear(),
        db.scores.clear(),
        db.contractSets.clear(),
        db.purchases.clear(),
      ]);
      await Promise.all([
        db.games.bulkAdd(payload.games),
        db.players.bulkAdd(payload.players),
        db.scores.bulkAdd(payload.scores),
        db.contractSets.bulkAdd(payload.contractSets),
        db.purchases.bulkAdd(purchases),
      ]);
    });
    await ensureDefaultContractSet();

    // Restoring proves a backup file exists, so don't nag about the games it
    // just brought in.
    markBackedUp(payload.games.length);

    dataStatusEl.textContent = "Import complete.";
    dataStatusEl.hidden = false;
    await renderSettingsPlayers();
    await renderSettingsContractSets();
    renderBackupStatus();
  } catch (err) {
    dataStatusEl.textContent = `Import failed: ${err.message}`;
    dataStatusEl.hidden = false;
  } finally {
    importDataInput.value = "";
  }
});

// ==================================================
// Screen 6: edit one mode
// ==================================================
const contractSetNameInput = document.getElementById("contract-set-name-input");
const contractRoundsListEl = document.getElementById("contract-rounds-list");
const addContractRoundBtn = document.getElementById("add-contract-round-btn");
const saveContractSetBtn = document.getElementById("save-contract-set-btn");
const deleteContractSetBtn = document.getElementById("delete-contract-set-btn");
const purchasesPerPlayerInput = document.getElementById("purchases-per-player-input");
const penaltyPerPurchaseInput = document.getElementById("penalty-per-purchase-input");

document.getElementById("contract-set-back-btn").addEventListener("click", () => navigate("settings"));

let editingContractSetId = null;
let editingRounds = [];
let editingContractSetCount = 0;

async function enterContractSetScreen(id) {
  const set = await db.contractSets.get(id);
  if (!set) {
    navigate("settings");
    return;
  }

  showScreen("contract-set-screen");
  editingContractSetId = id;
  editingRounds = set.contracts.slice();
  editingContractSetCount = await db.contractSets.count();
  contractSetNameInput.value = set.name;
  purchasesPerPlayerInput.value = String(purchaseLimitOf(set));
  penaltyPerPurchaseInput.value = String(penaltyOf(set));
  renderContractRounds();
}

function renderContractRounds() {
  contractRoundsListEl.innerHTML = "";

  editingRounds.forEach((text, index) => {
    const row = document.createElement("div");
    row.className = "contract-round-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "player-name-input";
    input.value = text;
    input.addEventListener("input", () => {
      editingRounds[index] = input.value;
    });

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "contract-round-reorder";
    upBtn.textContent = "▲";
    upBtn.setAttribute("aria-label", "Move round up");
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => {
      [editingRounds[index - 1], editingRounds[index]] = [editingRounds[index], editingRounds[index - 1]];
      renderContractRounds();
    });

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "contract-round-reorder";
    downBtn.textContent = "▼";
    downBtn.setAttribute("aria-label", "Move round down");
    downBtn.disabled = index === editingRounds.length - 1;
    downBtn.addEventListener("click", () => {
      [editingRounds[index + 1], editingRounds[index]] = [editingRounds[index], editingRounds[index + 1]];
      renderContractRounds();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "contract-round-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", "Remove round");
    removeBtn.disabled = editingRounds.length <= 1;
    removeBtn.addEventListener("click", () => {
      editingRounds.splice(index, 1);
      renderContractRounds();
    });

    row.appendChild(input);
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(removeBtn);
    contractRoundsListEl.appendChild(row);
  });
}

addContractRoundBtn.addEventListener("click", () => {
  editingRounds.push(`Round ${editingRounds.length + 1}`);
  renderContractRounds();
});

saveContractSetBtn.addEventListener("click", async () => {
  const name = contractSetNameInput.value.trim() || "Untitled Mode";
  const contracts = editingRounds.map((r) => r.trim()).filter((r) => r.length > 0);

  if (contracts.length === 0) {
    alert("Add at least one round.");
    return;
  }

  const purchasesPerPlayer = parseNonNegativeInt(purchasesPerPlayerInput.value, DEFAULT_PURCHASES_PER_PLAYER);
  const penaltyPerPurchase = parseNonNegativeInt(penaltyPerPurchaseInput.value, DEFAULT_PENALTY_PER_PURCHASE);

  await db.contractSets.update(editingContractSetId, {
    name,
    contracts,
    purchasesPerPlayer,
    penaltyPerPurchase,
  });
  navigate("settings");
});

deleteContractSetBtn.addEventListener("click", () => {
  // alert()/confirm() must be the first thing this handler does — see the
  // note in handleUndoLastRound about async gaps breaking the dialog on iOS.
  if (editingContractSetCount <= 1) {
    alert("You need at least one mode.");
    return;
  }
  if (!confirm("Delete this mode? Games using it will fall back to another mode.")) return;

  db.contractSets.delete(editingContractSetId).then(() => navigate("settings"));
});

// ==================================================
// Zoom lock
// ==================================================
// iOS Safari deliberately ignores user-scalable=no in the viewport tag, so
// pinch-zoom has to be blocked through WebKit's own gesture events. Combined
// with touch-action: manipulation (double-tap) and 16px inputs (focus zoom),
// this covers all three ways the page could otherwise scale.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

// ==================================================
// PWA: service worker + iOS "Add to Home Screen" banner
// ==================================================
if ("serviceWorker" in navigator) {
  // Was there already a worker in charge when this page loaded? If so, a later
  // change of controller means a genuinely new version took over, and the page
  // should reload onto it. On a first-ever visit there's nothing to reload for.
  const hadController = !!navigator.serviceWorker.controller;
  let reloadingForUpdate = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloadingForUpdate) return;
    reloadingForUpdate = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      // updateViaCache: "none" stops the browser serving sw.js itself from its
      // HTTP cache, which can otherwise hide a new version for hours.
      .register("sw.js", { updateViaCache: "none" })
      .then((registration) => {
        registration.update();
        // An installed iOS app is usually *resumed* rather than loaded fresh,
        // so also check for a new version each time it returns to the front.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") registration.update();
        });
      })
      .catch((err) => console.warn("Service worker registration failed", err));
  });
}

function isIOSSafariBrowsingInBrowser() {
  const ua = navigator.userAgent;
  const isIOSDevice = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isOtherIOSBrowser = /crios|fxios|edgios|opios/i.test(ua);
  const isStandalone = navigator.standalone === true;
  return isIOSDevice && !isOtherIOSBrowser && !isStandalone;
}

const IOS_INSTALL_DISMISSED_KEY = "scorepad-ios-install-dismissed";

function initIOSInstallBanner() {
  const banner = document.getElementById("ios-install-banner");
  const dismissBtn = document.getElementById("ios-install-dismiss-btn");

  if (isIOSSafariBrowsingInBrowser() && localStorage.getItem(IOS_INSTALL_DISMISSED_KEY) !== "true") {
    banner.hidden = false;
  }

  dismissBtn.addEventListener("click", () => {
    banner.hidden = true;
    localStorage.setItem(IOS_INSTALL_DISMISSED_KEY, "true");
  });
}

initIOSInstallBanner();

// ---- Init ----
// Fire-and-forget: never let this delay the first screen.
ensurePersistentStorage();
ensureDefaultContractSet().then(handleRoute);
