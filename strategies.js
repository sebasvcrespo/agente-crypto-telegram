import {
  calculateBB, calculateRSI, calculateRSIArray, calculateATR, calculateADX,
  calculateEMA, calculateMACD, calculatePivotsArray,
  calculateVolumeProfile
} from "./indicators.js";

const STRATEGY_LIST = [
  "SMC_Reversal",
  "Trend_Pullback",
  "VP_Mean_Revert",
  "Breakout",
  "Liquidity_Grab",
  "RSI_Divergence"
];

const MIN_SCORE = 60;
const MIN_PROB = 65;

// SMC_Reversal
const SWEEP_LOOKBACK = 20;
const CHOCH_WINDOW = 5;
const OB_FVG_MIN_ATR = 0.2;

// Trend_Pullback
const FIB_LOW = 0.618;
const FIB_HIGH = 0.786;
const EMA_TOUCH_TOLERANCE = 0.001;

// VP_Mean_Revert
const VP_BINS = 24;
const VP_LOOKBACK = 120;
const LVN_THRESHOLD = 0.30;

// Breakout
const CONSOLIDATION_MIN = 20;
const VOLUME_MULTIPLIER = 1.8;

// Liquidity_Grab
const EQH_LOOKBACK = 120;
const EQH_RECENCY = 40;
const WICK_MIN_RATIO = 0.50;
const EQH_TOLERANCE = 0.001;

// RSI_Divergence
const RSI_WINDOW = 14;
const PIVOT_LEFT = 2;
const PIVOT_RIGHT = 2;
const CONFIRM_CANDLES = 2;
const PIVOT_ALIGNMENT = 3;

const ADX_TRENDING = 22;
const ADX_LATERAL = 18;

const CONTEXT_BONUS_PRIMARY = 5;
const CONTEXT_BONUS_UNIVERSAL = 2;

const PRIMARY_BY_STATE = {
  trending: ["Trend_Pullback", "Breakout"],
  lateral: ["VP_Mean_Revert", "SMC_Reversal"],
  transitional: [],
  unknown: []
};

export function classifyMarketState(pool) {
  const p1h = pool?.p1h;
  if (!p1h) return { state: "unknown", adx: null, direction: "neutral" };
  const adx = p1h.adx?.adx;
  if (adx == null || isNaN(adx)) {
    return { state: "unknown", adx: null, direction: "neutral" };
  }

  const state = adx > ADX_TRENDING ? "trending" : adx < ADX_LATERAL ? "lateral" : "transitional";

  let direction = "neutral";
  if (state === "trending" && p1h.ema20 != null && p1h.ema50 != null && p1h.ema200 != null) {
    if (p1h.ema20 > p1h.ema50 && p1h.ema50 > p1h.ema200) direction = "bullish";
    else if (p1h.ema20 < p1h.ema50 && p1h.ema50 < p1h.ema200) direction = "bearish";
  }

  return { state, adx, direction };
}

