import { calculateRSIArray, calculateEMA, calculateATRArray } from "./indicators.js";

const STRATEGY_LIST = [
  "SMC_Reversal",
  "Trend_Pullback",
  "VP_Mean_Revert",
  "Breakout",
  "Liquidity_Grab",
  "RSI_Divergence"
];

const CLOSED_COUNT = 200;

const MIN_SCORE = 35;
const MIN_PROB = 0.45;
const SESSION_STRICT_MIN_SCORE = 50;
const SESSION_STRICT_MIN_PROB = 0.55;
const ENSEMBLE_BONUS = 15;
const PROB_BASE = 0.40;
const FACTOR_STRUCTURE = 0.05;
const FACTOR_VOLUME = 0.05;
const FACTOR_SL_DISTANCE = 0.05;
const FACTOR_CONFLUENCE = 0.05;
const FACTOR_QUALITY = 0.05;
const RVOL_HIGH_THRESHOLD = 1.5;

const STRATEGY_WEIGHTS = {
  Breakout: 1.2,
  RSI_Divergence: 1.1,
  VP_Mean_Revert: 1.0,
  Trend_Pullback: 0.8,
  SMC_Reversal: 0.6,
  Liquidity_Grab: 0.7
};

const QUALITY_STRATEGIES = ["Breakout", "RSI_Divergence"];

const SWEEP_PRIOR_WINDOW = 20;
const SWEEP_LOOKBACK = 30;
const CHOCH_WINDOW = 10;
const SWEEP_EQUAL_TOLERANCE = 0.0;
const OB_FVG_MIN_ATR = 0.2;

const TREND_PIVOT_WINDOW = 3;
const FIB_LOW = 0.618;
const FIB_HIGH = 0.786;

const VP_BINS = 24;
const VP_LOOKBACK = 120;
const LVN_THRESHOLD = 0.45;
const VP_VALUE_AREA = 0.68;

const CONSOLIDATION_MIN = 20;
const VOLUME_MULTIPLIER = 1.8;
const VOLUME_AVG_WINDOW = 20;
const ATR_SL_THRESHOLD = 1.0;

const EQH_LOOKBACK = 120;
const EQH_RECENCY = 40;
const WICK_MIN_RATIO = 0.50;
const EQH_TOLERANCE = 0.001;

const RSI_WINDOW = 14;
const PIVOT_LEFT = 2;
const PIVOT_RIGHT = 2;
const CONFIRM_CANDLES = 2;
const PIVOT_INDEX_TOLERANCE = 3;

const MIN_SL_DISTANCE_PCT = 1.0;
const MAX_SL_DISTANCE_PCT = 4.0;
const SL_MIN_BUFFER_PCT = 1.1;
const SESSION_BLOCK_HOURS_UTC = [[0, 12]];
const SESSION_STRICT_HOURS_UTC = [[0, 12]];
const MOMENTUM_LOOKBACK_CANDLES = 4;
const MOMENTUM_MAX_ADVERSE_PCT = 0.3;
const MOMENTUM_MAX_ADVERSE_ATR = 0.5;
const VOLATILITY_MAX_ATR_PCT = 0.6;
const RELATIVE_STRENGTH_LOOKBACK_CANDLES = 16;

function lastNonNull(arr) {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v != null && !isNaN(v)) return v;
  }
  return null;
}

