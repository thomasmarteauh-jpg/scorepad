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
}

async function handleRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);

  if (parts[0] === "new-game") {
    await enterNewGameScreen();
  } else if (parts[0] === "scorecard" && parts[1]) {
    await enterScorecardScreen(Number(parts[1]));
  } else if (parts[0] === "summary" && parts[1]) {
    await enterSummaryScreen(Number(parts[1]));
  } else if (parts[0] === "settings") {
    await enterSettingsScreen();
  } else if (parts[0] === "contract-set" && parts[1]) {
    await enterContractSetScreen(Number(parts[1]));
  } else {
    await enterGamesScreen();
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

// playerId -> penalty points owed for purchases in this game.
async function getPurchasePointsForGame(game, mode) {
  const resolvedMode = mode || (await getModeForGame(game));
  const penalty = penaltyOf(resolvedMode);
  const limit = purchaseLimitOf(resolvedMode);
  const rows = await db.purchases.where("gameId").equals(game.id).toArray();
  // Clamp in case the mode's limit was lowered after purchases were recorded.
  return new Map(rows.map((r) => [r.playerId, Math.min(r.count || 0, limit) * penalty]));
}

// ==================================================
// Screen 1: games list
// ==================================================
const gamesListEl = document.getElementById("games-list");

async function enterGamesScreen() {
  showScreen("games-screen");
  await renderGamesList();
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

  for (const game of games) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "game-item";
    btn.textContent = game.name;

    if (game.isComplete) {
      const winner = await getWinnerName(game);
      if (winner) {
        const winnerEl = document.createElement("span");
        winnerEl.className = "game-winner";
        winnerEl.textContent = `Winner: ${winner}`;
        btn.appendChild(winnerEl);
      }
    }

    btn.addEventListener("click", () => navigate(`scorecard/${game.id}`));
    gamesListEl.appendChild(btn);
  }
}