export function buildIndicatorPool(ohlcv1h, ohlcv15m) {
  const extract = (data, idx) => data.map((d) => d[idx]);
  const result = {};

  if (ohlcv1h && ohlcv1h.length >= 20) {
    const o = extract(ohlcv1h, 1), h = extract(ohlcv1h, 2),
          l = extract(ohlcv1h, 3), c = extract(ohlcv1h, 4), v = extract(ohlcv1h, 5);
    const volSlice = v.slice(-CONSOLIDATION_MIN);
    result.p1h = {
      precio: c[c.length - 1],
      close: c, high: h, low: l, open: o, volume: v,
      bb: calculateBB(c, 20, 2),
      rsi: calculateRSI(c, 14),
      adx: calculateADX(h, l, c, 14),
      atr: calculateATR(h, l, c, 14),
      ema20: calculateEMA(c, 20),
      ema50: calculateEMA(c, 50),
      ema200: calculateEMA(c, 200),
      macd: calculateMACD(c),
      pivots: calculatePivotsArray(h, l, 3),
      vp: calculateVolumeProfile(ohlcv1h.slice(-VP_LOOKBACK), VP_BINS),
      volAvg: volSlice.reduce((a, b) => a + b, 0) / Math.min(CONSOLIDATION_MIN, volSlice.length),
      lastVol: v[v.length - 1]
    };
  }

  if (ohlcv15m && ohlcv15m.length >= 20) {
    const o = extract(ohlcv15m, 1), h = extract(ohlcv15m, 2),
          l = extract(ohlcv15m, 3), c = extract(ohlcv15m, 4), v = extract(ohlcv15m, 5);
    const volSlice = v.slice(-CONSOLIDATION_MIN);
    result.p15 = {
      precio: c[c.length - 1],
      close: c, high: h, low: l, open: o, volume: v,
      bb: calculateBB(c, 20, 2),
      rsi: calculateRSI(c, 14),
      adx: calculateADX(h, l, c, 14),
      atr: calculateATR(h, l, c, 14),
      ema20: calculateEMA(c, 20),
      ema50: calculateEMA(c, 50),
      macd: calculateMACD(c),
      pivots: calculatePivotsArray(h, l, 3),
      volAvg: volSlice.reduce((a, b) => a + b, 0) / Math.min(CONSOLIDATION_MIN, volSlice.length),
      lastVol: v[v.length - 1]
    };
  }

  return result;
}

function rvolOf(p15) {
  if (!p15 || !p15.volAvg) return null;
  return p15.lastVol / p15.volAvg;
}

function lastCandleRejection(p15) {
  const n = p15.close.length;
  if (n < 1) return null;
  const o = p15.open[n - 1], c = p15.close[n - 1], h = p15.high[n - 1], l = p15.low[n - 1];
  const range = h - l;
  if (range <= 0) return { lowerWickRatio: 0, upperWickRatio: 0, bullish: c >= o, bearish: c <= o };
  return {
    lowerWickRatio: (Math.min(o, c) - l) / range,
    upperWickRatio: (h - Math.max(o, c)) / range,
    bullish: c >= o,
    bearish: c <= o
  };
}

function findOBorFVG(open, high, low, close, atr, dir, minAtr) {
  const n = close.length;
  if (n < 4 || !atr) return null;
  const minGap = minAtr * atr;

  for (let i = n - 3; i >= 2; i--) {
    const gapUp = low[i + 1] - high[i - 1];
    const gapDown = low[i - 1] - high[i + 1];
    if (dir === "LONG" && gapUp >= minGap) {
      const since = Math.min(...low.slice(i + 2));
      if (since >= high[i - 1]) return { type: "FVG", idx: i, size: gapUp };
    }
    if (dir === "SHORT" && gapDown >= minGap) {
      const since = Math.max(...high.slice(i + 2));
      if (since <= low[i - 1]) return { type: "FVG", idx: i, size: gapDown };
    }
  }

  for (let i = n - 2; i >= 1; i--) {
    const move = close[i + 1] - open[i + 1];
    if (dir === "LONG" && close[i] < open[i] && move >= minGap) {
      return { type: "OB", idx: i, size: move };
    }
    if (dir === "SHORT" && close[i] > open[i] && -move >= minGap) {
      return { type: "OB", idx: i, size: move };
    }
  }

  return null;
}

function pivotIndices(arr, left, right, type, skipNull = false) {
  const idxs = [];
  for (let i = left; i < arr.length - right; i++) {
    const v = arr[i];
    if (skipNull && v == null) continue;
    let ok = true;
    for (let j = 1; j <= left && ok; j++) {
      const pv = arr[i - j];
      if (pv == null) { ok = false; break; }
      if (type === "high" ? v <= pv : v >= pv) ok = false;
    }
    for (let j = 1; j <= right && ok; j++) {
      const nv = arr[i + j];
      if (nv == null) { ok = false; break; }
      if (type === "high" ? v <= nv : v >= nv) ok = false;
    }
    if (ok) idxs.push(i);
  }
  return idxs;
}

