let CAPITAL_BTC = 0.00010;
const RISK_PERCENT = 0.10;
const MAX_LEVERAGE = 10;
const FEE_TOTAL = 0.01;

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

export function calculateLevels(entryPrice, atr, direction, symbol, suggestedSlPrice) {
  if (!entryPrice || !suggestedSlPrice) return null;

  const isLong = direction === "LONG";
  const slDistance = Math.abs(entryPrice - suggestedSlPrice);
  const r = slDistance;
  const tp1Mult = 1.0;
  const tp2Mult = 1.7;
  const tp3Mult = 2.5;

  const sl = suggestedSlPrice;
  const tp1 = isLong ? entryPrice + tp1Mult * r : entryPrice - tp1Mult * r;
  const tp2 = isLong ? entryPrice + tp2Mult * r : entryPrice - tp2Mult * r;
  const tp3 = isLong ? entryPrice + tp3Mult * r : entryPrice - tp3Mult * r;

  if (slDistance <= 0) return null;

  const tp1Distance = Math.abs(tp1 - entryPrice);
  if (tp1Distance / entryPrice < FEE_TOTAL) return null;

  const slDistancePct = slDistance / entryPrice;
  const riskBtc = CAPITAL_BTC * RISK_PERCENT;
  const riskPctTotal = slDistancePct + FEE_TOTAL;
  const idealNotional = riskBtc / riskPctTotal;
  const maxNotional = MAX_LEVERAGE * CAPITAL_BTC;
  const notionalBtc = Math.min(idealNotional, maxNotional);
  const leverage = Math.max(1, Math.ceil(notionalBtc / CAPITAL_BTC));
  const actualRisk = notionalBtc * riskPctTotal;
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
    volatility: volatilityCategory(symbol),
    slAtrMult: (slDistance / (atr || 1)).toFixed(2)
  };
}

export { CAPITAL_BTC, RISK_PERCENT, MAX_LEVERAGE, FEE_TOTAL };