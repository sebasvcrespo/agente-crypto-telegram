let CAPITAL_BTC = 0.00010;
const RISK_PERCENT = 0.066;
const MAX_LEVERAGE = 10;

function calcRiskBtc() {
  return CAPITAL_BTC * RISK_PERCENT;
}

export function setCAPITAL_BTC(value) {
  CAPITAL_BTC = value;
}

export function getCAPITAL_BTC() {
  return CAPITAL_BTC;
}

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
  const riskBtc = calcRiskBtc();
  const idealNotional = riskBtc / slDistancePct;
  const maxNotional = MAX_LEVERAGE * CAPITAL_BTC;
  const notionalBtc = Math.min(idealNotional, maxNotional);
  const leverage = Math.max(1, Math.ceil(notionalBtc / CAPITAL_BTC));
  const actualRisk = notionalBtc * slDistancePct;
  const riskCapped = actualRisk < riskBtc - 1e-12;

  return {
    direction,
    entry: entryPrice,
    sl: Math.max(sl, 0),
    tp1,
    tp2,
    tp3,
    riskBtc: actualRisk,
    notionalBtc,
    leverage,
    riskCapped,
    slDistanceBtc: slDistance,
    slDistancePct: (slDistancePct * 100).toFixed(2),
    volatility,
    slAtrMult
  };
}

export { CAPITAL_BTC, RISK_PERCENT, MAX_LEVERAGE };