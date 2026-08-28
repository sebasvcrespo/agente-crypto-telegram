export function calculateBB(close, period = 20, stdDev = 2) {
  const len = close.length;
  if (len < period) return null;

  const slice = close.slice(len - period, len);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + (val - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: sma + stdDev * std,
    middle: sma,
    lower: sma - stdDev * std
  };
}

export function calculateRSI(close, period = 14) {
  const len = close.length;
  if (len < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = close[i] - close[i - 1];
    gains += Math.max(diff, 0);
    losses += Math.max(-diff, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < len; i++) {
    const diff = close[i] - close[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

export function calculateATR(high, low, close, period = 14) {
  const len = Math.min(high.length, low.length, close.length);
  if (len < period + 1) return null;

  const tr = [];
  for (let i = 1; i < len; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }

  return atr;
}

export function calculateADX(high, low, close, period = 14) {
  const len = Math.min(high.length, low.length, close.length);
  if (len < period * 2) return null;

  const tr = [], plusDM = [], minusDM = [];

  for (let i = 1; i < len; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr.push(Math.max(hl, hc, lc));

    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const sTR = [tr.slice(0, period).reduce((a, b) => a + b, 0) / period];
  const sPlus = [plusDM.slice(0, period).reduce((a, b) => a + b, 0) / period];
  const sMinus = [minusDM.slice(0, period).reduce((a, b) => a + b, 0) / period];

  for (let i = period; i < tr.length; i++) {
    sTR.push((sTR[sTR.length - 1] * (period - 1) + tr[i]) / period);
    sPlus.push((sPlus[sPlus.length - 1] * (period - 1) + plusDM[i]) / period);
    sMinus.push((sMinus[sMinus.length - 1] * (period - 1) + minusDM[i]) / period);
  }

  const dx = [];
  for (let i = 0; i < sTR.length; i++) {
    const diP = 100 * sPlus[i] / sTR[i];
    const diM = 100 * sMinus[i] / sTR[i];
    dx.push(100 * Math.abs(diP - diM) / (diP + diM));
  }

  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  const last = sTR.length - 1;
  const finalDiP = Math.round(100 * 100 * sPlus[last] / sTR[last]) / 100;
  const finalDiM = Math.round(100 * 100 * sMinus[last] / sTR[last]) / 100;

  return {
    adx: Math.round(adx * 10) / 10,
    diPlus: finalDiP,
    diMinus: finalDiM
  };
}

function linreg(data, length) {
  const n = length;
  const sumX = n * (n - 1) / 2;
  const sumX2 = (n - 1) * n * (2 * n - 1) / 6;
  const sumY = data.reduce((a, b) => a + b, 0);
  const sumXY = data.reduce((sum, y, x) => sum + x * y, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return sumY / n;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return slope * (n - 1) + intercept;
}

export function calculateSellBuyRate(open, high, low, close, volume, period = 34) {
  const len = open.length;
  if (len < period) return null;

  const raw = [];
  for (let i = 0; i < len; i++) {
    const tw = high[i] - Math.max(open[i], close[i]);
    const bw = Math.min(open[i], close[i]) - low[i];
    const body = Math.abs(close[i] - open[i]);
    const range = tw + bw + body;

    if (range === 0) { raw.push(0); continue; }

    const isBullish = open[i] <= close[i];
    const rateBull = 0.5 * (tw + bw + 2 * body) / range;
    const rateBear = 0.5 * (tw + bw) / range;

    raw.push(volume[i] * (isBullish ? rateBull - rateBear : rateBear - rateBull));
  }

  return linreg(raw.slice(len - period, len), period);
}

export function getLatestIndicators(ohlcv1h, ohlcv4h, ohlcv2h = null, ohlcv30m = null) {
  console.log(`📐 Indicators: 1h=${ohlcv1h?.length || 0} velas, 2h=${ohlcv2h?.length || 0} velas, 4h=${ohlcv4h?.length || 0} velas, 30m=${ohlcv30m?.length || 0} velas`);
  const extract = (data, idx) => data.map(d => d[idx]);

  const o1 = extract(ohlcv1h, 1), h1 = extract(ohlcv1h, 2),
        l1 = extract(ohlcv1h, 3), c1 = extract(ohlcv1h, 4), v1 = extract(ohlcv1h, 5);
  const o4 = extract(ohlcv4h, 1), h4 = extract(ohlcv4h, 2),
        l4 = extract(ohlcv4h, 3), c4 = extract(ohlcv4h, 4);

  const lastC1 = c1[c1.length - 1];
  const lastC4 = c4[c4.length - 1];
  const lastTime = new Date(ohlcv1h[ohlcv1h.length - 1][0]);

  const bb1h = calculateBB(c1, 20, 2);
  const bb2h = ohlcv2h && ohlcv2h.length ? calculateBB(extract(ohlcv2h, 4), 20, 2) : null;
  const bb4h = calculateBB(c4, 20, 2);
  const rsi1h = calculateRSI(c1, 14);
  const rsi4h = calculateRSI(c4, 14);
  const adx1h = calculateADX(h1, l1, c1, 14);
  const adx4h = calculateADX(h4, l4, c4, 14);
  const atr1h = calculateATR(h1, l1, c1, 14);
  const atr4h = calculateATR(h4, l4, c4, 14);
  const sbr = calculateSellBuyRate(o1, h1, l1, c1, v1, 34);

  const has30m = ohlcv30m && ohlcv30m.length > 0;
  const o30 = has30m ? extract(ohlcv30m, 1) : null;
  const h30 = has30m ? extract(ohlcv30m, 2) : null;
  const l30 = has30m ? extract(ohlcv30m, 3) : null;
  const c30 = has30m ? extract(ohlcv30m, 4) : null;
  const v30 = has30m ? extract(ohlcv30m, 5) : null;
  const bb30m = has30m ? calculateBB(c30, 20, 2) : null;
  const rsi30m = has30m ? calculateRSI(c30, 14) : null;
  const adx30m = has30m ? calculateADX(h30, l30, c30, 14) : null;
  const atr30m = has30m ? calculateATR(h30, l30, c30, 14) : null;
  const sbr30m = has30m ? calculateSellBuyRate(o30, h30, l30, c30, v30, 34) : null;
  const v30avg = has30m ? v30.slice(-34).reduce((a, b) => a + b, 0) / Math.min(34, v30.length) : null;
  const sbr30mNorm = has30m && v30avg ? sbr30m / v30avg : null;

  return {
    precio: lastC1,
    precio4h: lastC4,
    timestamp: lastTime.toISOString(),
    bb_1h: bb1h,
    bb_2h: bb2h,
    bb_4h: bb4h,
    bb_30m: bb30m,
    rsi: { "1h": rsi1h, "4h": rsi4h, "30m": rsi30m },
    adx: { "1h": adx1h, "4h": adx4h, "30m": adx30m },
    atr: {
      "1h": atr1h,
      "4h": atr4h,
      "30m": atr30m,
      "1h_pct": atr1h ? `${(atr1h / lastC1 * 100).toFixed(2)}%` : null,
      "4h_pct": atr4h ? `${(atr4h / lastC4 * 100).toFixed(2)}%` : null,
      "30m_pct": atr30m ? `${(atr30m / lastC1 * 100).toFixed(2)}%` : null
    },
    sellBuyRate: sbr,
    sellBuyRate30m: sbr30m,
    sellBuyRate30mNorm: sbr30mNorm
  };
}

export function calculateEMA(data, period) {
  if (!data || data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calculateEMAArray(data, period) {
  if (!data || data.length < period) return [];
  const result = [];
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(null);
  result.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export function calculateMACD(close, fast = 12, slow = 26, signal = 9) {
  if (!close || close.length < slow + signal) return null;
  const emaFast = calculateEMAArray(close, fast);
  const emaSlow = calculateEMAArray(close, slow);
  const macdLine = [];
  for (let i = 0; i < close.length; i++) {
    if (emaFast[i] == null || emaSlow[i] == null) { macdLine.push(null); continue; }
    macdLine.push(emaFast[i] - emaSlow[i]);
  }
  const validMacd = macdLine.filter((v) => v != null);
  if (validMacd.length < signal) return null;
  const sigArr = calculateEMAArray(validMacd, signal);
  const lastMacd = validMacd[validMacd.length - 1];
  const lastSignal = sigArr[sigArr.length - 1];
  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd - lastSignal
  };
}

export function calculatePivots(high, low, window = 3) {
  const len = high.length;
  if (len < window * 2 + 1) return { lastHigh: null, lastLow: null, lastHighIdx: -1, lastLowIdx: -1 };
  let lastHigh = null, lastLow = null, lastHighIdx = -1, lastLowIdx = -1;
  for (let i = window; i < len - window; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= window; j++) {
      if (high[i] <= high[i - j] || high[i] <= high[i + j]) isHigh = false;
      if (low[i] >= low[i - j] || low[i] >= low[i + j]) isLow = false;
    }
    if (isHigh) { lastHigh = high[i]; lastHighIdx = i; }
    if (isLow) { lastLow = low[i]; lastLowIdx = i; }
  }
  return { lastHigh, lastLow, lastHighIdx, lastLowIdx };
}

export function calculatePivotsArray(high, low, window = 3) {
  const len = high.length;
  if (len < window * 2 + 1) return { highs: [], lows: [] };
  const highs = [], lows = [];
  for (let i = window; i < len - window; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= window; j++) {
      if (high[i] <= high[i - j] || high[i] <= high[i + j]) isHigh = false;
      if (low[i] >= low[i - j] || low[i] >= low[i + j]) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, value: high[i] });
    if (isLow) lows.push({ idx: i, value: low[i] });
  }
  return { highs, lows };
}

export function calculateVolumeProfile(ohlcv, numBuckets = 15) {
  if (!ohlcv || ohlcv.length < 10) return null;
  const highs = ohlcv.map((d) => d[2]);
  const lows = ohlcv.map((d) => d[3]);
  const volumes = ohlcv.map((d) => d[5]);
  const minPrice = Math.min(...lows);
  const maxPrice = Math.max(...highs);
  const range = maxPrice - minPrice;
  if (range <= 0) return null;
  const bucketSize = range / numBuckets;
  const buckets = new Array(numBuckets).fill(0);
  for (let i = 0; i < ohlcv.length; i++) {
    const midPrice = (highs[i] + lows[i]) / 2;
    let idx = Math.floor((midPrice - minPrice) / bucketSize);
    if (idx >= numBuckets) idx = numBuckets - 1;
    if (idx < 0) idx = 0;
    buckets[idx] += volumes[i];
  }
  let maxVol = 0, pocIdx = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] > maxVol) { maxVol = buckets[i]; pocIdx = i; }
  }
  const poc = minPrice + (pocIdx + 0.5) * bucketSize;
  let totalVol = buckets.reduce((a, b) => a + b, 0);
  let valueAreaVol = 0;
  const sortedBuckets = buckets.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const vaBuckets = [];
  for (const b of sortedBuckets) {
    vaBuckets.push(b.i);
    valueAreaVol += b.v;
    if (valueAreaVol >= totalVol * 0.7) break;
  }
  const vaPrices = vaBuckets.map((i) => minPrice + (i + 0.5) * bucketSize);
  const vah = Math.max(...vaPrices);
  const val = Math.min(...vaPrices);
  return { poc, vah, val };
}

export function getIndicatorsForTimeframe(ohlcv, timeframe = "1h") {
  const extract = (data, idx) => data.map(d => d[idx]);
  const o = extract(ohlcv, 1), h = extract(ohlcv, 2),
        l = extract(ohlcv, 3), c = extract(ohlcv, 4), v = extract(ohlcv, 5);

  const lastC = c[c.length - 1];
  const lastTime = new Date(ohlcv[ohlcv.length - 1][0]);

  return {
    precio: lastC,
    timestamp: lastTime.toISOString(),
    bb: calculateBB(c, 20, 2),
    rsi: calculateRSI(c, 14),
    adx: calculateADX(h, l, c, 14),
    atr: calculateATR(h, l, c, 14),
    sellBuyRate: calculateSellBuyRate(o, h, l, c, v, 34),
    atrPct: calculateATR(h, l, c, 14) ? `${(calculateATR(h, l, c, 14) / lastC * 100).toFixed(2)}%` : null
  };
}