function mean(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sliceMin(arr, from, to) {
  let m = Infinity;
  for (let i = from; i < to; i++) if (arr[i] < m) m = arr[i];
  return m;
}

function sliceMax(arr, from, to) {
  let m = -Infinity;
  for (let i = from; i < to; i++) if (arr[i] > m) m = arr[i];
  return m;
}

export function dropFormingCandles(klines, intervalMs = 900000, nowMs = Date.now()) {
  const closed = (klines || []).filter((k) => k[0] + intervalMs <= nowMs);
  return closed.length ? closed : (klines || []);
}

export function buildFrame15m(ohlcv15m) {
  if (!ohlcv15m || ohlcv15m.length < 20) return null;
  const timestamp = ohlcv15m.map((d) => d[0]);
  const open = ohlcv15m.map((d) => d[1]);
  const high = ohlcv15m.map((d) => d[2]);
  const low = ohlcv15m.map((d) => d[3]);
  const close = ohlcv15m.map((d) => d[4]);
  const volume = ohlcv15m.map((d) => d[5]);
  return {
    n: close.length,
    timestamp, open, high, low, close, volume,
    rsi: calculateRSIArray(close, RSI_WINDOW),
    atr: calculateATRArray(high, low, close, 14),
    ema20: calculateEMA(close, 20),
    ema50: calculateEMA(close, 50),
    ema200: calculateEMA(close, 200),
    precio: close[close.length - 1]
  };
}

function detectPivots(values, left, right) {
  const highs = [];
  const lows = [];
  const n = values.length;
  for (let i = left; i < n - right; i++) {
    const v = values[i];
    if (v == null || isNaN(v)) continue;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= left; k++) {
      const pv = values[i - k];
      if (pv == null || isNaN(pv)) { isHigh = false; isLow = false; break; }
      if (!(v >= pv)) isHigh = false;
      if (!(v <= pv)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh || isLow) {
      for (let k = 1; k <= right; k++) {
        const nv = values[i + k];
        if (nv == null || isNaN(nv)) { isHigh = false; isLow = false; break; }
        if (!(v >= nv)) isHigh = false;
        if (!(v <= nv)) isLow = false;
        if (!isHigh && !isLow) break;
      }
    }
    if (isHigh) highs.push([i, v]);
    if (isLow) lows.push([i, v]);
  }
  return { highs, lows };
}

function fibonacciZone(swingLow, swingHigh) {
  const diff = swingHigh - swingLow;
  const f618 = swingHigh - diff * FIB_LOW;
  const f786 = swingHigh - diff * FIB_HIGH;
  return [Math.min(f618, f786), Math.max(f618, f786)];
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function findSweeps(frame) {
  const { high, low } = frame;
  const n = frame.n;
  const start = Math.max(SWEEP_PRIOR_WINDOW, n - SWEEP_LOOKBACK);
  const longSweeps = [];
  const shortSweeps = [];
  for (let i = start; i < n; i++) {
    const priorHigh = sliceMax(high, i - SWEEP_PRIOR_WINDOW, i);
    const priorLow = sliceMin(low, i - SWEEP_PRIOR_WINDOW, i);
    if (low[i] < priorLow * (1.0 - SWEEP_EQUAL_TOLERANCE)) {
      longSweeps.push({ idx: i, price: low[i], priorHigh, priorLow });
    }
    if (high[i] > priorHigh * (1.0 + SWEEP_EQUAL_TOLERANCE)) {
      shortSweeps.push({ idx: i, price: high[i], priorHigh, priorLow });
    }
  }
  return { longSweeps, shortSweeps };
}

function detectChoch(frame, side, sweepIdx, sweepPrice) {
  const n = frame.n;
  if (n < 5) return false;
  const { close, high, low } = frame;
  const end = Math.min(sweepIdx + CHOCH_WINDOW + 1, n);
  const ref = side === "LONG" ? high[sweepIdx] : low[sweepIdx];
  for (let i = sweepIdx + 1; i < end; i++) {
    if (side === "LONG") {
      if (low[i] < sweepPrice) return false;
      if (close[i] > ref) return true;
    } else {
      if (high[i] > sweepPrice) return false;
      if (close[i] < ref) return true;
    }
  }
  return false;
}

function findFvg(frame, side) {
  const { close, high, low, atr } = frame;
  const n = frame.n;
  if (n < 3) return null;
  const atrVal = lastNonNull(atr) ?? 0;
  if (atrVal <= 0) return null;
  const minSize = OB_FVG_MIN_ATR * atrVal;
  const current = close[n - 1];
  for (let i = n - 1; i > 1; i--) {
    if (side === "LONG") {
      const fvgLow = high[i - 2];
      const fvgHigh = low[i];
      if (fvgHigh > fvgLow && fvgHigh - fvgLow >= minSize && current >= fvgLow) {
        return { low: fvgLow, high: fvgHigh, size: fvgHigh - fvgLow };
      }
    } else {
      const fvgHigh = low[i - 2];
      const fvgLow = high[i];
      if (fvgLow < fvgHigh && fvgHigh - fvgLow >= minSize && current <= fvgHigh) {
        return { low: fvgLow, high: fvgHigh, size: fvgHigh - fvgLow };
      }
    }
  }
  return null;
}

function findOb(frame, side) {
  const { close, open, high, low } = frame;
  const n = frame.n;
  if (n < 3) return null;
  const current = close[n - 1];
  for (let i = n - 1; i > Math.max(0, n - 20); i--) {
    if (side === "LONG" && close[i - 1] > open[i - 1] && close[i] < open[i]) {
      const obLow = low[i];
      const obHigh = high[i];
      if (obLow <= current && current <= obHigh) return { low: obLow, high: obHigh };
    }
    if (side === "SHORT" && close[i - 1] < open[i - 1] && close[i] > open[i]) {
      const obLow = low[i];
      const obHigh = high[i];
      if (obLow <= current && current <= obHigh) return { low: obLow, high: obHigh };
    }
  }
  return null;
}

function isObFvgValid(frame, side, ob, fvg) {
  if (!ob && !fvg) return false;
  const atrVal = lastNonNull(frame.atr) ?? 0;
  const n = frame.n;
  const current = frame.close[n - 1];
  const hi = frame.high[n - 1];
  const lo = frame.low[n - 1];
  if (ob) {
    if (side === "LONG" && current > ob.high) return false;
    if (side === "SHORT" && current < ob.low) return false;
    if (side === "LONG" && hi > ob.high + OB_FVG_MIN_ATR * (atrVal || 1)) return false;
    if (side === "SHORT" && lo < ob.low - OB_FVG_MIN_ATR * (atrVal || 1)) return false;
  }
  if (fvg) {
    if (side === "LONG" && current < fvg.low) return false;
    if (side === "SHORT" && current > fvg.high) return false;
  }
  return true;
}

function smcReversal(frame) {
  if (!frame || frame.n < CLOSED_COUNT) return [];
  const n = frame.n;
  const atrVal = lastNonNull(frame.atr) ?? 0;
  const { longSweeps, shortSweeps } = findSweeps(frame);
  const out = [];

  const emit = (side, sweeps) => {
    if (!sweeps.length) return;
    const ob = findOb(frame, side);
    const fvg = findFvg(frame, side);
    if (!isObFvgValid(frame, side, ob, fvg)) return;
    for (let s = sweeps.length - 1; s >= 0; s--) {
      const sweep = sweeps[s];
      if (!detectChoch(frame, side, sweep.idx, sweep.price)) continue;
      const entry = frame.close[n - 1];
      const sl = side === "LONG"
        ? Math.min(sweep.price, sliceMin(frame.low, n - 3, n)) - 0.25 * atrVal
        : Math.max(sweep.price, sliceMax(frame.high, n - 3, n)) + 0.25 * atrVal;
      let score = 25;
      let prob = 0.30;
      const reasons = [`Sweep ${side === "LONG" ? "de mínimos" : "de máximos"} (${sweep.price.toFixed(8)}) + CHoCH`];
      if (ob) {
        score += 10;
        prob += 0.05;
        reasons.push(`OB no mitigado (${ob.low.toFixed(8)}-${ob.high.toFixed(8)})`);
      }
      if (fvg) {
        score += 15;
        prob += 0.10;
        reasons.push(`FVG no mitigado (${fvg.size.toFixed(8)})`);
      }
      out.push({
        strategy: "SMC_Reversal",
        signal: side,
        score,
        prob: Math.min(0.95, prob),
        entry,
        suggestedSlPrice: sl,
        atr: atrVal,
        targetPrice: null,
        reasons,
        details: {
          sweep_price: sweep.price,
          choch: true,
          ob,
          fvg,
          atr: atrVal,
          structure_quality: "ob_fvg_zone"
        }
      });
      break;
    }
  };

  emit("LONG", longSweeps);
  emit("SHORT", shortSweeps);
  return out;
}

function inFibZone(frame, side) {
  const { close, high, low } = frame;
  const n = frame.n;
  const price = close[n - 1];
  const hp = detectPivots(high, TREND_PIVOT_WINDOW, TREND_PIVOT_WINDOW);
  const lp = detectPivots(low, TREND_PIVOT_WINDOW, TREND_PIVOT_WINDOW);
  if (!hp.highs.length || !lp.lows.length) return false;
  if (side === "LONG") {
    const [highIdx, lastHigh] = hp.highs[hp.highs.length - 1];
    const priorLows = lp.lows.filter((p) => p[0] < highIdx);
    if (!priorLows.length) return false;
    const lastLow = priorLows[priorLows.length - 1][1];
    if (!(lastHigh > lastLow)) return false;
    const [zoneLo, zoneHi] = fibonacciZone(lastLow, lastHigh);
    return price >= zoneLo && price <= zoneHi;
  }
  const [lowIdx, lastLow] = lp.lows[lp.lows.length - 1];
  const priorHighs = hp.highs.filter((p) => p[0] < lowIdx);
  if (!priorHighs.length) return false;
  const lastHigh = priorHighs[priorHighs.length - 1][1];
  if (!(lastHigh > lastLow)) return false;
  const [zoneLo, zoneHi] = fibonacciZone(lastLow, lastHigh);
  return price >= zoneLo && price <= zoneHi;
}

function nearEmaZone(frame) {
  const n = frame.n;
  const { ema20, ema50, high, low } = frame;
  if (ema20 == null || ema50 == null) return false;
  const zoneLow = Math.min(ema20, ema50);
  const zoneHigh = Math.max(ema20, ema50);
  return low[n - 1] <= zoneHigh && high[n - 1] >= zoneLow;
}

function rejectionCandle(frame, side) {
  const n = frame.n;
  const o = frame.open[n - 1];
  const c = frame.close[n - 1];
  const h = frame.high[n - 1];
  const l = frame.low[n - 1];
  const range = h - l;
  if (range <= 0) return false;
  if (side === "LONG") {
    const lowerWick = Math.min(o, c) - l;
    return lowerWick / range >= 0.5 && c > o;
  }
  const upperWick = h - Math.max(o, c);
  return upperWick / range >= 0.5 && c < o;
}

function trendPullback(frame) {
  if (!frame || frame.n < CLOSED_COUNT) return [];
  const n = frame.n;
  const { close, high, low, ema20, ema50, ema200 } = frame;
  if (ema20 == null || ema50 == null || ema200 == null) return [];
  const price = close[n - 1];
  const atrVal = lastNonNull(frame.atr) ?? 0;
  const out = [];

  const emit = (side) => {
    const trendUp = ema20 > ema50 && ema50 > ema200 && price > ema20;
    const trendDown = ema20 < ema50 && ema50 < ema200 && price < ema20;
    if (side === "LONG" && !trendUp) return;
    if (side === "SHORT" && !trendDown) return;
    const inFib = inFibZone(frame, side);
    const nearEma = nearEmaZone(frame);
    if (!(inFib || nearEma)) return;
    const rejection = rejectionCandle(frame, side);
    if (!rejection) return;
    const entry = price;
    const sl = side === "LONG"
      ? sliceMin(low, n - 8, n) - 1.0 * atrVal
      : sliceMax(high, n - 8, n) + 1.0 * atrVal;
    let score = 25;
    let prob = 0.30;
    const reasons = [`Tendencia ${side === "LONG" ? "alcista" : "bajista"} EMA20/50/200 (15m) + pullback`];
    if (inFib && nearEma) {
      prob += 0.05;
      reasons.push("Zona Fib 0.618-0.786 + zona EMA20/50");
    } else if (inFib) {
      reasons.push("Retroceso Fib 0.618-0.786");
    } else {
      reasons.push("Precio en zona EMA20/50");
    }
    reasons.push("Vela de rechazo (mecha >= 50%)");
    out.push({
      strategy: "Trend_Pullback",
      signal: side,
      score,
      prob: Math.min(0.95, prob),
      entry,
      suggestedSlPrice: sl,
      atr: atrVal,
      targetPrice: null,
      reasons,
      details: {
        in_fib: inFib,
        near_ema: nearEma,
        rejection,
        atr: atrVal,
        structure_quality: "swing_zone"
      }
    });
  };

  emit("LONG");
  emit("SHORT");
  return out;
}

function volumeProfile24(high, low, volume) {
  const allPrices = [];
  const allVolumes = [];
  for (let i = 0; i < high.length; i++) {
    const lo = low[i];
    const hi = high[i];
    const vol = volume[i];
    if (!(vol > 0) || !(hi > lo)) continue;
    const step = (hi - lo) / VP_BINS;
    for (let b = 0; b < VP_BINS; b++) {
      allPrices.push(lo + step * (b + 0.5));
      allVolumes.push(vol / VP_BINS);
    }
  }
  if (allPrices.length < 10) return null;
  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const p of allPrices) {
    if (p < priceMin) priceMin = p;
    if (p > priceMax) priceMax = p;
  }
  if (!(priceMax > priceMin)) return null;

  const binEdges = [];
  for (let b = 0; b <= VP_BINS; b++) {
    binEdges.push(priceMin + ((priceMax - priceMin) * b) / VP_BINS);
  }
  const binVolumes = new Array(VP_BINS).fill(0);
  for (let k = 0; k < allPrices.length; k++) {
    const p = allPrices[k];
    for (let b = 0; b < VP_BINS; b++) {
      if (p >= binEdges[b] && p < binEdges[b + 1]) {
        binVolumes[b] += allVolumes[k];
        break;
      }
    }
  }

  let pocIdx = 0;
  for (let b = 1; b < VP_BINS; b++) {
    if (binVolumes[b] > binVolumes[pocIdx]) pocIdx = b;
  }
  const poc = (binEdges[pocIdx] + binEdges[pocIdx + 1]) / 2;

  const order = binVolumes.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || b.i - a.i).map((x) => x.i).reverse();
  const totalVol = binVolumes.reduce((a, b) => a + b, 0);
  if (!(totalVol > 0)) return null;
  const areaPrices = [];
  let acc = 0;
  for (const idx of order) {
    acc += binVolumes[idx];
    areaPrices.push((binEdges[idx] + binEdges[idx + 1]) / 2);
    if (acc / totalVol >= VP_VALUE_AREA) break;
  }
  if (!areaPrices.length) return null;

  const vah = percentile(areaPrices, 90);
  const val = percentile(areaPrices, 10);
  const avgVol = mean(binVolumes);
  return { poc, vah, val, avgVol, binVolumes, binEdges };
}

