import {
  calculateBB, calculateRSI, calculateATR, calculateADX,
  calculateEMA, calculateMACD, calculatePivots, calculatePivotsArray,
  calculateVolumeProfile, calculateSellBuyRate
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

export function buildIndicatorPool(ohlcv30m, ohlcv5m) {
  const extract = (data, idx) => data.map((d) => d[idx]);
  const result = {};

  if (ohlcv30m && ohlcv30m.length >= 20) {
    const o = extract(ohlcv30m, 1), h = extract(ohlcv30m, 2),
          l = extract(ohlcv30m, 3), c = extract(ohlcv30m, 4), v = extract(ohlcv30m, 5);
    result.p30 = {
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
      vp: calculateVolumeProfile(ohlcv30m),
      volAvg: v.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, v.length),
      lastVol: v[v.length - 1]
    };
  }

  if (ohlcv5m && ohlcv5m.length >= 20) {
    const o = extract(ohlcv5m, 1), h = extract(ohlcv5m, 2),
          l = extract(ohlcv5m, 3), c = extract(ohlcv5m, 4), v = extract(ohlcv5m, 5);
    result.p5 = {
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
      volAvg: v.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, v.length),
      lastVol: v[v.length - 1]
    };
  }

  return result;
}

function smcReversal(pool) {
  const p30 = pool.p30, p5 = pool.p5;
  if (!p30 || !p5) return null;

  const { lastHigh, lastLow } = calculatePivots(p30.high, p30.low, 3);
  if (lastHigh == null && lastLow == null) return null;

  const nearPivotHigh = lastHigh && Math.abs(p30.precio - lastHigh) / lastHigh < 0.005;
  const nearPivotLow = lastLow && Math.abs(p30.precio - lastLow) / lastLow < 0.005;
  const ema200 = p30.ema200;
  const rsi5 = p5.rsi;
  const adx5 = p5.adx?.adx;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  if (nearPivotLow && rsi5 != null && rsi5 < 45 && ema200 && p30.precio > ema200 * 0.97) {
    signal = "LONG";
    score = 60;
    prob = 45;
    reasons.push("Reversal en pivot bajo + RSI bajo + precio sobre EMA200");
    if (p5.bb && p5.precio < p5.bb.lower) { score += 10; prob += 7; reasons.push("Bajo BB 5m"); }
    if (rsi5 < 35) { score += 10; prob += 8; reasons.push("RSI extremo"); }
    if (adx5 != null && adx5 < 25) { score += 10; prob += 7; reasons.push("ADX bajo (rango)"); }
    if (p5.macd && p5.macd.histogram > 0) { score += 10; prob += 5; reasons.push("MACD histogram positivo"); }
  } else if (nearPivotHigh && rsi5 != null && rsi5 > 55 && ema200 && p30.precio < ema200 * 1.03) {
    signal = "SHORT";
    score = 60;
    prob = 45;
    reasons.push("Reversal en pivot alto + RSI alto + precio bajo EMA200");
    if (p5.bb && p5.precio > p5.bb.upper) { score += 10; prob += 7; reasons.push("Sobre BB 5m"); }
    if (rsi5 > 65) { score += 10; prob += 8; reasons.push("RSI extremo"); }
    if (adx5 != null && adx5 < 25) { score += 10; prob += 7; reasons.push("ADX bajo (rango)"); }
    if (p5.macd && p5.macd.histogram < 0) { score += 10; prob += 5; reasons.push("MACD histogram negativo"); }
  }

  return { strategy: "SMC_Reversal", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function trendPullback(pool) {
  const p30 = pool.p30, p5 = pool.p5;
  if (!p30 || !p5) return null;

  const adx30 = p30.adx?.adx;
  const diP30 = p30.adx?.diPlus;
  const diM30 = p30.adx?.diMinus;
  if (adx30 == null || diP30 == null || diM30 == null) return null;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  const emaOrdered = p30.ema20 && p30.ema50 && p30.ema200;
  const trending = adx30 > 25;

  if (trending && emaOrdered) {
    const bullishOrder = p30.ema20 > p30.ema50 && p30.ema50 > p30.ema200;
    const bearishOrder = p30.ema20 < p30.ema50 && p30.ema50 < p30.ema200;

    if (bullishOrder && diP30 > diM30) {
      const distToEma = Math.abs(p30.precio - p30.ema20) / p30.precio;
      if (distToEma < 0.015) {
        signal = "LONG";
        score = 60;
        prob = 48;
        reasons.push("Tendencia alcista + pullback a EMA20");
        if (adx30 > 30) { score += 10; prob += 8; reasons.push(`ADX fuerte (${adx30})`); }
        if (p5.rsi && p5.rsi > 45 && p5.rsi < 60) { score += 10; prob += 7; reasons.push("RSI 5m neutral-alcista"); }
        if (p5.bb && p5.precio <= p5.bb.middle * 1.005) { score += 10; prob += 5; reasons.push("Precio cerca de BB middle 5m"); }
      }
    } else if (bearishOrder && diM30 > diP30) {
      const distToEma = Math.abs(p30.precio - p30.ema20) / p30.precio;
      if (distToEma < 0.015) {
        signal = "SHORT";
        score = 60;
        prob = 48;
        reasons.push("Tendencia bajista + rebote a EMA20");
        if (adx30 > 30) { score += 10; prob += 8; reasons.push(`ADX fuerte (${adx30})`); }
        if (p5.rsi && p5.rsi > 40 && p5.rsi < 55) { score += 10; prob += 7; reasons.push("RSI 5m neutral-bajista"); }
        if (p5.bb && p5.precio >= p5.bb.middle * 0.995) { score += 10; prob += 5; reasons.push("Precio cerca de BB middle 5m"); }
      }
    }
  }

  return { strategy: "Trend_Pullback", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function vpMeanRevert(pool) {
  const p30 = pool.p30, p5 = pool.p5;
  if (!p30 || !p5 || !p30.vp) return null;

  const { poc, vah, val } = p30.vp;
  const rsi5 = p5.rsi;
  const bb5 = p5.bb;
  if (!rsi5 || !bb5) return null;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  const distToPoc = (p30.precio - poc) / p30.precio;

  if (p30.precio < val && distToPoc < -0.01) {
    signal = "LONG";
    score = 60;
    prob = 45;
    reasons.push(`Precio (${p30.precio.toFixed(8)}) bajo VAL (${val.toFixed(8)})`);
    if (rsi5 < 40) { score += 10; prob += 8; reasons.push("RSI 5m sobrevendido"); }
    if (p5.precio < bb5.lower) { score += 10; prob += 7; reasons.push("Bajo BB 5m"); }
    if (p5.adx?.adx != null && p5.adx.adx < 20) { score += 10; prob += 5; reasons.push("ADX bajo (rango)"); }
  } else if (p30.precio > vah && distToPoc > 0.01) {
    signal = "SHORT";
    score = 60;
    prob = 45;
    reasons.push(`Precio (${p30.precio.toFixed(8)}) sobre VAH (${vah.toFixed(8)})`);
    if (rsi5 > 60) { score += 10; prob += 8; reasons.push("RSI 5m sobrecomprado"); }
    if (p5.precio > bb5.upper) { score += 10; prob += 7; reasons.push("Sobre BB 5m"); }
    if (p5.adx?.adx != null && p5.adx.adx < 20) { score += 10; prob += 5; reasons.push("ADX bajo (rango)"); }
  }

  return { strategy: "VP_Mean_Revert", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function breakout(pool) {
  const p30 = pool.p30, p5 = pool.p5;
  if (!p30 || !p5) return null;

  const bb5 = p5.bb;
  const rsi5 = p5.rsi;
  if (!bb5 || !rsi5 || !p5.close || p5.close.length < 2) return null;

  const lastClose = p5.close[p5.close.length - 1];
  const prevClose = p5.close[p5.close.length - 2];
  const volRatio = p5.volAvg > 0 ? p5.lastVol / p5.volAvg : 0;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  const breakoutUp = prevClose <= bb5.upper && lastClose > bb5.upper;
  const breakoutDown = prevClose >= bb5.lower && lastClose < bb5.lower;

  if (breakoutUp) {
    signal = "LONG";
    score = 60;
    prob = 45;
    reasons.push(`Breakout alcista: cierre (${lastClose.toFixed(8)}) > BB upper (${bb5.upper.toFixed(8)})`);
    if (volRatio > 1.5) { score += 15; prob += 10; reasons.push(`Volumen ${volRatio.toFixed(1)}x media`); }
    else if (volRatio > 1.0) { score += 8; prob += 5; reasons.push("Volumen sobre media"); }
    if (rsi5 > 55) { score += 10; prob += 7; reasons.push("RSI 5m alcista"); }
    if (p5.adx?.adx != null && p5.adx.adx > 20) { score += 10; prob += 5; reasons.push("ADX confirmado"); }
  } else if (breakoutDown) {
    signal = "SHORT";
    score = 60;
    prob = 45;
    reasons.push(`Breakout bajista: cierre (${lastClose.toFixed(8)}) < BB lower (${bb5.lower.toFixed(8)})`);
    if (volRatio > 1.5) { score += 15; prob += 10; reasons.push(`Volumen ${volRatio.toFixed(1)}x media`); }
    else if (volRatio > 1.0) { score += 8; prob += 5; reasons.push("Volumen sobre media"); }
    if (rsi5 < 45) { score += 10; prob += 7; reasons.push("RSI 5m bajista"); }
    if (p5.adx?.adx != null && p5.adx.adx > 20) { score += 10; prob += 5; reasons.push("ADX confirmado"); }
  }

  return { strategy: "Breakout", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function liquidityGrab(pool) {
  const p30 = pool.p30, p5 = pool.p5;
  if (!p30 || !p5) return null;

  const { lastHigh, lastLow } = calculatePivots(p30.high, p30.low, 3);
  if (lastHigh == null && lastLow == null) return null;
  if (!p5.high || !p5.low || !p5.close || !p5.open) return null;

  const n = p5.close.length;
  const lastHigh5 = p5.high[n - 1];
  const lastLow5 = p5.low[n - 1];
  const lastClose5 = p5.close[n - 1];
  const lastOpen5 = p5.open[n - 1];
  const body = Math.abs(lastClose5 - lastOpen5);
  const upperWick = lastHigh5 - Math.max(lastOpen5, lastClose5);
  const lowerWick = Math.min(lastOpen5, lastClose5) - lastLow5;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  if (lastHigh != null && lastHigh5 > lastHigh && lastClose5 < lastHigh && body > 0) {
    const wickRatio = upperWick / body;
    if (wickRatio > 1.5) {
      signal = "SHORT";
      score = 60;
      prob = 48;
      reasons.push(`Liquidity grab alcista: mecha (${upperWick.toFixed(8)}) > ${wickRatio.toFixed(1)}x cuerpo`);
      if (p5.rsi && p5.rsi > 60) { score += 12; prob += 8; reasons.push("RSI 5m sobrecomprado"); }
      if (p5.bb && lastHigh5 > p5.bb.upper) { score += 10; prob += 7; reasons.push("Mecha sobre BB 5m"); }
      if (p5.adx?.adx != null && p5.adx.adx > 15) { score += 10; prob += 5; reasons.push("ADX activo"); }
    }
  } else if (lastLow != null && lastLow5 < lastLow && lastClose5 > lastLow && body > 0) {
    const wickRatio = lowerWick / body;
    if (wickRatio > 1.5) {
      signal = "LONG";
      score = 60;
      prob = 48;
      reasons.push(`Liquidity grab bajista: mecha (${lowerWick.toFixed(8)}) > ${wickRatio.toFixed(1)}x cuerpo`);
      if (p5.rsi && p5.rsi < 40) { score += 12; prob += 8; reasons.push("RSI 5m sobrevendido"); }
      if (p5.bb && lastLow5 < p5.bb.lower) { score += 10; prob += 7; reasons.push("Mecha bajo BB 5m"); }
      if (p5.adx?.adx != null && p5.adx.adx > 15) { score += 10; prob += 5; reasons.push("ADX activo"); }
    }
  }

  return { strategy: "Liquidity_Grab", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function rsiDivergence(pool) {
  const p30 = pool.p30, p5 = pool.p5;
  if (!p30 || !p5) return null;

  const pivots30 = p30.pivots;
  if (!pivots30 || pivots30.lows.length < 2 || pivots30.highs.length < 2) return null;

  const rsiArr30 = [];
  for (let i = 0; i < (p30.close?.length || 0); i++) {
    const r = calculateRSI(p30.close.slice(0, i + 1), 14);
    rsiArr30.push(r);
  }

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];
  const totalBars = p30.close.length;

  const lastTwoLows = pivots30.lows.slice(-2);
  if (lastTwoLows.length === 2 &&
      lastTwoLows[1].idx - lastTwoLows[0].idx >= 4 &&
      totalBars - lastTwoLows[1].idx <= 12) {
    const priceLowerLow = lastTwoLows[1].value < lastTwoLows[0].value;
    const rsiVal1 = rsiArr30[lastTwoLows[0].idx] ?? p30.rsi;
    const rsiVal2 = rsiArr30[lastTwoLows[1].idx] ?? p30.rsi;
    const rsiHigherLow = rsiVal1 != null && rsiVal2 != null && rsiVal2 > rsiVal1 && rsiVal2 < 50;

    if (priceLowerLow && rsiHigherLow) {
      signal = "LONG";
      score = 45;
      prob = 40;
      reasons.push(`Divergencia alcista: LL precio + HL RSI (RSI ${rsiVal2?.toFixed(1)})`);
      const rsiNow = p5.rsi || p30.rsi;
      if (rsiNow != null && rsiNow < 40) { score += 10; prob += 8; reasons.push("RSI 5m sobrevendido"); }
      if (p5.macd && p5.macd.histogram > 0) { score += 10; prob += 5; reasons.push("MACD 5m positivo"); }
      if (p5.bb && p5.precio <= p5.bb.middle) { score += 10; prob += 5; reasons.push("Bajo BB middle 5m"); }
      if (p5.adx?.adx != null && p5.adx.adx < 25) { score += 10; prob += 5; reasons.push("ADX bajo (contratendencia)"); }
    }
  }

  if (signal === "NEUTRAL") {
    const lastTwoHighs = pivots30.highs.slice(-2);
    if (lastTwoHighs.length === 2 &&
        lastTwoHighs[1].idx - lastTwoHighs[0].idx >= 4 &&
        totalBars - lastTwoHighs[1].idx <= 12) {
      const priceHigherHigh = lastTwoHighs[1].value > lastTwoHighs[0].value;
      const rsiVal1 = rsiArr30[lastTwoHighs[0].idx] ?? p30.rsi;
      const rsiVal2 = rsiArr30[lastTwoHighs[1].idx] ?? p30.rsi;
      const rsiLowerHigh = rsiVal1 != null && rsiVal2 != null && rsiVal2 < rsiVal1 && rsiVal2 > 50;

      if (priceHigherHigh && rsiLowerHigh) {
        signal = "SHORT";
        score = 45;
        prob = 40;
        reasons.push(`Divergencia bajista: HH precio + LH RSI (RSI ${rsiVal2?.toFixed(1)})`);
        const rsiNow = p5.rsi || p30.rsi;
        if (rsiNow != null && rsiNow > 60) { score += 10; prob += 8; reasons.push("RSI 5m sobrecomprado"); }
        if (p5.macd && p5.macd.histogram < 0) { score += 10; prob += 5; reasons.push("MACD 5m negativo"); }
        if (p5.bb && p5.precio >= p5.bb.middle) { score += 10; prob += 5; reasons.push("Sobre BB middle 5m"); }
        if (p5.adx?.adx != null && p5.adx.adx < 25) { score += 10; prob += 5; reasons.push("ADX bajo (contratendencia)"); }
      }
    }
  }

  return { strategy: "RSI_Divergence", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

const ALL_STRATEGIES = [
  smcReversal,
  trendPullback,
  vpMeanRevert,
  breakout,
  liquidityGrab,
  rsiDivergence
];

export function evaluateStrategies(ohlcv30m, ohlcv5m, pool = null) {
  const dataPool = pool || buildIndicatorPool(ohlcv30m, ohlcv5m);
  if (!dataPool.p30 || !dataPool.p5) return [];

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

export function rankCandidates(results) {
  if (!results.length) return [];

  const longs = results.filter((r) => r.signal === "LONG");
  const shorts = results.filter((r) => r.signal === "SHORT");

  const candidates = [];

  if (longs.length) {
    const bestLong = longs.reduce((best, r) => r.score > best.score ? r : best, longs[0]);
    const ensembleBonus = (longs.length - 1) * 5;
    const avgScore = longs.reduce((a, r) => a + r.score, 0) / longs.length;
    const avgProb = longs.reduce((a, r) => a + r.prob, 0) / longs.length;
    candidates.push({
      direction: "LONG",
      bestStrategy: bestLong.strategy,
      score: Math.min(Math.round(avgScore + ensembleBonus), 100),
      probability: Math.min(Math.round(avgProb + ensembleBonus), 100),
      allStrategies: longs.map((r) => ({ strategy: r.strategy, score: r.score, prob: r.prob, reasons: r.reasons }))
    });
  }

  if (shorts.length) {
    const bestShort = shorts.reduce((best, r) => r.score > best.score ? r : best, shorts[0]);
    const ensembleBonus = (shorts.length - 1) * 5;
    const avgScore = shorts.reduce((a, r) => a + r.score, 0) / shorts.length;
    const avgProb = shorts.reduce((a, r) => a + r.prob, 0) / shorts.length;
    candidates.push({
      direction: "SHORT",
      bestStrategy: bestShort.strategy,
      score: Math.min(Math.round(avgScore + ensembleBonus), 100),
      probability: Math.min(Math.round(avgProb + ensembleBonus), 100),
      allStrategies: shorts.map((r) => ({ strategy: r.strategy, score: r.score, prob: r.prob, reasons: r.reasons }))
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

export { STRATEGY_LIST };