function smcReversal(pool) {
  const p15 = pool.p15;
  const p1h = pool.p1h;
  if (!p15 || !p15.close || p15.close.length < SWEEP_LOOKBACK + CHOCH_WINDOW + 2) return null;

  const { high, low, close, open } = p15;
  const n = close.length;
  const lastIdx = n - 1;
  const atr = p15.atr || close[lastIdx] * 0.005;

  let sweep = null;
  for (let i = Math.max(SWEEP_LOOKBACK, lastIdx - CHOCH_WINDOW); i <= lastIdx; i++) {
    const start = i - SWEEP_LOOKBACK;
    const priorLow = Math.min(...low.slice(start, i));
    const priorHigh = Math.max(...high.slice(start, i));
    if (low[i] < priorLow && close[i] > priorLow) {
      sweep = { dir: "LONG", extreme: low[i], idx: i };
    }
    if (high[i] > priorHigh && close[i] < priorHigh) {
      sweep = { dir: "SHORT", extreme: high[i], idx: i };
    }
  }
  if (!sweep) return null;

  const refIdx = sweep.idx > 0 ? sweep.idx - 1 : sweep.idx;
  const end = Math.min(lastIdx, sweep.idx + CHOCH_WINDOW);
  let chochIdx = -1;
  for (let i = sweep.idx + 1; i <= end; i++) {
    if (sweep.dir === "LONG" && close[i] > high[refIdx]) { chochIdx = i; break; }
    if (sweep.dir === "SHORT" && close[i] < low[refIdx]) { chochIdx = i; break; }
  }
  if (chochIdx < 0) return null;

  for (let i = sweep.idx + 1; i <= chochIdx; i++) {
    if (sweep.dir === "LONG" && low[i] < sweep.extreme) return null;
    if (sweep.dir === "SHORT" && high[i] > sweep.extreme) return null;
  }

  const imbalance = findOBorFVG(open, high, low, close, atr, sweep.dir, OB_FVG_MIN_ATR);

  let score = 60;
  const reasons = [];
  reasons.push(`Sweep ${sweep.dir === "LONG" ? "de mínimos" : "de máximos"} + CHoCH (${CHOCH_WINDOW} velas)`);
  if (imbalance) {
    score += 15;
    reasons.push(`${imbalance.type} no mitigado (${imbalance.size.toFixed(8)})`);
  }
  const rsi15 = p15.rsi;
  if (sweep.dir === "LONG" && rsi15 != null && rsi15 < 35) { score += 10; reasons.push("RSI 15m sobrevendido"); }
  if (sweep.dir === "SHORT" && rsi15 != null && rsi15 > 65) { score += 10; reasons.push("RSI 15m sobrecomprado"); }
  const adx1h = p1h?.adx?.adx;
  if (adx1h != null && adx1h < ADX_LATERAL) { score += 5; reasons.push("Contexto 1H lateral"); }

  const suggestedSlPrice = sweep.dir === "LONG" ? sweep.extreme - 0.25 * atr : sweep.extreme + 0.25 * atr;

  return {
    strategy: "SMC_Reversal",
    signal: sweep.dir,
    score: Math.min(score, 100),
    prob: Math.min(score, 100),
    reasons,
    suggestedSlPrice,
    entry: p15.precio,
    atr,
    structure: !!imbalance,
    rvol: rvolOf(p15)
  };
}