function binIndexOf(binEdges, price) {
  let cnt = 0;
  for (const e of binEdges) {
    if (e <= price) cnt++;
    else break;
  }
  return Math.max(0, Math.min(cnt - 1, binEdges.length - 2));
}

function vpMeanRevert(frame) {
  if (!frame || frame.n < CLOSED_COUNT) return [];
  const n = frame.n;
  const start = Math.max(0, n - VP_LOOKBACK);
  const vp = volumeProfile24(
    frame.high.slice(start),
    frame.low.slice(start),
    frame.volume.slice(start)
  );
  if (!vp) return [];
  const close = frame.close[n - 1];
  const atrVal = lastNonNull(frame.atr) ?? 0;
  const binIdx = binIndexOf(vp.binEdges, close);
  const currentBinVol = vp.binVolumes[binIdx] ?? 0;
  const isLvn = vp.avgVol > 0 && currentBinVol < vp.avgVol * LVN_THRESHOLD;
  const volSlice = frame.volume.slice(Math.max(0, n - 20));
  const rvol = n >= 20 && mean(volSlice) > 0 ? frame.volume[n - 1] / mean(volSlice) : 1.0;
  const out = [];

  const emit = (side) => {
    const outsideBelow = close < vp.val;
    const outsideAbove = close > vp.vah;
    if (side === "LONG" && !(outsideBelow && isLvn && atrVal > 0)) return;
    if (side === "SHORT" && !(outsideAbove && isLvn && atrVal > 0)) return;
    const minBuffer = Math.max(1.0 * atrVal, (close * SL_MIN_BUFFER_PCT) / 100.0);
    const sl = side === "LONG"
      ? Math.min(close, vp.val) - minBuffer
      : Math.max(close, vp.vah) + minBuffer;
    const reasons = [
      `Precio ${side === "LONG" ? `bajo VAL (${vp.val.toFixed(8)})` : `sobre VAH (${vp.vah.toFixed(8)})`} + LVN`
    ];
    out.push({
      strategy: "VP_Mean_Revert",
      signal: side,
      score: 25,
      prob: 0.30,
      entry: close,
      suggestedSlPrice: sl,
      atr: atrVal,
      targetPrice: vp.poc,
      reasons,
      details: {
        poc: vp.poc,
        vah: vp.vah,
        val: vp.val,
        outside: side === "LONG" ? "below" : "above",
        lvn: isLvn,
        atr: atrVal,
        rvol,
        structure_quality: "vp_zone"
      }
    });
  };

  emit("LONG");
  emit("SHORT");
  return out;
}

