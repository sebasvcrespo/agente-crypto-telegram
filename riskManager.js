const CAPITAL_BTC = 0.00015;
const RISK_PERCENT = 0.10;
const RISK_BTC = CAPITAL_BTC * RISK_PERCENT;
const MAX_LEVERAGE = 15;

const LOW_VOLATILITY = new Set(["PAXG", "BNB", "ETH"]);
const MED_VOLATILITY = new Set(["XRP", "SOL", "ADA", "LINK"]);
const HIGH_VOLATILITY = new Set(["DOGE", "SUI", "ORDI"]);

const SL_ATR_MULT = { LOW: 2.0, MED: 2.5, HIGH: 3.0 };

function volatilityCategory(symbol) {
  const base = symbol ? symbol.split("/")[0].toUpperCase() : "";
  if (LOW_VOLATILITY.has(base)) return "LOW";
  if (HIGH_VOLATILITY.has(base)) return "HIGH";
  return "MED";
}

export function calculateLevels(entryPrice, atr, direction, symbol) {
  if (!entryPrice || !atr || atr <= 0) return null;

  const isLong = direction === "LONG";
  const volatility = volatilityCategory(symbol);
  const slAtrMult = SL_ATR_MULT[volatility];

  const slDistance = slAtrMult * atr;
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
    slDistancePct: (slDistancePct * 100).toFixed(2),
    volatility,
    slAtrMult
  };
}

export { CAPITAL_BTC, RISK_PERCENT, MAX_LEVERAGE };