function trendPullback(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15) return null;
  if (p1h.ema20 == null || p1h.ema50 == null || p1h.ema200 == null) return null;

  const { close, high, low } = p1h;
  const n = close.length;
  const price = p1h.precio;
  const { ema20, ema50, ema200 } = p1h;

  const bullish = ema20 > ema50 && ema50 > ema200;
  const bearish = ema20 < ema50 && ema50 < ema200;
  if (!bullish && !bearish) return null;

  const dir = bullish ? "LONG" : "SHORT";

  const lookback = Math.min(50, n);
  const windowHigh = Math.max(...high.slice(n - lookback));
  const windowLow = Math.min(...low.slice(n - lookback));
  const impulse = windowHigh - windowLow;

  let inFib = false;
  if (impulse > 0) {
    const a = windowHigh - FIB_LOW * impulse;
    const b = windowHigh - FIB_HIGH * impulse;
    inFib = price >= Math.min(a, b) && price <= Math.max(a, b);
  }

  const nearEma20 = Math.abs(price - ema20) / price <= EMA_TOUCH_TOLERANCE
    || Math.abs(price - ema50) / price <= EMA_TOUCH_TOLERANCE;
  const inEmaZone = (price <= ema20 && price >= ema50) || (price >= ema20 && price <= ema50);
  const inZone = inFib || nearEma20 || inEmaZone;
  if (!inZone) return null;

  const rejection = lastCandleRejection(p15);
  if (!rejection) return null;
  const rejectionOk = dir === "LONG" ? (rejection.lowerWickRatio >= 0.5 && rejection.bullish)
                                     : (rejection.upperWickRatio >= 0.5 && rejection.bearish);
  if (!rejectionOk) return null;

  let score = 60;
  const reasons = [`Tendencia ${bullish ? "alcista" : "bajista"} EMA20/50/200 + pullback a zona`];
  if (inFib) { score += 10; reasons.push(`Retroceso Fib ${FIB_LOW}-${FIB_HIGH}`); }
  const adx1h = p1h.adx?.adx;
  if (adx1h != null && adx1h > 30) { score += 10; reasons.push(`ADX 1H fuerte (${adx1h})`); }
  if (dir === "LONG" && p15.rsi != null && p15.rsi > 45 && p15.rsi < 60) { score += 5; reasons.push("RSI 15m neutral-alcista"); }
  if (dir === "SHORT" && p15.rsi != null && p15.rsi > 40 && p15.rsi < 55) { score += 5; reasons.push("RSI 15m neutral-bajista"); }

  const atr = p15.atr || price * 0.005;
  const swingLow = Math.min(...p15.low.slice(-8));
  const swingHigh = Math.max(...p15.high.slice(-8));
  const suggestedSlPrice = dir === "LONG" ? swingLow - 1.0 * atr : swingHigh + 1.0 * atr;

  return {
    strategy: "Trend_Pullback",
    signal: dir,
    score: Math.min(score, 100),
    prob: Math.min(score, 100),
    reasons,
    suggestedSlPrice,
    entry: p15.precio,
    atr,
    structure: inFib || nearEma20,
    rvol: rvolOf(p15)
  };
}

function isLvn(price, vp) {
  if (!vp || !vp.buckets || vp.buckets.length === 0 || !vp.bucketSize || vp.maxBucketVol <= 0) return false;
  let idx = Math.floor((price - vp.minPrice) / vp.bucketSize);
  idx = Math.max(0, Math.min(vp.buckets.length - 1, idx));
  return vp.buckets[idx] <= LVN_THRESHOLD * vp.maxBucketVol;
}

function vpMeanRevert(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15 || !p1h.vp) return null;

  const { poc, vah, val } = p1h.vp;
  const price = p1h.precio;
  const atr = p1h.atr || price * 0.005;

  let dir = null;
  if (price < val && isLvn(price, p1h.vp)) dir = "LONG";
  else if (price > vah && isLvn(price, p1h.vp)) dir = "SHORT";
  if (!dir) return null;

  let suggestedSlPrice;
  if (dir === "LONG") {
    suggestedSlPrice = val - 1.0 * atr;
    if (!(suggestedSlPrice < price)) {
      suggestedSlPrice = Math.min(poc, price) - 1.0 * atr;
    }
  } else {
    suggestedSlPrice = vah + 1.0 * atr;
    if (!(suggestedSlPrice > price)) {
      suggestedSlPrice = Math.max(poc, price) + 1.0 * atr;
    }
  }

  let score = 60;
  const reasons = [`Precio fuera del Value Area ${dir === "LONG" ? `bajo VAL (${val.toFixed(8)})` : `sobre VAH (${vah.toFixed(8)})`} + LVN`];
  const adx1h = p1h.adx?.adx;
  if (adx1h != null && adx1h < ADX_LATERAL) { score += 10; reasons.push("ADX 1H lateral"); }
  if (dir === "LONG" && p15.rsi != null && p15.rsi < 40) { score += 10; reasons.push("RSI 15m sobrevendido"); }
  if (dir === "SHORT" && p15.rsi != null && p15.rsi > 60) { score += 10; reasons.push("RSI 15m sobrecomprado"); }
  if (p15.bb) {
    if (dir === "LONG" && p15.precio < p15.bb.lower) { score += 5; reasons.push("Bajo BB 15m"); }
    if (dir === "SHORT" && p15.precio > p15.bb.upper) { score += 5; reasons.push("Sobre BB 15m"); }
  }

  return {
    strategy: "VP_Mean_Revert",
    signal: dir,
    score: Math.min(score, 100),
    prob: Math.min(score, 100),
    reasons,
    suggestedSlPrice,
    entry: p15.precio,
    atr: p15.atr || p15.precio * 0.005,
    structure: true,
    rvol: rvolOf(p15)
  };
}

