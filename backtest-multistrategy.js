import axios from "axios";
import { buildIndicatorPool, classifyMarketState, evaluateStrategies, rankCandidates } from "./strategies.js";
import { calculateLevels } from "./riskManager.js";
import { INTERNAL_MULTI_STRATEGY_LIST, symbolToPionex } from "./multiStrategyEngine.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN15 = 15 * 60 * 1000;
const PIONEX = "https://api.pionex.com/api/v1/market/klines";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toSymbol(base) {
  return base.endsWith("/BTC")
    ? `${base.replace(/\/BTC$/, "")}/BTC:BTC`
    : `${base}:USDT`;
}

function toCandle(k) {
  return [
    Number(k.time),
    Number(k.open),
    Number(k.high),
    Number(k.low),
    Number(k.close),
    Number(k.volume)
  ];
}

async function requestKlines(symbol, interval, endTime) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await axios.get(PIONEX, {
        params: { symbol: symbolToPionex(symbol), interval, limit: 100, endTime },
        timeout: 20000
      });
      const rows = response.data?.data?.klines;
      if (!response.data?.result || !Array.isArray(rows)) {
        throw new Error(`respuesta inválida: ${JSON.stringify(response.data).slice(0, 300)}`);
      }
      return rows.map(toCandle);
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(attempt * 1000);
    }
  }
  return [];
}

async function fetchHistory(symbol, interval, needed, endTime) {
  const rows = new Map();
  let cursor = endTime;
  while (rows.size < needed) {
    const batch = await requestKlines(symbol, interval, cursor);
    if (!batch.length) break;
    for (const candle of batch) rows.set(candle[0], candle);
    const oldest = Math.min(...batch.map((c) => c[0]));
    if (oldest >= cursor || batch.length < 2) break;
    cursor = oldest - 1;
    await sleep(180);
  }
  return [...rows.values()].sort((a, b) => a[0] - b[0]);
}

