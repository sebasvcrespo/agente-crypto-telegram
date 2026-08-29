const CAPITAL_BTC = 0.00016;
const RISK_PERCENT = 0.10;
const RISK_BTC = CAPITAL_BTC * RISK_PERCENT;
const MAX_LEVERAGE = 15;

export function calculateLevels(entryPrice, atr5m, direction) {
  if (!entryPrice || !atr5m || atr5m <= 0) return null;

  const isLong = direction === "LONG";
  const slAtrMult = 1.5;

  const slDistance = slAtrMult * atr5m;
  const r = slDistance;
  const tp1Mult = 1.0;
  const tp2Mult = 1.7;
  const tp3Mult = 2.5;

  const sl = isLong ? entryPrice - slDistance : entryPrice + slDistance;
  const tp1 = isLong ? entryPrice + tp1Mult * r : entryPrice - tp1Mult * r;
  const tp2 = isLong ? entryPrice + tp2Mult * r : entryPrice - tp2Mult * r;
  const tp3 = isLong ? entryPrice + tp3Mult * r : entryPrice - tp3Mult * r;

  if (slDistance <= 0) return null;

  const slDistancePct = slDistance / entryPrice;
  const notionalBtc = RISK_BTC / slDistancePct;
  const leverage = Math.min(MAX_LEVERAGE, Math.max(1, Math.ceil(notionalBtc / CAPITAL_BTC)));

  return {
    direction,
    entry: entryPrice,
    sl: Math.max(sl, 0),
    tp1,
    tp2,
    tp3,
    riskBtc: RISK_BTC,
    notionalBtc,
    leverage,
    slDistanceBtc: slDistance,
    slDistancePct: (slDistancePct * 100).toFixed(2)
  };
}