function breakout(pool) {
  const p15 = pool.p15;
  if (!p15 || !p15.close || p15.close.length < CONSOLIDATION_MIN + 1) return null;

  const n = p15.close.length;
  const { close, high, low, volume } = p15;

  const rangeHigh = Math.max(...high.slice(n - 1 - CONSOLIDATION_MIN, n - 1));
  const rangeLow = Math.min(...low.slice(n - 1 - CONSOLIDATION_MIN, n - 1));
  const consoVol = volume.slice(n - 1 - CONSOLIDATION_MIN, n - 1);
  const avgVol = consoVol.reduce((a, b) => a + b, 0) / consoVol.length;

  const lastClose = close[n - 1];
  const lastVol = volume[n - 1];
  const rvol = avgVol > 0 ? lastVol / avgVol : 0;
  if (rvol < VOLUME_MULTIPLIER) return null;

  let dir = null;
  if (lastClose > rangeHigh) dir = "LONG";
  else if (lastClose < rangeLow) dir = "SHORT";
  if (!dir) return null;

  const atr = p15.atr || lastClose * 0.005;
  const broken = dir === "LONG" ? rangeHigh : rangeLow;
  const mid = (rangeHigh + rangeLow) / 2;
  const dist = Math.abs(lastClose - broken);

  let suggestedSlPrice;
  if (dist >= atr) {
    suggestedSlPrice = dir === "LONG" ? broken - 0.25 * atr : broken + 0.25 * atr;
  } else {
    suggestedSlPrice = dir === "LONG" ? mid - 0.25 * atr : mid + 0.25 * atr;
  }
  if (dir === "LONG" && !(suggestedSlPrice < lastClose)) suggestedSlPrice = mid - 0.25 * atr;
  if (dir === "SHORT" && !(suggestedSlPrice > lastClose)) suggestedSlPrice = mid + 0.25 * atr;

  let score = 60;
  const reasons = [`Breakout ${dir === "LONG" ? "alcista" : "bajista"} cierre (${lastClose.toFixed(8)}) ${dir === "LONG" ? ">" : "<"} rango (${broken.toFixed(8)})`];
  reasons.push(`Volumen ${rvol.toFixed(1)}x media (>= ${VOLUME_MULTIPLIER}x)`);
  score += 15;
  if (dir === "LONG" && p15.rsi != null && p15.rsi > 55) { score += 5; reasons.push("RSI 15m alcista"); }
  if (dir === "SHORT" && p15.rsi != null && p15.rsi < 45) { score += 5; reasons.push("RSI 15m bajista"); }
  const adx15 = p15.adx?.adx;
  if (adx15 != null && adx15 > 20) { score += 5; reasons.push("ADX 15m confirmado"); }

  return {
    strategy: "Breakout",
    signal: dir,
    score: Math.min(score, 100),
    prob: Math.min(score, 100),
    reasons,
    suggestedSlPrice,
    entry: p15.precio,
    atr,
    structure: true,
    rvol
  };
}