function breakout(frame) {
  if (!frame || frame.n < CLOSED_COUNT) return [];
  const n = frame.n;
  const { high, low, close, open, volume } = frame;
  const atrVal = lastNonNull(frame.atr.slice(0, n - 1)) ?? 0;

  const rangeHigh = sliceMax(high, n - 1 - CONSOLIDATION_MIN, n - 1);
  const rangeLow = sliceMin(low, n - 1 - CONSOLIDATION_MIN, n - 1);
  const rangeMid = (rangeHigh + rangeLow) / 2;

  const volFrom = n - 2 - VOLUME_AVG_WINDOW;
  const volTo = n - 2;
  if (volFrom < 0) return [];
  const avgVol = mean(volume.slice(volFrom, volTo));
  const trigger = n - 1;
  const rvol = avgVol > 0 ? volume[trigger] / avgVol : 0;
  const volOk = rvol >= VOLUME_MULTIPLIER;

  const entry = close[trigger];
  const out = [];

  const slFor = (side) => {
    const broken = side === "LONG" ? rangeHigh : rangeLow;
    const dist = Math.abs(entry - broken);
    if (side === "LONG") {
      return dist >= ATR_SL_THRESHOLD * atrVal ? broken - 0.25 * atrVal : rangeMid - 0.25 * atrVal;
    }
    return dist >= ATR_SL_THRESHOLD * atrVal ? broken + 0.25 * atrVal : rangeMid + 0.25 * atrVal;
  };

  const emit = (side) => {
    const brokenOut = side === "LONG" ? entry > rangeHigh : entry < rangeLow;
    if (!brokenOut || !volOk) return;
    let prob = 0.30;
    const reasons = [
      `Breakout ${side === "LONG" ? "alcista" : "bajista"} (${entry.toFixed(8)}) ${side === "LONG" ? ">" : "<"} rango (${(side === "LONG" ? rangeHigh : rangeLow).toFixed(8)})`,
      `Volumen ${rvol.toFixed(1)}x media`
    ];
    if (rvol >= 2.0) {
      prob += 0.05;
      reasons.push("Volumen >= 2x");
    }
    out.push({
      strategy: "Breakout",
      signal: side,
      score: 35,
      prob: Math.min(0.95, prob),
      entry,
      suggestedSlPrice: slFor(side),
      atr: atrVal,
      targetPrice: null,
      reasons,
      details: {
        range_high: rangeHigh,
        range_low: rangeLow,
        rvol,
        atr: atrVal,
        structure_quality: "vp_zone"
      }
    });
  };

  emit("LONG");
  emit("SHORT");
  return out;
}

