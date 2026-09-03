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

export function buildIndicatorPool(ohlcv1h, ohlcv15m) {
  const extract = (data, idx) => data.map((d) => d[idx]);
  const result = {};

  if (ohlcv1h && ohlcv1h.length >= 20) {
    const o = extract(ohlcv1h, 1), h = extract(ohlcv1h, 2),
          l = extract(ohlcv1h, 3), c = extract(ohlcv1h, 4), v = extract(ohlcv1h, 5);
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
      vp: calculateVolumeProfile(ohlcv1h),
      volAvg: v.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, v.length),
      lastVol: v[v.length - 1]
    };
  }

  if (ohlcv15m && ohlcv15m.length >= 20) {
    const o = extract(ohlcv15m, 1), h = extract(ohlcv15m, 2),
          l = extract(ohlcv15m, 3), c = extract(ohlcv15m, 4), v = extract(ohlcv15m, 5);
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
      volAvg: v.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, v.length),
      lastVol: v[v.length - 1]
    };
  }

  return result;
}

function smcReversal(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15) return null;

  const { lastHigh, lastLow } = calculatePivots(p1h.high, p1h.low, 3);
  if (lastHigh == null && lastLow == null) return null;

  const nearPivotHigh = lastHigh && Math.abs(p1h.precio - lastHigh) / lastHigh < 0.005;
  const nearPivotLow = lastLow && Math.abs(p1h.precio - lastLow) / lastLow < 0.005;
  const ema200 = p1h.ema200;
  const rsi15 = p15.rsi;
  const adx15 = p15.adx?.adx;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  if (nearPivotLow && rsi15 != null && rsi15 < 45 && ema200 && p1h.precio > ema200 * 0.97) {
    signal = "LONG";
    score = 60;
    prob = 45;
    reasons.push("Reversal en pivot bajo + RSI bajo + precio sobre EMA200");
    if (p15.bb && p15.precio < p15.bb.lower) { score += 10; prob += 7; reasons.push("Bajo BB 15m"); }
    if (rsi15 < 35) { score += 10; prob += 8; reasons.push("RSI extremo"); }
    if (adx15 != null && adx15 < 25) { score += 10; prob += 7; reasons.push("ADX bajo (rango)"); }
    if (p15.macd && p15.macd.histogram > 0) { score += 10; prob += 5; reasons.push("MACD histogram positivo"); }
  } else if (nearPivotHigh && rsi15 != null && rsi15 > 55 && ema200 && p1h.precio < ema200 * 1.03) {
    signal = "SHORT";
    score = 60;
    prob = 45;
    reasons.push("Reversal en pivot alto + RSI alto + precio bajo EMA200");
    if (p15.bb && p15.precio > p15.bb.upper) { score += 10; prob += 7; reasons.push("Sobre BB 15m"); }
    if (rsi15 > 65) { score += 10; prob += 8; reasons.push("RSI extremo"); }
    if (adx15 != null && adx15 < 25) { score += 10; prob += 7; reasons.push("ADX bajo (rango)"); }
    if (p15.macd && p15.macd.histogram < 0) { score += 10; prob += 5; reasons.push("MACD histogram negativo"); }
  }

  return { strategy: "SMC_Reversal", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function trendPullback(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15) return null;

  const adx30 = p1h.adx?.adx;
  const diP30 = p1h.adx?.diPlus;
  const diM30 = p1h.adx?.diMinus;
  if (adx30 == null || diP30 == null || diM30 == null) return null;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  const emaOrdered = p1h.ema20 && p1h.ema50 && p1h.ema200;
  const trending = adx30 > 25;

  if (trending && emaOrdered) {
    const bullishOrder = p1h.ema20 > p1h.ema50 && p1h.ema50 > p1h.ema200;
    const bearishOrder = p1h.ema20 < p1h.ema50 && p1h.ema50 < p1h.ema200;

    if (bullishOrder && diP30 > diM30) {
      const distToEma = Math.abs(p1h.precio - p1h.ema20) / p1h.precio;
      if (distToEma < 0.015) {
        signal = "LONG";
        score = 60;
        prob = 48;
        reasons.push("Tendencia alcista + pullback a EMA20");
        if (adx30 > 30) { score += 10; prob += 8; reasons.push(`ADX fuerte (${adx30})`); }
        if (p15.rsi && p15.rsi > 45 && p15.rsi < 60) { score += 10; prob += 7; reasons.push("RSI 15m neutral-alcista"); }
        if (p15.bb && p15.precio <= p15.bb.middle * 1.005) { score += 10; prob += 5; reasons.push("Precio cerca de BB middle 15m"); }
      }
    } else if (bearishOrder && diM30 > diP30) {
      const distToEma = Math.abs(p1h.precio - p1h.ema20) / p1h.precio;
      if (distToEma < 0.015) {
        signal = "SHORT";
        score = 60;
        prob = 48;
        reasons.push("Tendencia bajista + rebote a EMA20");
        if (adx30 > 30) { score += 10; prob += 8; reasons.push(`ADX fuerte (${adx30})`); }
        if (p15.rsi && p15.rsi > 40 && p15.rsi < 55) { score += 10; prob += 7; reasons.push("RSI 15m neutral-bajista"); }
        if (p15.bb && p15.precio >= p15.bb.middle * 0.995) { score += 10; prob += 5; reasons.push("Precio cerca de BB middle 15m"); }
      }
    }
  }

  return { strategy: "Trend_Pullback", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function vpMeanRevert(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15 || !p1h.vp) return null;

  const { poc, vah, val } = p1h.vp;
  const rsi15 = p15.rsi;
  const bb15 = p15.bb;
  if (!rsi15 || !bb15) return null;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  const distToPoc = (p1h.precio - poc) / p1h.precio;

  if (p1h.precio < val && distToPoc < -0.01) {
    signal = "LONG";
    score = 60;
    prob = 45;
    reasons.push(`Precio (${p1h.precio.toFixed(8)}) bajo VAL (${val.toFixed(8)})`);
    if (rsi15 < 40) { score += 10; prob += 8; reasons.push("RSI 15m sobrevendido"); }
    if (p15.precio < bb15.lower) { score += 10; prob += 7; reasons.push("Bajo BB 15m"); }
    if (p15.adx?.adx != null && p15.adx.adx < 20) { score += 10; prob += 5; reasons.push("ADX bajo (rango)"); }
  } else if (p1h.precio > vah && distToPoc > 0.01) {
    signal = "SHORT";
    score = 60;
    prob = 45;
    reasons.push(`Precio (${p1h.precio.toFixed(8)}) sobre VAH (${vah.toFixed(8)})`);
    if (rsi15 > 60) { score += 10; prob += 8; reasons.push("RSI 15m sobrecomprado"); }
    if (p15.precio > bb15.upper) { score += 10; prob += 7; reasons.push("Sobre BB 15m"); }
    if (p15.adx?.adx != null && p15.adx.adx < 20) { score += 10; prob += 5; reasons.push("ADX bajo (rango)"); }
  }

  return { strategy: "VP_Mean_Revert", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function breakout(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15) return null;

  const bb15 = p15.bb;
  const rsi15 = p15.rsi;
  if (!bb15 || !rsi15 || !p15.close || p15.close.length < 2) return null;

  const lastClose = p15.close[p15.close.length - 1];
  const prevClose = p15.close[p15.close.length - 2];
  const volRatio = p15.volAvg > 0 ? p15.lastVol / p15.volAvg : 0;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  const breakoutUp = prevClose <= bb15.upper && lastClose > bb15.upper;
  const breakoutDown = prevClose >= bb15.lower && lastClose < bb15.lower;

  if (breakoutUp) {
    signal = "LONG";
    score = 60;
    prob = 45;
    reasons.push(`Breakout alcista: cierre (${lastClose.toFixed(8)}) > BB upper (${bb15.upper.toFixed(8)})`);
    if (volRatio > 1.5) { score += 15; prob += 10; reasons.push(`Volumen ${volRatio.toFixed(1)}x media`); }
    else if (volRatio > 1.0) { score += 8; prob += 5; reasons.push("Volumen sobre media"); }
    if (rsi15 > 55) { score += 10; prob += 7; reasons.push("RSI 15m alcista"); }
    if (p15.adx?.adx != null && p15.adx.adx > 20) { score += 10; prob += 5; reasons.push("ADX confirmado"); }
  } else if (breakoutDown) {
    signal = "SHORT";
    score = 60;
    prob = 45;
    reasons.push(`Breakout bajista: cierre (${lastClose.toFixed(8)}) < BB lower (${bb15.lower.toFixed(8)})`);
    if (volRatio > 1.5) { score += 15; prob += 10; reasons.push(`Volumen ${volRatio.toFixed(1)}x media`); }
    else if (volRatio > 1.0) { score += 8; prob += 5; reasons.push("Volumen sobre media"); }
    if (rsi15 < 45) { score += 10; prob += 7; reasons.push("RSI 15m bajista"); }
    if (p15.adx?.adx != null && p15.adx.adx > 20) { score += 10; prob += 5; reasons.push("ADX confirmado"); }
  }

  return { strategy: "Breakout", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function liquidityGrab(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15) return null;

  const { lastHigh, lastLow } = calculatePivots(p1h.high, p1h.low, 3);
  if (lastHigh == null && lastLow == null) return null;
  if (!p15.high || !p15.low || !p15.close || !p15.open) return null;

  const n = p15.close.length;
  const lastHigh15 = p15.high[n - 1];
  const lastLow15 = p15.low[n - 1];
  const lastClose15 = p15.close[n - 1];
  const lastOpen15 = p15.open[n - 1];
  const body = Math.abs(lastClose15 - lastOpen15);
  const upperWick = lastHigh15 - Math.max(lastOpen15, lastClose15);
  const lowerWick = Math.min(lastOpen15, lastClose15) - lastLow15;

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];

  if (lastHigh != null && lastHigh15 > lastHigh && lastClose15 < lastHigh && body > 0) {
    const wickRatio = upperWick / body;
    if (wickRatio > 1.5) {
      signal = "SHORT";
      score = 60;
      prob = 48;
      reasons.push(`Liquidity grab alcista: mecha (${upperWick.toFixed(8)}) > ${wickRatio.toFixed(1)}x cuerpo`);
      if (p15.rsi && p15.rsi > 60) { score += 12; prob += 8; reasons.push("RSI 15m sobrecomprado"); }
      if (p15.bb && lastHigh15 > p15.bb.upper) { score += 10; prob += 7; reasons.push("Mecha sobre BB 15m"); }
      if (p15.adx?.adx != null && p15.adx.adx > 15) { score += 10; prob += 5; reasons.push("ADX activo"); }
    }
  } else if (lastLow != null && lastLow15 < lastLow && lastClose15 > lastLow && body > 0) {
    const wickRatio = lowerWick / body;
    if (wickRatio > 1.5) {
      signal = "LONG";
      score = 60;
      prob = 48;
      reasons.push(`Liquidity grab bajista: mecha (${lowerWick.toFixed(8)}) > ${wickRatio.toFixed(1)}x cuerpo`);
      if (p15.rsi && p15.rsi < 40) { score += 12; prob += 8; reasons.push("RSI 15m sobrevendido"); }
      if (p15.bb && lastLow15 < p15.bb.lower) { score += 10; prob += 7; reasons.push("Mecha bajo BB 15m"); }
      if (p15.adx?.adx != null && p15.adx.adx > 15) { score += 10; prob += 5; reasons.push("ADX activo"); }
    }
  }

  return { strategy: "Liquidity_Grab", signal, score: Math.min(score, 100), prob: Math.min(prob, 100), reasons };
}

function rsiDivergence(pool) {
  const p1h = pool.p1h, p15 = pool.p15;
  if (!p1h || !p15) return null;

  const pivots30 = p1h.pivots;
  if (!pivots30 || pivots30.lows.length < 2 || pivots30.highs.length < 2) return null;

  const rsiArr30 = [];
  for (let i = 0; i < (p1h.close?.length || 0); i++) {
    const r = calculateRSI(p1h.close.slice(0, i + 1), 14);
    rsiArr30.push(r);
  }

  let signal = "NEUTRAL", score = 0, prob = 0, reasons = [];
  const totalBars = p1h.close.length;

  const lastTwoLows = pivots30.lows.slice(-2);
  if (lastTwoLows.length === 2 &&
      lastTwoLows[1].idx - lastTwoLows[0].idx >= 4 &&
      totalBars - lastTwoLows[1].idx <= 12) {
    const priceLowerLow = lastTwoLows[1].value < lastTwoLows[0].value;
    const rsiVal1 = rsiArr30[lastTwoLows[0].idx] ?? p1h.rsi;
    const rsiVal2 = rsiArr30[lastTwoLows[1].idx] ?? p1h.rsi;
    const rsiHigherLow = rsiVal1 != null && rsiVal2 != null && rsiVal2 > rsiVal1 && rsiVal2 < 50;

    if (priceLowerLow && rsiHigherLow) {
      signal = "LONG";
      score = 45;
      prob = 40;
      reasons.push(`Divergencia alcista: LL precio + HL RSI (RSI ${rsiVal2?.toFixed(1)})`);
      const rsiNow = p15.rsi || p1h.rsi;
      if (rsiNow != null && rsiNow < 40) { score += 10; prob += 8; reasons.push("RSI 15m sobrevendido"); }
      if (p15.macd && p15.macd.histogram > 0) { score += 10; prob += 5; reasons.push("MACD 15m positivo"); }
      if (p15.bb && p15.precio <= p15.bb.middle) { score += 10; prob += 5; reasons.push("Bajo BB middle 15m"); }
      if (p15.adx?.adx != null && p15.adx.adx < 25) { score += 10; prob += 5; reasons.push("ADX bajo (contratendencia)"); }
    }
  }

  if (signal === "NEUTRAL") {
    const lastTwoHighs = pivots30.highs.slice(-2);
    if (lastTwoHighs.length === 2 &&
        lastTwoHighs[1].idx - lastTwoHighs[0].idx >= 4 &&
        totalBars - lastTwoHighs[1].idx <= 12) {
      const priceHigherHigh = lastTwoHighs[1].value > lastTwoHighs[0].value;
      const rsiVal1 = rsiArr30[lastTwoHighs[0].idx] ?? p1h.rsi;
      const rsiVal2 = rsiArr30[lastTwoHighs[1].idx] ?? p1h.rsi;
      const rsiLowerHigh = rsiVal1 != null && rsiVal2 != null && rsiVal2 < rsiVal1 && rsiVal2 > 50;

      if (priceHigherHigh && rsiLowerHigh) {
        signal = "SHORT";
        score = 45;
        prob = 40;
        reasons.push(`Divergencia bajista: HH precio + LH RSI (RSI ${rsiVal2?.toFixed(1)})`);
        const rsiNow = p15.rsi || p1h.rsi;
        if (rsiNow != null && rsiNow > 60) { score += 10; prob += 8; reasons.push("RSI 15m sobrecomprado"); }
        if (p15.macd && p15.macd.histogram < 0) { score += 10; prob += 5; reasons.push("MACD 15m negativo"); }
        if (p15.bb && p15.precio >= p15.bb.middle) { score += 10; prob += 5; reasons.push("Sobre BB middle 15m"); }
        if (p15.adx?.adx != null && p15.adx.adx < 25) { score += 10; prob += 5; reasons.push("ADX bajo (contratendencia)"); }
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