function clusterEqualLevels(pivots, tolerance) {
  const levels = [];
  for (const p of pivots) {
    const found = levels.find((l) => Math.abs(l.value - p.value) / p.value <= tolerance);
    if (found) {
      found.members.push(p);
      found.value = found.members.reduce((a, m) => a + m.value, 0) / found.members.length;
      found.lastIdx = Math.max(found.lastIdx, p.idx);
      found.firstIdx = Math.min(found.firstIdx, p.idx);
    } else {
      levels.push({ value: p.value, members: [p], lastIdx: p.idx, firstIdx: p.idx });
    }
  }
  return levels.filter((l) => l.members.length >= 2);
}

function liquidityGrab(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15) return null;
  const n1 = p1h.close.length;
  if (n1 < 30) return null;

  const start = Math.max(0, n1 - EQH_LOOKBACK);
  const hSlice = p1h.high.slice(start);
  const lSlice = p1h.low.slice(start);
  const highs = pivotIndices(hSlice, 2, 2, "high").map((i) => ({ idx: start + i, value: hSlice[i] }));
  const lows = pivotIndices(lSlice, 2, 2, "low").map((i) => ({ idx: start + i, value: lSlice[i] }));

  const eqh = clusterEqualLevels(highs, EQH_TOLERANCE).filter((l) => n1 - 1 - l.lastIdx <= EQH_RECENCY);
  const eql = clusterEqualLevels(lows, EQH_TOLERANCE).filter((l) => n1 - 1 - l.lastIdx <= EQH_RECENCY);
  if (!eqh.length && !eql.length) return null;

  const n = p15.close.length;
  const lastHigh15 = p15.high[n - 1];
  const lastLow15 = p15.low[n - 1];
  const lastClose15 = p15.close[n - 1];
  const rejection = lastCandleRejection(p15);
  if (!rejection) return null;

  const price = p15.precio;
  const atr = p15.atr || price * 0.005;

  let dir = null, level = null, sweepExtreme = null;
  for (const l of eql) {
    if (lastLow15 < l.value && lastClose15 > l.value && Math.abs(price - l.value) / price <= 0.02) {
      dir = "LONG";
      level = l.value;
      sweepExtreme = lastLow15;
      break;
    }
  }
  if (!dir) {
    for (const l of eqh) {
      if (lastHigh15 > l.value && lastClose15 < l.value && Math.abs(price - l.value) / price <= 0.02) {
        dir = "SHORT";
        level = l.value;
        sweepExtreme = lastHigh15;
        break;
      }
    }
  }
  if (!dir) return null;

  const wickOk = dir === "LONG" ? rejection.lowerWickRatio >= WICK_MIN_RATIO : rejection.upperWickRatio >= WICK_MIN_RATIO;
  if (!wickOk) return null;

  const last3Low = Math.min(...p15.low.slice(-3));
  const last3High = Math.max(...p15.high.slice(-3));
  const suggestedSlPrice = dir === "LONG"
    ? Math.min(sweepExtreme, last3Low) - 0.25 * atr
    : Math.max(sweepExtreme, last3High) + 0.25 * atr;

  let score = 60;
  const reasons = [`Liquidity grab ${dir === "LONG" ? "EQL" : "EQH"} (${level.toFixed(8)}) con rechazo ${(dir === "LONG" ? rejection.lowerWickRatio : rejection.upperWickRatio).toFixed(2)}`];
  if (dir === "LONG" && p15.rsi != null && p15.rsi < 40) { score += 10; reasons.push("RSI 15m sobrevendido"); }
  if (dir === "SHORT" && p15.rsi != null && p15.rsi > 60) { score += 10; reasons.push("RSI 15m sobrecomprado"); }

  return {
    strategy: "Liquidity_Grab",
    signal: dir,
    score: Math.min(score, 100),
    prob: Math.min(score, 100),
    reasons,
    suggestedSlPrice,
    entry: p15.precio,
    atr,
    structure: true,
    rvol: rvolOf(p15)
  };
}