function findEqualLevels(values, tolerance) {
  const levels = [];
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[i] > 0 && Math.abs(values[j] - values[i]) / values[i] < tolerance) {
        levels.push(values[i]);
      }
    }
  }
  return levels;
}

function wickRatio(frame, side) {
  const n = frame.n;
  const o = frame.open[n - 1];
  const c = frame.close[n - 1];
  const h = frame.high[n - 1];
  const l = frame.low[n - 1];
  const range = h - l;
  if (range <= 0) return 0;
  return side === "LONG"
    ? (Math.min(o, c) - l) / range
    : (h - Math.max(o, c)) / range;
}

function liquidityGrab(frame) {
  if (!frame || frame.n < CLOSED_COUNT) return [];
  const n = frame.n;
  const baseEnd = n - 1;
  const atrVal = lastNonNull(frame.atr.slice(0, baseEnd)) ?? 0;

  const recStart = Math.max(0, baseEnd - EQH_RECENCY);
  const recHighs = frame.high.slice(recStart, baseEnd);
  const recLows = frame.low.slice(recStart, baseEnd);
  const eqhs = findEqualLevels(recHighs, EQH_TOLERANCE);
  const eqls = findEqualLevels(recLows, EQH_TOLERANCE);
  if (!eqhs.length && !eqls.length) return [];

  const trigger = n - 1;
  const entry = frame.close[trigger];
  const out = [];

  const emitLong = () => {
    for (const eql of eqls) {
      if (frame.low[trigger] < eql && frame.close[trigger] > eql) {
        const wick = wickRatio(frame, "LONG");
        if (wick >= WICK_MIN_RATIO) {
          const sweepLow = frame.low[trigger];
          const recentLow = sliceMin(frame.low, baseEnd - 3, baseEnd);
          const minBuffer = Math.max(1.0 * atrVal, (entry * SL_MIN_BUFFER_PCT) / 100.0);
          const sl = Math.min(Math.min(sweepLow, recentLow) - 0.25 * atrVal, entry - minBuffer);
          out.push({
            strategy: "Liquidity_Grab",
            signal: "LONG",
            score: 25,
            prob: 0.30,
            entry,
            suggestedSlPrice: sl,
            atr: atrVal,
            targetPrice: null,
            reasons: [`Liquidity grab EQL (${eql.toFixed(8)}) con rechazo ${wick.toFixed(2)}`],
            details: { eq_level: eql, wick_ratio: wick, atr: atrVal, structure_quality: "swing_zone" }
          });
          break;
        }
      }
    }
  };

  const emitShort = () => {
    for (const eqh of eqhs) {
      if (frame.high[trigger] > eqh && frame.close[trigger] < eqh) {
        const wick = wickRatio(frame, "SHORT");
        if (wick >= WICK_MIN_RATIO) {
          const sweepHigh = frame.high[trigger];
          const recentHigh = sliceMax(frame.high, baseEnd - 3, baseEnd);
          const minBuffer = Math.max(1.0 * atrVal, (entry * SL_MIN_BUFFER_PCT) / 100.0);
          const sl = Math.max(Math.max(sweepHigh, recentHigh) + 0.25 * atrVal, entry + minBuffer);
          out.push({
            strategy: "Liquidity_Grab",
            signal: "SHORT",
            score: 25,
            prob: 0.30,
            entry,
            suggestedSlPrice: sl,
            atr: atrVal,
            targetPrice: null,
            reasons: [`Liquidity grab EQH (${eqh.toFixed(8)}) con rechazo ${wick.toFixed(2)}`],
            details: { eq_level: eqh, wick_ratio: wick, atr: atrVal, structure_quality: "swing_zone" }
          });
          break;
        }
      }
    }
  };

  emitLong();
  emitShort();
  return out;
}