function candleAtOrBefore(rows, time) {
  let lo = 0;
  let hi = rows.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (rows[mid][0] <= time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function candleIndexAfter(rows, time) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (rows[mid][0] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function signedMove(direction, from, to) {
  return direction === "LONG" ? to - from : from - to;
}

function targetReached(direction, candle, level) {
  return direction === "LONG" ? candle[2] >= level : candle[3] <= level;
}

function stopReached(direction, candle, level) {
  return direction === "LONG" ? candle[3] <= level : candle[2] >= level;
}

function simulateTrade(signal, candles15, startIndex, management = "original", fee = 0.005) {
  const levels = signal.levels;
  const entryCandle = candles15[startIndex];
  if (!entryCandle) return { status: "NO_FUTURE_DATA" };

  const actualEntry = entryCandle[1];
  const rDistance = Math.abs(actualEntry - levels.sl);
  if (!actualEntry || !rDistance) return { status: "INVALID_ENTRY" };

  const targets = management === "be-fees-60-40"
    ? [
      { price: levels.tp1, fraction: 0.60 },
      { price: levels.tp2, fraction: 0.40 }
    ]
    : [
      { price: levels.tp1, fraction: 0.33 },
      { price: levels.tp2, fraction: 0.33 },
      { price: levels.tp3, fraction: 0.34 }
    ];
  let remaining = 1;
  let grossPnl = 0;
  let realizedR = 0;
  let targetIndex = 0;
  let exitTime = null;
  let reason = null;
  let candlesHeld = 0;
  const targetsHit = [];
  let ambiguous = false;
  let stop = levels.sl;

  const moveStopAfterTarget = (hitCount) => {
    if (management === "original") return;
    if (hitCount === 1) {
      if (management === "be-exact") stop = actualEntry;
      if (management === "be-fees" || management === "be-fees-60-40") {
        stop = signal.direction === "LONG" ? actualEntry * 1.005 : actualEntry * 0.995;
      }
    } else if (hitCount === 2) {
      stop = levels.tp1;
    }
  };

  for (let i = startIndex; i < candles15.length && remaining > 0; i++) {
    const candle = candles15[i];
    candlesHeld++;
    const stopHit = stopReached(signal.direction, candle, stop);
    const nextTargetHit = targetIndex < targets.length && targetReached(signal.direction, candle, targets[targetIndex].price);
    if (stopHit && nextTargetHit) ambiguous = true;
    if (stopHit) {
      const move = signedMove(signal.direction, actualEntry, stop);
      grossPnl += remaining * move / actualEntry;
      realizedR += remaining * move / rDistance;
      remaining = 0;
      exitTime = candle[0];
      reason = "SL";
      break;
    }

    while (targetIndex < targets.length && targetReached(signal.direction, candle, targets[targetIndex].price)) {
      const target = targets[targetIndex];
      const fraction = Math.min(remaining, target.fraction);
      const move = signedMove(signal.direction, actualEntry, target.price);
      grossPnl += fraction * move / actualEntry;
      realizedR += fraction * move / rDistance;
      remaining -= fraction;
      targetsHit.push(targetIndex + 1);
      targetIndex++;
      moveStopAfterTarget(targetIndex);
      exitTime = candle[0];
      if (remaining <= 1e-9) {
        remaining = 0;
        reason = "TP3";
        break;
      }
    }
  }

  if (remaining > 1e-9) {
    const last = candles15[candles15.length - 1];
    const mark = last?.[4] ?? actualEntry;
    const move = signedMove(signal.direction, actualEntry, mark);
    grossPnl += remaining * move / actualEntry;
    realizedR += remaining * move / rDistance;
    return {
      status: "OPEN",
      reason: "OPEN",
      actualEntry,
      grossPnl,
      netPnl: grossPnl - fee,
      realizedR,
      candlesHeld,
      exitTime: null,
      partialTargets: targetIndex,
      targetsHit,
      ambiguous
    };
  }

  return {
    status: "CLOSED",
    reason,
    actualEntry,
    grossPnl,
    netPnl: grossPnl - fee,
    realizedR: realizedR - fee * actualEntry / rDistance,
    candlesHeld,
    exitTime,
    partialTargets: targetIndex,
    targetsHit,
    ambiguous
  };
}

function emptyStats() {
  return {
    signals: 0,
    closed: 0,
    open: 0,
    sl: 0,
    netPnl: 0,
    grossPnl: 0,
    resultR: 0,
    wins: 0,
    losses: 0,
    ambiguous: 0,
    tp1Hits: 0,
    tp2Hits: 0,
    tp3Hits: 0,
    positivePnl: 0,
    negativePnl: 0,
    openNetPnl: 0,
    closedResultR: 0,
    openResultR: 0,
    avgHoldCandles: 0
  };
}

function addTrade(stats, trade) {
  stats.signals++;
  stats.netPnl += trade.netPnl;
  stats.grossPnl += trade.grossPnl;
  stats.resultR += trade.realizedR;
  if (trade.status === "OPEN") {
    stats.open++;
    stats.openNetPnl += trade.netPnl;
    stats.openResultR += trade.realizedR;
  }
  if (trade.status === "CLOSED") {
    stats.closed++;
    stats.closedResultR += trade.realizedR;
    if (trade.netPnl >= 0) {
      stats.wins++;
      stats.positivePnl += trade.netPnl;
    } else {
      stats.losses++;
      stats.negativePnl += trade.netPnl;
    }
  }
  if (trade.reason === "SL") stats.sl++;
  if (trade.targetsHit?.includes(1)) stats.tp1Hits++;
  if (trade.targetsHit?.includes(2)) stats.tp2Hits++;
  if (trade.targetsHit?.includes(3)) stats.tp3Hits++;
  if (trade.ambiguous) stats.ambiguous++;
  stats.avgHoldCandles += trade.candlesHeld || 0;
}

function finalizeStats(stats) {
  const completed = stats.closed + stats.open;
  return {
    ...stats,
    netPnlPct: stats.netPnl * 100,
    grossPnlPct: stats.grossPnl * 100,
    winRatePct: completed ? stats.wins / completed * 100 : 0,
    avgHoldCandles: completed ? stats.avgHoldCandles / completed : 0,
    closedWinRatePct: stats.closed ? stats.wins / stats.closed * 100 : 0,
    profitFactor: stats.negativePnl < 0 ? stats.positivePnl / Math.abs(stats.negativePnl) : null
  };
}

function peakDrawdown(values) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  return drawdown;
}

async function runPair(base, startTime, endTime, management, shortsOnly = false) {
  const symbol = toSymbol(base);
  const hours = Math.ceil((endTime - startTime) / HOUR) + 460;
  const quarters = Math.ceil((endTime - startTime) / MIN15) + 120;
  const [oneHour, fifteen] = await Promise.all([
    fetchHistory(symbol, "60M", hours, endTime),
    fetchHistory(symbol, "15M", quarters, Math.min(endTime, Math.floor(Date.now() / MIN15) * MIN15 - MIN15))
  ]);

  const byStrategy = {};
  const byDirection = { LONG: emptyStats(), SHORT: emptyStats() };
  const stats = emptyStats();
  const equityCurve = [];
  const signalDetails = [];
  const firstHour = Math.max(startTime, oneHour[0]?.[0] ?? startTime);

  for (let time = firstHour; time <= endTime; time += HOUR) {
    const i1 = candleAtOrBefore(oneHour, time);
    const i15 = candleAtOrBefore(fifteen, time);
    if (i1 < 200 || i15 < 100) continue;

    const data1h = oneHour.slice(Math.max(0, i1 - 449), i1 + 1);
    const data15 = fifteen.slice(Math.max(0, i15 - 99), i15 + 1);
    const pool = buildIndicatorPool(data1h, data15);
    const marketState = classifyMarketState(pool);
    const results = evaluateStrategies(data1h, data15, pool);
    const candidates = rankCandidates(results, marketState);
    if (!candidates.length) continue;

    const best = candidates[0];
    if (shortsOnly && best.direction !== "SHORT") continue;
    const levels = calculateLevels(best.entry ?? pool.p15.precio, pool.p15.atr, best.direction, symbol, best.bestSlPrice, best.targetPrice);
    if (!levels) continue;

    const entryIndex = candleIndexAfter(fifteen, time);
    const trade = simulateTrade({ ...best, levels }, fifteen, entryIndex, management);
    if (trade.status === "NO_FUTURE_DATA" || trade.status === "INVALID_ENTRY") continue;
    addTrade(stats, trade);
    addTrade(byDirection[best.direction], trade);
    byStrategy[best.bestStrategy] ||= emptyStats();
    addTrade(byStrategy[best.bestStrategy], trade);
    equityCurve.push(trade.netPnl);
    signalDetails.push({
      time,
      direction: best.direction,
      strategy: best.bestStrategy,
      score: best.score,
      probability: best.probability,
      marketState: marketState.state,
      entrySignal: levels.entry,
      entryActual: trade.actualEntry,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      result: trade.reason,
      netPnlPct: trade.netPnl * 100,
      resultR: trade.realizedR,
      candlesHeld: trade.candlesHeld
    });
  }

  const result = {
    pair: base,
    management,
    shortsOnly,
    candles1h: oneHour.length,
    candles15m: fifteen.length,
    signals: finalizeStats(stats),
    byDirection: Object.fromEntries(Object.entries(byDirection).map(([k, v]) => [k, finalizeStats(v)])),
    byStrategy: Object.fromEntries(Object.entries(byStrategy).map(([k, v]) => [k, finalizeStats(v)])),
    drawdownR: peakDrawdown(equityCurve),
    details: signalDetails
  };
  return result;
}

async function loadPortfolioData(startTime, endTime) {
  const data = {};
  for (const base of INTERNAL_MULTI_STRATEGY_LIST) {
    const symbol = toSymbol(base);
    const hours = Math.ceil((endTime - startTime) / HOUR) + 460;
    const quarters = Math.ceil((endTime - startTime) / MIN15) + 120;
    process.stdout.write(`DESCARGANDO ${base} ... `);
    const [oneHour, fifteen] = await Promise.all([
      fetchHistory(symbol, "60M", hours, endTime),
      fetchHistory(symbol, "15M", quarters, Math.min(endTime, Math.floor(Date.now() / MIN15) * MIN15 - MIN15))
    ]);
    data[base] = { symbol, oneHour, fifteen };
    console.log(`${oneHour.length} velas 1H, ${fifteen.length} velas 15M`);
  }
  return data;
}

function buildPortfolioCandidates(data, startTime, endTime, allowedStrategies = null) {
  const candidates = new Map();
  for (const [base, market] of Object.entries(data)) {
    const rows = [];
    const firstHour = Math.max(startTime, market.oneHour[0]?.[0] ?? startTime);
    for (let time = firstHour; time <= endTime; time += HOUR) {
      const i1 = candleAtOrBefore(market.oneHour, time - HOUR);
      const i15 = candleAtOrBefore(market.fifteen, time - MIN15);
      if (i1 < 200 || i15 < 100) continue;
      const data1h = market.oneHour.slice(Math.max(0, i1 - 449), i1 + 1);
      const data15 = market.fifteen.slice(Math.max(0, i15 - 99), i15 + 1);
      const pool = buildIndicatorPool(data1h, data15);
      const marketState = classifyMarketState(pool);
      const evaluated = evaluateStrategies(data1h, data15, pool);
      const filtered = allowedStrategies
        ? evaluated.filter((result) => allowedStrategies.includes(result.strategy))
        : evaluated;
      const ranked = rankCandidates(filtered, marketState);
      if (!ranked.length) continue;
      const best = ranked[0];
      const levels = calculateLevels(best.entry ?? pool.p15.precio, pool.p15.atr,
        best.direction, market.symbol, best.bestSlPrice, best.targetPrice);
      if (!levels) continue;
      const entryIndex = candleIndexAfter(market.fifteen, time);
      if (entryIndex >= market.fifteen.length) continue;
      rows.push({ time, base, marketState, best, levels, entryIndex });
    }
    candidates.set(base, rows);
    console.log(`SEÑALES ${base}: ${rows.length}`);
  }
  return candidates;
}

function emptyPortfolioStats() {
  return { ...emptyStats(), trades: [], equity: 0, peak: 0, maxDrawdown: 0 };
}

function addPortfolioTrade(stats, base, candidate, trade) {
  addTrade(stats, trade);
  stats.trades.push({
    pair: base,
    time: candidate.time,
    direction: candidate.best.direction,
    strategy: candidate.best.bestStrategy,
    strategies: (candidate.best.allStrategies || []).map((item) => item.strategy),
    score: candidate.best.score,
    probability: candidate.best.probability,
    marketState: candidate.marketState.state,
    result: trade.reason,
    netPnlPct: trade.netPnl * 100,
    resultR: trade.realizedR,
    candlesHeld: trade.candlesHeld
  });
  stats.equity += trade.netPnl;
  stats.peak = Math.max(stats.peak, stats.equity);
  stats.maxDrawdown = Math.min(stats.maxDrawdown, stats.equity - stats.peak);
}

async function runPortfolio(data, candidates, startTime, endTime, management, shortsOnly, fee) {
  const stats = emptyPortfolioStats();
  const byPair = {};
  const byStrategy = {};
  const byDirection = { LONG: emptyStats(), SHORT: emptyStats() };
  const byRegime = {};
  const all = [];
  for (const [base, rows] of candidates) {
    byPair[base] = emptyStats();
    for (const candidate of rows) {
      if (!shortsOnly || candidate.best.direction === "SHORT") all.push(candidate);
    }
  }
  all.sort((a, b) => a.time - b.time || b.best.score - a.best.score || b.best.probability - a.best.probability);
  let availableAt = startTime;
  for (const candidate of all) {
    if (candidate.time < availableAt) continue;
    const trade = simulateTrade({ ...candidate.best, levels: candidate.levels }, data[candidate.base].fifteen,
      candidate.entryIndex, management, fee);
    if (trade.status === "NO_FUTURE_DATA" || trade.status === "INVALID_ENTRY") continue;
    addPortfolioTrade(stats, candidate.base, candidate, trade);
    addTrade(byPair[candidate.base], trade);
    addTrade(byDirection[candidate.best.direction], trade);
    const regime = candidate.marketState.state || "unknown";
    byRegime[regime] ||= emptyStats();
    addTrade(byRegime[regime], trade);
    for (const strategy of candidate.best.allStrategies?.map((item) => item.strategy) || []) {
      byStrategy[strategy] ||= emptyStats();
      addTrade(byStrategy[strategy], trade);
    }
    availableAt = trade.exitTime || endTime + MIN15;
  }
  return {
    management,
    shortsOnly,
    fee,
    signals: finalizeStats(stats),
    maxDrawdownPct: stats.maxDrawdown * 100,
    pairs: Object.fromEntries(Object.entries(byPair).map(([pair, value]) => [pair, finalizeStats(value)])),
    strategies: Object.fromEntries(Object.entries(byStrategy).map(([strategy, value]) => [strategy, finalizeStats(value)])),
    directions: Object.fromEntries(Object.entries(byDirection).map(([direction, value]) => [direction, finalizeStats(value)])),
    regimes: Object.fromEntries(Object.entries(byRegime).map(([regime, value]) => [regime, finalizeStats(value)])),
    trades: stats.trades
  };
}

function compact(result) {
  const s = result.signals;
  return {
    pair: result.pair,
    signals: s.signals,
    closed: s.closed,
    open: s.open,
    wins: s.wins,
    losses: s.losses,
    sl: s.sl,
    tp1Hits: s.tp1Hits,
    tp2Hits: s.tp2Hits,
    tp3Hits: s.tp3Hits,
    winRatePct: Number(s.winRatePct.toFixed(2)),
    profitFactor: s.profitFactor == null ? null : Number(s.profitFactor.toFixed(3)),
    netPnlPct: Number(s.netPnlPct.toFixed(4)),
    resultR: Number(s.resultR.toFixed(4)),
    drawdownR: Number(result.drawdownR.toFixed(4))
  };
}

async function main() {
  const backtestDays = Number(process.env.BACKTEST_DAYS || 30);
  const latest15 = Math.floor(Date.now() / MIN15) * MIN15 - MIN15;
  const latest1h = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
  const endTime = latest1h;
  const startTime = endTime - backtestDays * DAY;
  const report = {
    generatedAt: new Date().toISOString(),
    period: { start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString() },
    methodology: {
      signal: "cierre 1H con 100 velas 15M y 450 velas 1H de contexto",
      entry: "apertura de la primera vela 15M posterior",
      management: "una sola posicion global; 33/33/34 y 60/40 con break-even",
      ambiguousCandle: "SL primero",
      fees: "0.50% total por operacion",
      levels: "niveles absolutos calculados al precio de la señal"
    },
    scenarios: {}
  };

  console.log(`Backtest ${report.period.start} -> ${report.period.end}`);
  const data = await loadPortfolioData(startTime, endTime);
  const scenarios = [
    ["be-fees-60-40", "ENSEMBLE_60_40_BE", false, null],
    ["be-fees-60-40", "SMC_ONLY_60_40_BE", false, ["SMC_Reversal"]],
    ["be-fees-60-40", "SMC_RSI_60_40_BE", false, ["SMC_Reversal", "RSI_Divergence"]],
    ["be-fees-60-40", "SMC_LIQUIDITY_60_40_BE", false, ["SMC_Reversal", "Liquidity_Grab"]]
  ];
  for (const [management, label, shortsOnly, allowedStrategies] of scenarios) {
    const candidates = buildPortfolioCandidates(data, startTime, endTime, allowedStrategies);
    const result = await runPortfolio(data, candidates, startTime, endTime, management, shortsOnly, 0.005);
    report.scenarios[label] = result;
    console.log(`${label}: ${result.signals.signals} operaciones, ${result.signals.netPnlPct.toFixed(3)}% neto, DD ${result.maxDrawdownPct.toFixed(3)}%`);
  }

  console.log(JSON.stringify(Object.fromEntries(Object.entries(report.scenarios).map(([k, v]) => [k, {
    signals: v.signals.signals,
    wins: v.signals.wins,
    losses: v.signals.losses,
    netPnlPct: v.signals.netPnlPct,
    resultR: v.signals.resultR,
    profitFactor: v.signals.profitFactor,
    maxDrawdownPct: v.maxDrawdownPct
  }])), null, 2));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(`backtest-multistrategy-${backtestDays}d-manual.json`, JSON.stringify(report, null, 2)));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