function rsiDivergence(pool) {
  const p15 = pool.p15;
  if (!p15 || !p15.close || p15.close.length < RSI_WINDOW + 12) return null;

  const { close, high, low } = p15;
  const n = close.length;
  const atr = p15.atr || close[n - 1] * 0.005;
  const rsiArr = calculateRSIArray(close, RSI_WINDOW);

  const priceLows = pivotIndices(low, PIVOT_LEFT, PIVOT_RIGHT, "low");
  const priceHighs = pivotIndices(high, PIVOT_LEFT, PIVOT_RIGHT, "high");
  const rsiLows = pivotIndices(rsiArr, PIVOT_LEFT, PIVOT_RIGHT, "low", true);
  const rsiHighs = pivotIndices(rsiArr, PIVOT_LEFT, PIVOT_RIGHT, "high", true);

  const nearestWithin = (target, arr, tol) => {
    let best = null, bestDist = Infinity;
    for (const i of arr) {
      const d = Math.abs(i - target);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return bestDist <= tol ? best : null;
  };

  let dir = null, pivotIdx = null;
  if (priceLows.length >= 2) {
    const a = priceLows[priceLows.length - 2], b = priceLows[priceLows.length - 1];
    const priceLL = low[b] < low[a];
    const rsiA = rsiArr[a], rsiB = rsiArr[b];
    const rsiHL = rsiA != null && rsiB != null && rsiB > rsiA;
    const recent = n - 1 - b <= CONFIRM_CANDLES + PIVOT_RIGHT + 2;
    const aligned = nearestWithin(b, rsiLows, PIVOT_ALIGNMENT) != null;
    if (priceLL && rsiHL && recent && aligned) { dir = "LONG"; pivotIdx = b; }
  }
  if (!dir && priceHighs.length >= 2) {
    const a = priceHighs[priceHighs.length - 2], b = priceHighs[priceHighs.length - 1];
    const priceHH = high[b] > high[a];
    const rsiA = rsiArr[a], rsiB = rsiArr[b];
    const rsiLH = rsiA != null && rsiB != null && rsiB < rsiA;
    const recent = n - 1 - b <= CONFIRM_CANDLES + PIVOT_RIGHT + 2;
    const aligned = nearestWithin(b, rsiHighs, PIVOT_ALIGNMENT) != null;
    if (priceHH && rsiLH && recent && aligned) { dir = "SHORT"; pivotIdx = b; }
  }
  if (!dir) return null;

  const swingLow = Math.min(...low.slice(-8));
  const swingHigh = Math.max(...high.slice(-8));
  const suggestedSlPrice = dir === "LONG" ? swingLow - 1.0 * atr : swingHigh + 1.0 * atr;

  let score = 60;
  const reasons = [`Divergencia regular ${dir === "LONG" ? "alcista (LL precio + HL RSI)" : "bajista (HH precio + LH RSI)"}`];
  if (dir === "LONG" && p15.rsi != null && p15.rsi < 40) { score += 10; reasons.push("RSI 15m sobrevendido"); }
  if (dir === "SHORT" && p15.rsi != null && p15.rsi > 60) { score += 10; reasons.push("RSI 15m sobrecomprado"); }
  if (p15.macd) {
    if (dir === "LONG" && p15.macd.histogram > 0) { score += 5; reasons.push("MACD 15m positivo"); }
    if (dir === "SHORT" && p15.macd.histogram < 0) { score += 5; reasons.push("MACD 15m negativo"); }
  }

  return {
    strategy: "RSI_Divergence",
    signal: dir,
    score: Math.min(score, 100),
    prob: Math.min(score, 100),
    reasons,
    suggestedSlPrice,
    entry: p15.precio,
    atr,
    structure: pivotIdx != null,
    rvol: rvolOf(p15)
  };
}

const ALL_STRATEGIES = [
  smcReversal,
  trendPullback,
  vpMeanRevert,
  breakout,
  liquidityGrab,
  rsiDivergence
];

export function evaluateStrategies(ohlcv1h, ohlcv15m, pool = null) {
  const dataPool = pool || buildIndicatorPool(ohlcv1h, ohlcv15m);
  if (!dataPool.p1h || !dataPool.p15) return [];

  const results = [];
  for (const stratFn of ALL_STRATEGIES) {
    try {
      const r = stratFn(dataPool);
      if (r && r.signal !== "NEUTRAL" && r.score >= MIN_SCORE) {
        results.push(r);
      }
    } catch (e) {
      // skip strategy on error
    }
  }
  return results;
}

function applyContextBonus(results, marketState) {
  if (!results.length) return results;
  if (!marketState || !marketState.state || marketState.state === "unknown") return results;

  const primary = PRIMARY_BY_STATE[marketState.state] || [];
  if (!primary.length) return results;

  return results.map((r) => {
    const bonus = primary.includes(r.strategy) ? CONTEXT_BONUS_PRIMARY : CONTEXT_BONUS_UNIVERSAL;
    return {
      ...r,
      score: Math.min(r.score + bonus, 100),
      prob: Math.min(r.prob + bonus, 100)
    };
  });
}

export function rankCandidates(results, marketState = null) {
  if (!results.length) return [];

  const scored = applyContextBonus(results, marketState);
  const candidates = [];

  const buildCandidate = (side) => {
    const signals = scored.filter((r) => r.signal === side);
    if (!signals.length) return null;

    const n = signals.length;
    const scoreSum = signals.reduce((a, r) => a + r.score, 0);
    const ensembleBonus = 5 * (n - 1);
    const finalScore = Math.min(100, scoreSum + ensembleBonus);

    const weightSum = signals.reduce((a, r) => a + r.score, 0) || 1;
    const entry = signals.reduce((a, r) => a + (r.entry ?? 0) * r.score, 0) / weightSum;

    const slPrices = signals.map((r) => r.suggestedSlPrice).filter((v) => v != null);
    if (!slPrices.length) return null;
    const sl = side === "LONG" ? Math.min(...slPrices) : Math.max(...slPrices);

    let factors = 0;
    if (signals.some((r) => r.structure)) factors += 0.05;
    if (signals.some((r) => r.rvol != null && r.rvol > 1.5)) factors += 0.05;
    const atr = signals[0]?.atr ?? null;
    if (atr && Math.abs(entry - sl) >= 1.0 * atr) factors += 0.05;
    if (n >= 3) factors += 0.05;

    const probability = Math.min(95, finalScore + factors * 100);
    if (finalScore < MIN_SCORE || probability < MIN_PROB) return null;

    const best = signals.reduce((b, r) => (r.score > b.score ? r : b), signals[0]);

    return {
      direction: side,
      bestStrategy: best.strategy,
      bestSlPrice: sl,
      entry,
      score: Math.round(finalScore),
      probability: Math.round(probability),
      allStrategies: signals.map((r) => ({
        strategy: r.strategy,
        score: r.score,
        prob: r.prob,
        reasons: r.reasons,
        suggestedSlPrice: r.suggestedSlPrice
      }))
    };
  };

  const long = buildCandidate("LONG");
  if (long) candidates.push(long);
  const short = buildCandidate("SHORT");
  if (short) candidates.push(short);

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.probability !== a.probability) return b.probability - a.probability;
    return Math.abs(b.entry - b.bestSlPrice) - Math.abs(a.entry - a.bestSlPrice);
  });
  return candidates;
}

export {
  STRATEGY_LIST, MIN_SCORE, MIN_PROB,
  SWEEP_LOOKBACK, CHOCH_WINDOW, OB_FVG_MIN_ATR,
  FIB_LOW, FIB_HIGH, EMA_TOUCH_TOLERANCE,
  VP_BINS, VP_LOOKBACK, LVN_THRESHOLD,
  CONSOLIDATION_MIN, VOLUME_MULTIPLIER,
  EQH_LOOKBACK, EQH_RECENCY, WICK_MIN_RATIO, EQH_TOLERANCE,
  RSI_WINDOW, PIVOT_LEFT, PIVOT_RIGHT, CONFIRM_CANDLES, PIVOT_ALIGNMENT,
  smcReversal, trendPullback, vpMeanRevert, breakout, liquidityGrab, rsiDivergence
};