function alignedPivot(pivots, targetIdx) {
  if (!pivots.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of pivots) {
    const d = Math.abs(p[0] - targetIdx);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return bestDist <= PIVOT_INDEX_TOLERANCE ? best : null;
}

function rsiDivergence(frame) {
  if (!frame || frame.n < CLOSED_COUNT) return [];
  const n = frame.n;
  const { close, high, low, rsi, atr } = frame;
  const priceHighs = detectPivots(high, PIVOT_LEFT, PIVOT_RIGHT).highs;
  const priceLows = detectPivots(low, PIVOT_LEFT, PIVOT_RIGHT).lows;
  const rsiPivots = detectPivots(rsi, PIVOT_LEFT, PIVOT_RIGHT);
  const atrVal = lastNonNull(atr) ?? 0;
  const lastIdx = n - 1;
  const out = [];

  if (priceLows.length >= 2) {
    const [aIdx, aPrice] = priceLows[priceLows.length - 2];
    const [bIdx, bPrice] = priceLows[priceLows.length - 1];
    const hl1 = alignedPivot(rsiPivots.lows, aIdx);
    const hl2 = alignedPivot(rsiPivots.lows, bIdx);
    const confirmIdx = bIdx + CONFIRM_CANDLES;
    const fresh = lastIdx - confirmIdx >= 0 && lastIdx - confirmIdx <= CONFIRM_CANDLES;
    if (hl1 && hl2 && fresh && bPrice < aPrice && hl2[1] > hl1[1]) {
      const entry = close[lastIdx];
      const sl = sliceMin(low, n - 8, n) - 1.0 * atrVal;
      out.push({
        strategy: "RSI_Divergence",
        signal: "LONG",
        score: 35,
        prob: 0.30,
        entry,
        suggestedSlPrice: sl,
        atr: atrVal,
        targetPrice: null,
        reasons: ["Divergencia regular alcista (LL precio + HL RSI)"],
        details: {
          pivot_price_ll: bPrice,
          pivot_rsi_hl: hl2[1],
          atr: atrVal,
          structure_quality: "swing_zone"
        }
      });
    }
  }

  if (priceHighs.length >= 2) {
    const [aIdx, aPrice] = priceHighs[priceHighs.length - 2];
    const [bIdx, bPrice] = priceHighs[priceHighs.length - 1];
    const lh1 = alignedPivot(rsiPivots.highs, aIdx);
    const lh2 = alignedPivot(rsiPivots.highs, bIdx);
    const confirmIdx = bIdx + CONFIRM_CANDLES;
    const fresh = lastIdx - confirmIdx >= 0 && lastIdx - confirmIdx <= CONFIRM_CANDLES;
    if (lh1 && lh2 && fresh && bPrice > aPrice && lh2[1] < lh1[1]) {
      const entry = close[lastIdx];
      const sl = sliceMax(high, n - 8, n) + 1.0 * atrVal;
      out.push({
        strategy: "RSI_Divergence",
        signal: "SHORT",
        score: 35,
        prob: 0.30,
        entry,
        suggestedSlPrice: sl,
        atr: atrVal,
        targetPrice: null,
        reasons: ["Divergencia regular bajista (HH precio + LH RSI)"],
        details: {
          pivot_price_hh: bPrice,
          pivot_rsi_lh: lh2[1],
          atr: atrVal,
          structure_quality: "swing_zone"
        }
      });
    }
  }

  return out;
}

const ALL_STRATEGIES = [
  smcReversal,
  trendPullback,
  vpMeanRevert,
  breakout,
  liquidityGrab,
  rsiDivergence
];

export function evaluateStrategies(frame) {
  if (!frame || frame.n < CLOSED_COUNT) return [];
  const results = [];
  for (const stratFn of ALL_STRATEGIES) {
    try {
      const signals = stratFn(frame);
      for (const s of signals || []) {
        if (s && s.signal !== "NEUTRAL") results.push(s);
      }
    } catch (e) {
      // skip strategy on error
    }
  }
  return results;
}

function inHours(hour, ranges) {
  for (const rng of ranges || []) {
    const [lo, hi] = rng;
    if (hour >= lo && hour < hi) return true;
  }
  return false;
}

export function effectiveThresholds(hourUtc = null) {
  const hour = hourUtc == null ? new Date().getUTCHours() : hourUtc;
  if (inHours(hour, SESSION_STRICT_HOURS_UTC)) {
    return [SESSION_STRICT_MIN_SCORE, SESSION_STRICT_MIN_PROB, true];
  }
  return [MIN_SCORE, MIN_PROB, false];
}

export function isWeekendPause(now = new Date()) {
  let dayIdx;
  let hour;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      weekday: "short",
      hour: "numeric",
      hour12: false
    }).formatToParts(now);
    const wd = parts.find((p) => p.type === "weekday")?.value;
    hour = parseInt(parts.find((p) => p.type === "hour")?.value, 10);
    dayIdx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
  } catch (e) {
    dayIdx = now.getUTCDay();
    hour = now.getUTCHours();
  }
  if (isNaN(hour)) return false;
  if (dayIdx === 5 && hour >= 20) return true;
  if (dayIdx === 6) return true;
  if (dayIdx === 0 && hour < 7) return true;
  return false;
}

