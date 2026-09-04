import axios from "axios";
import { buildIndicatorPool, evaluateStrategies, rankCandidates } from "./strategies.js";
import { calculateLevels, RISK_PERCENT } from "./riskManager.js";

export const INTERNAL_MULTI_STRATEGY_LIST = [
  "BTC/USDT",
  "XRP/BTC",
  "ADA/BTC",
  "ORDI/BTC",
  "LINK/BTC",
  "SUI/BTC",
  "DOGE/BTC",
  "SOL/BTC",
  "PAXG/BTC",
  "ETH/BTC",
  "BNB/BTC"
];

const PIONEX_INTERVALS = {
  "15m": "15M",
  "1h": "60M"
};

let bot = null;
let getChatId = null;
let getBotStatus = null;

export function initInternalMultiStrategy(botInstance, chatIdGetter, statusGetter) {
  bot = botInstance;
  getChatId = chatIdGetter;
  getBotStatus = statusGetter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function symbolToPionex(symbol) {
  return symbol.replace("/", "_").replace(/:(USDT|BTC)$/, "_PERP");
}

async function fetchPionexKlines(symbol, interval, limit = null) {
  const pionexSymbol = symbolToPionex(symbol);
  const pionexInterval = PIONEX_INTERVALS[interval] || "60M";
  const effectiveLimit = limit || (interval === "15m" ? 100 : 450);
  const url = `https://api.pionex.com/api/v1/market/klines?symbol=${pionexSymbol}&interval=${pionexInterval}&limit=${effectiveLimit}`;
  const response = await axios.get(url, { timeout: 15000 });
  if (!response.data?.result || !response.data?.data?.klines) {
    throw new Error(`Pionex klines error: ${JSON.stringify(response.data)}`);
  }
  return response.data.data.klines.map((k) => [
    k.time,
    parseFloat(k.open),
    parseFloat(k.high),
    parseFloat(k.low),
    parseFloat(k.close),
    parseFloat(k.volume)
  ]).reverse();
}

function pairLabel(symbol) {
  return symbol.replace(/:(USDT|BTC)$/, "");
}

async function fetchPionexRiskTable(symbol) {
  const pionexSymbol = symbolToPionex(symbol);
  const url = `https://api.pionex.com/api/v1/common/riskTable?symbol=${pionexSymbol}`;
  const response = await axios.get(url, { timeout: 15000 });
  if (!response.data?.result || !response.data?.data?.symbols?.length) return null;
  const sym = response.data.data.symbols[0];
  const tiers = (sym.rows || [])
    .map((r) => ({ notional: parseFloat(r.notionalLimit), maxLev: parseFloat(r.maxLeverage) }))
    .filter((r) => !isNaN(r.maxLev) && !isNaN(r.notional));
  if (!tiers.length) return null;
  return { max: Math.max(...tiers.map((t) => t.maxLev)), tiers, source: "pionex" };
}

async function fetchBtcUsd() {
  const url = "https://api.pionex.com/api/v1/market/tickers?symbol=BTC_USDT_PERP";
  const response = await axios.get(url, { timeout: 15000 });
  const t = response.data?.data?.tickers?.[0];
  return t ? parseFloat(t.close) : null;
}

function maxLeverageForNotional(riskTable, notionalUsd) {
  if (!riskTable || !riskTable.tiers || !riskTable.tiers.length) return null;
  const sorted = [...riskTable.tiers].sort((a, b) => a.notional - b.notional);
  for (const t of sorted) {
    if (notionalUsd <= t.notional) return t.maxLev;
  }
  return sorted[sorted.length - 1].maxLev;
}

function fmtBtc(v) {
  if (v == null || isNaN(v)) return "N/A";
  return v.toFixed(10);
}

function pct(entry, level, direction) {
  if (!entry || !level) return "N/A";
  const raw = (level - entry) / entry * 100;
  const signed = direction === "SHORT" ? -raw : raw;
  return `${signed.toFixed(3)}%`;
}

function formatWinnerMessage(w) {
  const dirIcon = w.direction === "LONG" ? "🟢" : w.direction === "SHORT" ? "🔴" : "⚪";
  const bar = (score) => {
    const filled = Math.max(1, Math.round(score / 10));
    return "█".repeat(filled).padEnd(10, "░");
  };

  let msg = `🧠 MULTI-ESTRATEGIA INTERNA (1H/15M)\n\n`;
  msg += `🏆 Par ganador: ${w.label}\n`;
  msg += `🎯 Estrategia ganadora: ${w.bestStrategy}\n`;
  msg += `📈 Dirección: ${w.direction} ${dirIcon}\n`;
  msg += `⭐ Score: ${w.score} ${bar(w.score)}\n`;
  msg += `🎲 Probabilidad: ${w.probability}%\n\n`;
  msg += `💰 Entrada: ${fmtBtc(w.levels.entry)} BTC\n`;
  msg += `🛑 SL: ${fmtBtc(w.levels.sl)} BTC (${pct(w.levels.entry, w.levels.sl, w.direction)}) — ${w.levels.slAtrMult}×ATR(15m)\n`;
  msg += `🎯 TP1 (33%): ${fmtBtc(w.levels.tp1)} BTC (${pct(w.levels.entry, w.levels.tp1, w.direction)})\n`;
  msg += `🎯 TP2 (33%): ${fmtBtc(w.levels.tp2)} BTC (${pct(w.levels.entry, w.levels.tp2, w.direction)})\n`;
  msg += `🎯 TP3 (34%): ${fmtBtc(w.levels.tp3)} BTC (${pct(w.levels.entry, w.levels.tp3, w.direction)})\n\n`;
  msg += `⚙️ Apalancamiento sugerido: ${w.levels.leverage}x (máx 10x)${w.levels.exchangeMax ? ` — exchange ${w.levels.exchangeMax}x` : ""}\n`;
  msg += `📊 Riesgo (${(RISK_PERCENT * 100).toFixed(1)}% de capital): ${w.levels.riskBtc.toFixed(8)} BTC — nocional ${w.levels.notionalBtc.toFixed(8)} BTC\n`;
  if (w.levels.riskCapped) msg += `⚠️ Riesgo reducido por tope de 10x y capital disponible\n\n`;

  if (w.confluences && w.confluences.length) {
    msg += `🔁 Confluencias (ensemble):\n`;
    for (const c of w.confluences) {
      msg += `• ${c.strategy} (${c.score}pts, ${c.prob}%)`;
      if (c.reasons && c.reasons.length) msg += ` — ${c.reasons[0]}`;
      msg += `\n`;
    }
  }

  msg += `\n[Operativa manual en Pionex — el bot solo alerta]`;
  return msg;
}

function sendTelegram(text) {
  if (!bot || !getChatId) {
    console.warn("⚠️ Multi-estrategia interna: bot no inicializado, mensaje no enviado");
    return Promise.resolve();
  }
  const chatTarget = getChatId();
  if (!chatTarget) {
    console.warn("⚠️ Multi-estrategia interna: no hay chatId, mensaje no enviado");
    return Promise.resolve();
  }
  const LIMIT = 4000;
  return bot.api.sendMessage(chatTarget, text.length > LIMIT ? text.substring(0, LIMIT) + "\n\n*(truncado)*" : text)
    .catch((err) => {
      console.error("❌ Multi-estrategia interna: error enviando Telegram:", err.message);
    });
}

async function analyzePair(base, btcUsd) {
  let symbol;
  if (base.endsWith("/BTC")) {
    symbol = `${base.replace(/\/BTC$/, "")}/BTC:BTC`;
  } else if (base.endsWith("/USDT")) {
    symbol = `${base}:USDT`;
  } else {
    symbol = `${base}/USDT:USDT`;
  }
  let data1h = [], data15 = [];
  try {
    data1h = await fetchPionexKlines(symbol, "1h");
  } catch (e) {
    throw new Error(`klines 1h ${e.message}`);
  }
  try {
    data15 = await fetchPionexKlines(symbol, "15m");
  } catch (e) {
    throw new Error(`klines 15m ${e.message}`);
  }
  if (!data1h || data1h.length < 20 || !data15 || data15.length < 20) {
    throw new Error(`datos insuficientes (1h=${data1h?.length}, 15m=${data15?.length})`);
  }

  const pool = buildIndicatorPool(data1h, data15);
  const results = evaluateStrategies(data1h, data15, pool);
  const candidates = rankCandidates(results);

  if (!candidates.length) {
    return { base, label: pairLabel(symbol), trade: false };
  }

  const best = candidates[0];
  const atr15 = pool.p15.atr;
  const entry = pool.p15.precio;
  const levels = calculateLevels(entry, atr15, best.direction, symbol, best.bestSlPrice);

  if (!levels) {
    return { base, label: pairLabel(symbol), trade: false };
  }

  let exchangeMax = null;
  try {
    const riskTable = await fetchPionexRiskTable(symbol);
    if (riskTable) {
      const quoteBtc = symbol.endsWith(":BTC");
      const notionalMatch = quoteBtc ? levels.notionalBtc : (btcUsd ? levels.notionalBtc * btcUsd : levels.notionalBtc);
      exchangeMax = maxLeverageForNotional(riskTable, notionalMatch);
    }
  } catch (e) {
    console.warn(`⚠️ Multi-estrategia interna: riskTable falló ${symbol}: ${e.message}`);
  }

  if (exchangeMax && exchangeMax >= 1) {
    if (exchangeMax < levels.leverage) levels.leverage = exchangeMax;
    levels.exchangeMax = exchangeMax;
  }

  return {
    base,
    label: pairLabel(symbol),
    trade: true,
    direction: best.direction,
    bestStrategy: best.bestStrategy,
    score: best.score,
    probability: best.probability,
    levels,
    confluences: best.allStrategies
  };
}

export async function runInternalMultiStrategy(force = false) {
  if (!force && (getBotStatus?.() === "Cerrado" || !getChatId?.())) {
    console.log(`⏭️ Multi-estrategia interna saltado: status="${getBotStatus?.()}", chatId="${getChatId?.()}"`);
    return;
  }

  console.log("🔄 Iniciando análisis multi-estrategia INTERNO (11 pares, 1H contexto / 15M gatillo)...");
  const winners = [];
  const errors = [];
  let btcUsd = null;
  try {
    btcUsd = await fetchBtcUsd();
  } catch (e) {
    console.warn(`⚠️ Multi-estrategia interna: no se pudo obtener precio BTC/USDT: ${e.message}`);
  }

  for (const base of INTERNAL_MULTI_STRATEGY_LIST) {
    try {
      const res = await analyzePair(base, btcUsd);
      if (res.trade) {
        winners.push(res);
        console.log(`✅ ${res.label}: ${res.bestStrategy} ${res.direction} Score=${res.score} Prob=${res.probability}`);
      } else {
        console.log(`🚫 ${base}: sin señal válida`);
      }
    } catch (e) {
      console.error(`⚠️ Error multi-estrategia interna ${base}:`, e.message);
      errors.push(`${base} → ${e.message}`);
    }
    await sleep(1200);
  }

  try {
    let msg;
    if (!winners.length) {
      msg = `🧠 MULTI-ESTRATEGIA INTERNA (1H/15M)\n\n❌ Sin oportunidades válidas`;
      if (errors.length) {
        msg += "\n\n⚠️ Errores:";
        for (const e of errors) msg += `\n• ${e}`;
      }
    } else {
      winners.sort((a, b) => b.score - a.score);
      const best = winners[0];
      msg = formatWinnerMessage(best);
      if (errors.length) {
        msg += `\n\n⚠️ Errores en otros pares:`;
        for (const e of errors) msg += `\n• ${e}`;
      }
    }
    console.log("📤 Enviando resultado multi-estrategia interna a Telegram...");
    await sendTelegram(msg);
    console.log("✅ Análisis multi-estrategia interna completado y enviado.");
  } catch (error) {
    console.error("❌ Error en multi-estrategia interna:", error.message);
    await sendTelegram(`⚠️ Error en el análisis multi-estrategia interna: ${error.message}`);
  }
}