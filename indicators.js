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

export function getLatestIndicators(ohlcv1h, ohlcv4h) {
  console.log(`📐 Indicators: 1h=${ohlcv1h?.length || 0} velas, 4h=${ohlcv4h?.length || 0} velas`);
  const extract = (data, idx) => data.map(d => d[idx]);

  const o1 = extract(ohlcv1h, 1), h1 = extract(ohlcv1h, 2),
        l1 = extract(ohlcv1h, 3), c1 = extract(ohlcv1h, 4), v1 = extract(ohlcv1h, 5);
  const o4 = extract(ohlcv4h, 1), h4 = extract(ohlcv4h, 2),
        l4 = extract(ohlcv4h, 3), c4 = extract(ohlcv4h, 4);

  const lastC1 = c1[c1.length - 1];
  const lastC4 = c4[c4.length - 1];
  const lastTime = new Date(ohlcv1h[ohlcv1h.length - 1][0]);

  const bb4h = calculateBB(c4, 20, 2);
  const rsi1h = calculateRSI(c1, 14);
  const rsi4h = calculateRSI(c4, 14);
  const adx1h = calculateADX(h1, l1, c1, 14);
  const adx4h = calculateADX(h4, l4, c4, 14);
  const atr1h = calculateATR(h1, l1, c1, 14);
  const atr4h = calculateATR(h4, l4, c4, 14);
  const sbr = calculateSellBuyRate(o1, h1, l1, c1, v1, 34);

  return {
    precio: lastC1,
    precio4h: lastC4,
    timestamp: lastTime.toISOString(),
    bb_4h: bb4h,
    rsi: { "1h": rsi1h, "4h": rsi4h },
    adx: { "1h": adx1h, "4h": adx4h },
    atr: {
      "1h": atr1h,
      "4h": atr4h,
      "1h_pct": atr1h ? `${(atr1h / lastC1 * 100).toFixed(2)}%` : null,
      "4h_pct": atr4h ? `${(atr4h / lastC4 * 100).toFixed(2)}%` : null
    },
    sellBuyRate: sbr
  };
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