function weightFor(name) {
  const w = STRATEGY_WEIGHTS[name];
  return typeof w === "number" && !isNaN(w) ? w : 1.0;
}

function bestSignalOf(signals) {
  return signals.reduce((b, s) => (s.score > b.score ? s : b), signals[0]);
}

function ensembleScore(signals) {
  let base = 0;
  for (const s of signals) base += s.score * weightFor(s.strategy);
  return base + ENSEMBLE_BONUS * (signals.length - 1);
}

function ensembleProbability(signals, entry, sl) {
  let prob = PROB_BASE;
  const best = bestSignalOf(signals);
  const details = best.details || {};
  const structure = details.structure_quality;
  if (structure === "vp_zone" || structure === "swing_zone" || structure === "ob_fvg_zone") {
    prob += FACTOR_STRUCTURE;
  }
  const rvol = details.rvol ?? 0;
  if (rvol > RVOL_HIGH_THRESHOLD) prob += FACTOR_VOLUME;
  let slDistAtr = details.sl_dist_atr || 0;
  if (!slDistAtr) {
    const atr = parseFloat(details.atr) || 0;
    if (atr > 0 && entry > 0) slDistAtr = Math.abs(entry - sl) / atr;
  }
  if (slDistAtr >= 1.0) prob += FACTOR_SL_DISTANCE;
  if (signals.length >= 3) prob += FACTOR_CONFLUENCE;
  const names = new Set(signals.map((s) => s.strategy));
  if (QUALITY_STRATEGIES.some((q) => names.has(q))) prob += FACTOR_QUALITY;
  return Math.max(0, Math.min(0.95, prob));
}

function buildCandidate(side, signals, hourUtc) {
  const entry = mean(signals.map((s) => s.entry));
  const sls = signals.map((s) => s.suggestedSlPrice).filter((v) => v != null);
  if (!sls.length || !(entry > 0)) return null;
  const sl = side === "LONG" ? Math.min(...sls) : Math.max(...sls);
  const score = ensembleScore(signals);
  const probability = ensembleProbability(signals, entry, sl);
  const [minScore, minProb] = effectiveThresholds(hourUtc);
  if (score < minScore || probability < minProb) return null;
  const slDistPct = (Math.abs(entry - sl) / entry) * 100;
  if (slDistPct < MIN_SL_DISTANCE_PCT || slDistPct > MAX_SL_DISTANCE_PCT) return null;
  const best = bestSignalOf(signals);
  return {
    direction: side,
    bestStrategy: best.strategy,
    bestSlPrice: sl,
    entry,
    targetPrice: best.targetPrice ?? null,
    score,
    probability,
    slDistPct,
    allStrategies: signals.map((s) => ({
      strategy: s.strategy,
      signal: s.signal,
      score: s.score,
      prob: s.prob,
      weight: weightFor(s.strategy),
      reasons: s.reasons || [],
      suggestedSlPrice: s.suggestedSlPrice,
      details: s.details || {}
    }))
  };
}