async function getWinnerName(game) {
  const players = await Promise.all(game.playerIds.map((id) => db.players.get(id)));
  const scores = await db.scores.where("gameId").equals(game.id).toArray();
  const purchasePoints = await getPurchasePointsForGame(game);
  const standings = computeStandings(players, scores, purchasePoints);
  return standings.length ? standings[0].player.name : null;
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

async function enterNewGameScreen() {
  showScreen("new-game-screen");
  playerCount = 4;
  newGameErrorEl.hidden = true;
  await populatePlayerDatalist();
  await populateContractSetSelect();
  renderPlayerNameFields();
  updatePlayerCountControls();
}

async function populatePlayerDatalist() {
  const players = await db.players.orderBy("name").toArray();
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

  // Reuse an existing player record if the name matches one we already know,
  // otherwise create a new player. This is what powers the autocomplete list.
  const playerIds = [];
  for (const name of names) {
    const existing = await db.players.where("name").equalsIgnoreCase(name).first();
    if (existing) {
      playerIds.push(existing.id);
    } else {
      playerIds.push(await db.players.add({ name }));
    }
  }

  const gameName = `Game — ${new Date().toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  const gameId = await db.games.add({
    name: gameName,
    createdAt: Date.now(),
    playerIds,
    contractSetId: Number(contractSetSelectEl.value),
    isComplete: false,
  });

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

let currentGameId = null;
let currentPlayers = [];
let currentMode = null;
let currentContracts = DEFAULT_CONTRACTS;
let currentScores = [];
let currentPurchaseCounts = new Map();
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
    scorecardHeaderRowEl.appendChild(makeCell("th", player.name));
  }
}

// Shortens a contract like "2 sets of 3" to "2/3" so it fits the round column.
// Contract text is user-editable, so anything that doesn't match returns null
// and the row just shows its number.
function abbreviateContract(text) {
  const match = /^\s*(\d+)\s*sets?\s+of\s+(\d+)\s*$/i.exec(text || "");
  return match ? `${match[1]}/${match[2]}` : null;
}

// e.g. round 1 of the standard set -> "1. 2/3". A game can't run past its
// mode's last round, so there's no wrapping; any round beyond the list (from
// older data, or a mode that was shortened later) just shows its number.
function roundLabel(round) {
  const abbr = abbreviateContract(currentContracts[round - 1]);
  return abbr ? `${round}. ${abbr}` : String(round);
}

// True once the game has reached the last round its mode defines.
function isAtFinalRound() {
  return scorecardRoundCount >= currentContracts.length;
}

async function refreshScorecardBody() {
  currentScores = await db.scores.where("gameId").equals(currentGameId).toArray();

  const limit = purchaseLimitOf(currentMode);
  const purchaseRows = await db.purchases.where("gameId").equals(currentGameId).toArray();
  // Clamp in case the mode's limit was lowered after purchases were recorded.
  currentPurchaseCounts = new Map(purchaseRows.map((r) => [r.playerId, Math.min(r.count || 0, limit)]));

  renderScorecardBody(currentPlayers, currentScores);
  renderScorecardPurchases(currentPlayers);
  renderScorecardTotals(currentPlayers, currentScores);
  syncPurchasesRowOffset();
  updateScorecardActions();
}

// At the mode's last round the game is over: it can't be extended or rewound,
// and finishing up (View Summary) becomes the highlighted action.
function updateScorecardActions() {
  const finished = isAtFinalRound();

  addRoundBtn.disabled = finished;
  // Only truly nothing to undo when we're down to a single, unscored round.
  undoRoundBtn.disabled = finished || (currentScores.length === 0 && scorecardRoundCount <= 1);

  viewSummaryBtn.classList.toggle("btn-primary", finished);
  viewSummaryBtn.classList.toggle("btn-secondary", !finished);
}

function renderScorecardBody(players, scores) {
  const scoreByRoundAndPlayer = new Map(scores.map((s) => [`${s.roundIndex}:${s.playerId}`, s.points]));

  scorecardBodyEl.innerHTML = "";
  for (let round = 1; round <= scorecardRoundCount; round++) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell("td", roundLabel(round), "round-col"));
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

// One stepper per player, counting purchases for the whole game (they don't
// reset between rounds). Each purchase adds the mode's penalty to the total.
function renderScorecardPurchases(players) {
  const limit = purchaseLimitOf(currentMode);

  scorecardPurchasesRowEl.innerHTML = "";
  scorecardPurchasesRowEl.appendChild(makeCell("td", "Purchases", "round-col purchases-label"));

  for (const player of players) {
    const count = currentPurchaseCounts.get(player.id) || 0;

    const stepper = document.createElement("div");
    stepper.className = "purchase-stepper";

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "purchase-btn";
    downBtn.textContent = "▼";
    downBtn.setAttribute("aria-label", `One fewer purchase for ${player.name}`);
    downBtn.disabled = count <= 0;
    downBtn.addEventListener("click", () => setPurchaseCount(player.id, count - 1));

    const value = makeCell("span", String(count), "purchase-value");

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "purchase-btn";
    upBtn.textContent = "▲";
    upBtn.setAttribute("aria-label", `One more purchase for ${player.name}`);
    upBtn.disabled = count >= limit;
    upBtn.addEventListener("click", () => setPurchaseCount(player.id, count + 1));

    stepper.appendChild(downBtn);
    stepper.appendChild(value);
    stepper.appendChild(upBtn);

    const td = document.createElement("td");
    td.className = "purchases-cell";
    td.appendChild(stepper);
    scorecardPurchasesRowEl.appendChild(td);
  }
}

async function setPurchaseCount(playerId, count) {
  const limit = purchaseLimitOf(currentMode);
  const clamped = Math.max(0, Math.min(count, limit));

  const existing = await db.purchases.where("[gameId+playerId]").equals([currentGameId, playerId]).first();
  if (existing) {
    await db.purchases.update(existing.id, { count: clamped });
  } else {
    await db.purchases.add({ gameId: currentGameId, playerId, count: clamped });
  }

  await refreshScorecardBody();
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

  scorecardTotalsRowEl.innerHTML = "";
  scorecardTotalsRowEl.appendChild(makeCell("td", "Total", "round-col"));
  totals.forEach((total) => {
    const td = makeCell("td", String(total));
    if (total === lowestTotal) td.classList.add("leader-total");
    scorecardTotalsRowEl.appendChild(td);
  });
}

// Tapping any cell in a round opens the sheet for that whole round, since
// the contract applies to every player at once.
scorecardBodyEl.addEventListener("click", (event) => {
  const cell = event.target.closest(".score-cell");
  if (!cell) return;
  openRoundSheet(Number(cell.dataset.round));
});

function handleUndoLastRound() {
  if (isAtFinalRound()) return;

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
  await db.scores.where("[gameId+roundIndex]").equals([currentGameId, lastRound]).delete();

  if (lastRound === scorecardRoundCount && scorecardRoundCount > 1) {
    scorecardRoundCount--;
  }

  await refreshScorecardBody();
}

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

let sheetRound = null;

async function openRoundSheet(round) {
  sheetRound = round;
  sheetRoundTitleEl.textContent = `Round ${round}`;
  sheetContractEl.textContent = currentContracts[(round - 1) % currentContracts.length];

  const scores = await db.scores.where("[gameId+roundIndex]").equals([currentGameId, round]).toArray();
  const pointsByPlayerId = new Map(scores.map((s) => [s.playerId, s.points]));

  sheetPlayersEl.innerHTML = "";
  for (const player of currentPlayers) {
    const row = document.createElement("div");
    row.className = "sheet-player-row";

    const label = document.createElement("span");
    label.className = "sheet-player-name";
    label.textContent = player.name;

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    input.className = "sheet-score-input";
    input.dataset.playerId = String(player.id);
    const existingPoints = pointsByPlayerId.get(player.id);
    input.value = existingPoints !== undefined ? String(existingPoints) : "";

    row.appendChild(label);
    row.appendChild(input);
    sheetPlayersEl.appendChild(row);
  }

  sheetOverlayEl.hidden = false;
  scoreSheetEl.hidden = false;
}

function closeSheet() {
  sheetOverlayEl.hidden = true;
  scoreSheetEl.hidden = true;
  sheetRound = null;
}

sheetCloseBtn.addEventListener("click", closeSheet);
sheetCancelBtn.addEventListener("click", closeSheet);
sheetOverlayEl.addEventListener("click", closeSheet);

sheetSaveBtn.addEventListener("click", async () => {
  const round = sheetRound;
  const inputs = Array.from(sheetPlayersEl.querySelectorAll(".sheet-score-input"));

  await db.transaction("rw", db.scores, async () => {
    for (const input of inputs) {
      const playerId = Number(input.dataset.playerId);
      const points = Math.max(0, parseInt(input.value, 10) || 0);
      const existing = await db.scores
        .where("[gameId+roundIndex+playerId]")
        .equals([currentGameId, round, playerId])
        .first();
      if (existing) {
        await db.scores.update(existing.id, { points });
      } else {
        await db.scores.add({ gameId: currentGameId, roundIndex: round, playerId, points });
      }
    }
  });

  closeSheet();
  await refreshScorecardBody();
});

// ==================================================
// Screen 4: game summary (standings + cumulative chart)
// ==================================================
const summaryTitleEl = document.getElementById("summary-title");
const summaryBackBtn = document.getElementById("summary-back-btn");
const standingsListEl = document.getElementById("standings-list");
const chartContainerEl = document.getElementById("chart-container");
const chartLegendEl = document.getElementById("chart-legend");
const toggleCompleteBtn = document.getElementById("toggle-complete-btn");
const summaryNewGameBtn = document.getElementById("summary-new-game-btn");

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
  const purchasePoints = await getPurchasePointsForGame(game);

  summaryTitleEl.textContent = game.name;
  renderStandings(players, scores, purchasePoints);
  renderCumulativeChart(players, scores, purchasePoints);
  toggleCompleteBtn.textContent = game.isComplete ? "Reopen Game" : "Mark Game Complete";

  summaryBackBtn.onclick = () => navigate(`scorecard/${gameId}`);
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

function renderStandings(players, scores, purchasePoints) {
  const standings = computeStandings(players, scores, purchasePoints);

  standingsListEl.innerHTML = "";
  standings.forEach((entry, index) => {
    const li = document.createElement("li");
    li.className = "standing-row";
    if (index === 0) li.classList.add("is-winner");

    li.appendChild(makeCell("span", `${index + 1}.`, "standing-rank"));
    li.appendChild(makeCell("span", entry.player.name, "standing-name"));
    li.appendChild(makeCell("span", String(entry.total), "standing-total"));
    standingsListEl.appendChild(li);
  });
}

function renderCumulativeChart(players, scores, purchasePoints) {
  chartLegendEl.innerHTML = "";
  const roundCount = scores.reduce((max, s) => Math.max(max, s.roundIndex), 0);

  if (roundCount === 0) {
    chartContainerEl.innerHTML = '<p class="empty-state">No rounds scored yet</p>';
    return;
  }

  // cumulativeByPlayer[i] is that player's running total after each round, 1..roundCount.
  // Purchase penalties aren't tied to any round, so they're carried as a flat
  // offset from the start: the round-to-round steps stay true to the scores
  // while each line still ends on the player's real total.
  const cumulativeByPlayer = players.map((player) => {
    let running = (purchasePoints && purchasePoints.get(player.id)) || 0;
    const points = [];
    for (let round = 1; round <= roundCount; round++) {
      const roundScore = scores.find((s) => s.roundIndex === round && s.playerId === player.id);
      running += roundScore ? roundScore.points : 0;
      points.push(running);
    }
    return points;
  });

  const maxValue = Math.max(1, ...cumulativeByPlayer.flat());
  const width = 320;
  const height = 200;
  const paddingLeft = 34;
  const paddingTop = 10;
  const paddingBottom = 20;
  const plotWidth = width - paddingLeft - 10;
  const plotHeight = height - paddingTop - paddingBottom;

  const xFor = (round) => paddingLeft + (roundCount === 1 ? 0 : ((round - 1) / (roundCount - 1)) * plotWidth);
  const yFor = (value) => paddingTop + plotHeight - (value / maxValue) * plotHeight;

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<line x1="${paddingLeft}" y1="${yFor(0)}" x2="${width - 10}" y2="${yFor(0)}" style="stroke: var(--border)" stroke-width="1" />`;
  svg += `<text x="2" y="${yFor(0) + 4}" font-size="10" style="fill: var(--muted)">0</text>`;
  svg += `<text x="2" y="${yFor(maxValue) + 4}" font-size="10" style="fill: var(--muted)">${maxValue}</text>`;

  players.forEach((player, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const pointsAttr = cumulativeByPlayer[i].map((value, idx) => `${xFor(idx + 1)},${yFor(value)}`).join(" ");
    svg += `<polyline points="${pointsAttr}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
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

// ==================================================
// Screen 5: settings (players, contract sets, data)
// ==================================================
const settingsPlayersListEl = document.getElementById("settings-players-list");
const settingsContractSetsListEl = document.getElementById("settings-contract-sets-list");
const newContractSetBtn = document.getElementById("new-contract-set-btn");
const exportDataBtn = document.getElementById("export-data-btn");
const importDataInput = document.getElementById("import-data-input");
const dataStatusEl = document.getElementById("data-status");

document.getElementById("settings-back-btn").addEventListener("click", () => navigate("games"));

async function enterSettingsScreen() {
  showScreen("settings-screen");
  dataStatusEl.hidden = true;
  await renderSettingsPlayers();
  await renderSettingsContractSets();
}

async function renderSettingsPlayers() {
  const players = await db.players.orderBy("name").toArray();
  const games = await db.games.toArray();
  const usedPlayerIds = new Set(games.flatMap((g) => g.playerIds));

  settingsPlayersListEl.innerHTML = "";
  if (players.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No players yet";
    settingsPlayersListEl.appendChild(empty);
    return;
  }

  for (const player of players) {
    const row = document.createElement("div");
    row.className = "settings-row";

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

    const isUsed = usedPlayerIds.has(player.id);
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "settings-row-delete";
    deleteBtn.textContent = "×";
    deleteBtn.setAttribute("aria-label", `Delete ${player.name}`);
    deleteBtn.disabled = isUsed;
    if (isUsed) deleteBtn.title = "Can't delete a player who's already in a game";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete ${player.name}?`)) return;
      await db.players.delete(player.id);
      await renderSettingsPlayers();
    });

    row.appendChild(input);
    row.appendChild(deleteBtn);
    settingsPlayersListEl.appendChild(row);
  }
}

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

exportDataBtn.addEventListener("click", async () => {
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

    // Backups made before purchases existed simply have none.
    const purchases = Array.isArray(payload.purchases) ? payload.purchases : [];

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

    dataStatusEl.textContent = "Import complete.";
    dataStatusEl.hidden = false;
    await renderSettingsPlayers();
    await renderSettingsContractSets();
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
// PWA: service worker + iOS "Add to Home Screen" banner
// ==================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker registration failed", err));
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
ensureDefaultContractSet().then(handleRoute);
