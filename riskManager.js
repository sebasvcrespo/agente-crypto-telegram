let CAPITAL_BTC = 0.00010;
const RISK_PERCENT = 0.10;
const MAX_LEVERAGE = 10;
const FEE_TOTAL = 0.005;
const BE_PLUS_FEE = 0.0015;
const TP1_R = 1.0;
const TP2_R = 2.0;
const TP3_R = 2.5;
const TP_ALLOCATION = [0.20, 0.30, 0.50];

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

  const sl = suggestedSlPrice;
  const tp1 = isLong ? entryPrice + TP1_R * r : entryPrice - TP1_R * r;
  const tp2 = isLong ? entryPrice + TP2_R * r : entryPrice - TP2_R * r;
  const tp3 = isLong ? entryPrice + TP3_R * r : entryPrice - TP3_R * r;
  const bePlus = isLong ? entryPrice * (1 + BE_PLUS_FEE) : entryPrice * (1 - BE_PLUS_FEE);

  const validSlSide = isLong ? sl < entryPrice : sl > entryPrice;
  if (!validSlSide || slDistance <= 0) return null;

  const tp1Distance = Math.abs(tp1 - entryPrice);
  if (tp1Distance / entryPrice < FEE_TOTAL) return null;

  const slDistancePct = slDistance / entryPrice;
  if (slDistancePct < 0.01 || slDistancePct > 0.04) return null;

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
    bePlus,
    tpAllocation: TP_ALLOCATION,
    tpR: [TP1_R, TP2_R, TP3_R],
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

export function applyLeverageCap(levels, maxLeverage) {
  if (!levels || !Number.isFinite(maxLeverage) || maxLeverage <= 0) return levels;

  const cappedLeverage = Math.max(1, maxLeverage);
  const maxNotional = cappedLeverage * CAPITAL_BTC;
  if (levels.notionalBtc <= maxNotional && levels.leverage <= cappedLeverage) {
    return { ...levels, exchangeMax: cappedLeverage };
  }

  const notionalBtc = Math.min(levels.notionalBtc, maxNotional);
  const slDistancePct = Number(levels.slDistancePct) / 100;
  const actualRisk = notionalBtc * (slDistancePct + FEE_TOTAL);
  return {
    ...levels,
    notionalBtc,
    leverage: cappedLeverage,
    riskBtc: actualRisk,
    riskCapped: true,
    exchangeMax: cappedLeverage
  };
}

export { CAPITAL_BTC, RISK_PERCENT, MAX_LEVERAGE, FEE_TOTAL, BE_PLUS_FEE, TP1_R, TP2_R, TP3_R, TP_ALLOCATION };