export function rankCandidates(results, hourUtc = null) {
  if (!results || !results.length) return [];
  const groups = { LONG: [], SHORT: [] };
  for (const r of results) {
    if (r.signal === "LONG") groups.LONG.push(r);
    else if (r.signal === "SHORT") groups.SHORT.push(r);
  }
  const candidates = [];
  for (const side of ["LONG", "SHORT"]) {
    if (!groups[side].length) continue;
    const cand = buildCandidate(side, groups[side], hourUtc);
    if (cand) candidates.push(cand);
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.probability !== a.probability) return b.probability - a.probability;
    return b.slDistPct - a.slDistPct;
  });
  return candidates;
}

export function applyEntryFilters(candidates, ctx = {}) {
  const notes = [];
  let kept = [...candidates];

  const qualitySet = new Set(QUALITY_STRATEGIES);
  const beforeQuality = kept;
  kept = kept.filter((c) => c.allStrategies.some((s) => qualitySet.has(s.strategy)));
  for (const c of beforeQuality) {
    if (!kept.includes(c)) {
      notes.push(`${c.direction} sin estrategia de calidad (${c.allStrategies.map((s) => s.strategy).join(", ")})`);
    }
  }
  if (!kept.length) return { kept, notes };

  if (ctx.pairReturnPct != null) {
    kept = kept.filter((c) => {
      let ok;
      if (ctx.isBtcQuote) {
        ok = c.direction === "LONG" ? ctx.pairReturnPct >= 0 : ctx.pairReturnPct <= 0;
      } else {
        if (ctx.refReturnPct == null) return true;
        const diff = ctx.pairReturnPct - ctx.refReturnPct;
        ok = c.direction === "LONG" ? diff >= 0 : diff <= 0;
      }
      if (!ok) {
        notes.push(`${c.direction} va en contra del mercado (retorno 4h ${ctx.pairReturnPct.toFixed(2)}%)`);
      }
      return ok;
    });
    if (!kept.length) return { kept, notes };
  }

  if (ctx.atrPct != null && ctx.atrPct > VOLATILITY_MAX_ATR_PCT) {
    notes.push(`ATR 15m ${ctx.atrPct.toFixed(2)}% > máximo ${VOLATILITY_MAX_ATR_PCT}%`);
    return { kept: [], notes };
  }

  const hour = ctx.hourUtc == null ? new Date().getUTCHours() : ctx.hourUtc;
  if (inHours(hour, SESSION_BLOCK_HOURS_UTC)) {
    notes.push(`franja ${String(hour).padStart(2, "0")} UTC bloqueada (00-12 UTC)`);
    return { kept: [], notes };
  }

  if (ctx.recentMovePct != null) {
    kept = kept.filter((c) => {
      const adverse = c.direction === "LONG" ? -ctx.recentMovePct : ctx.recentMovePct;
      const adverseAtr = ctx.atrPct ? adverse / ctx.atrPct : null;
      const against = adverse > MOMENTUM_MAX_ADVERSE_PCT
        || (adverseAtr != null && adverseAtr > MOMENTUM_MAX_ADVERSE_ATR);
      if (against) {
        const det = `${adverse.toFixed(2)}%${adverseAtr != null ? ` (${adverseAtr.toFixed(2)}xATR)` : ""}`;
        notes.push(`${c.direction} movimiento en contra ${det} en ${MOMENTUM_LOOKBACK_CANDLES} velas 15m`);
      }
      return !against;
    });
  }

  return { kept, notes };
}

export {
  STRATEGY_LIST, MIN_SCORE, MIN_PROB, ENSEMBLE_BONUS, PROB_BASE,
  STRATEGY_WEIGHTS, QUALITY_STRATEGIES, CLOSED_COUNT,
  SESSION_STRICT_MIN_SCORE, SESSION_STRICT_MIN_PROB,
  MIN_SL_DISTANCE_PCT, MAX_SL_DISTANCE_PCT, SL_MIN_BUFFER_PCT,
  VOLATILITY_MAX_ATR_PCT, MOMENTUM_LOOKBACK_CANDLES, MOMENTUM_MAX_ADVERSE_PCT,
  MOMENTUM_MAX_ADVERSE_ATR, RELATIVE_STRENGTH_LOOKBACK_CANDLES,
  SWEEP_PRIOR_WINDOW, SWEEP_LOOKBACK, CHOCH_WINDOW, OB_FVG_MIN_ATR,
  VP_BINS, VP_LOOKBACK, LVN_THRESHOLD,
  CONSOLIDATION_MIN, VOLUME_MULTIPLIER, ATR_SL_THRESHOLD,
  EQH_LOOKBACK, EQH_RECENCY, WICK_MIN_RATIO, EQH_TOLERANCE,
  RSI_WINDOW, PIVOT_LEFT, PIVOT_RIGHT, CONFIRM_CANDLES, PIVOT_INDEX_TOLERANCE,
  detectPivots,
  smcReversal,
  trendPullback,
  vpMeanRevert,
  breakout,
  liquidityGrab,
  rsiDivergence
};
