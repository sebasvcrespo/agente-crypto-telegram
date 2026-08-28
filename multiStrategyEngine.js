import axios from "axios";
import { buildIndicatorPool, evaluateStrategies, rankCandidates } from "./strategies.js";
import { calculateLevels } from "./riskManager.js";

export const INTERNAL_MULTI_STRATEGY_LIST = [
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
  "5m": "5M",
  "30m": "30M"
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
  const pionexInterval = PIONEX_INTERVALS[interval] || "30M";
  const effectiveLimit = limit || (interval === "30m" ? 450 : 100);
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

function fmtBtc(v) {
  if (v == null || isNaN(v)) return "N/A";
  return v.toFixed(8);
}

function pct(entry, level) {
  if (!entry || !level) return "N/A";
  return `${((level - entry) / entry * 100).toFixed(2)}%`;
}

function formatWinnerMessage(w) {
  const dirIcon = w.direction === "LONG" ? "🟢" : w.direction === "SHORT" ? "🔴" : "⚪";
  const bar = (score) => {
    const filled = Math.max(1, Math.round(score / 10));
    return "█".repeat(filled).padEnd(10, "░");
  };

  let msg = `🧠 MULTI-ESTRATEGIA INTERNA (30M/5M)\n\n`;
  msg += `🏆 Par ganador: ${w.label}\n`;
  msg += `🎯 Estrategia ganadora: ${w.bestStrategy}\n`;
  msg += `📈 Dirección: ${w.direction} ${dirIcon}\n`;
  msg += `⭐ Score: ${w.score} ${bar(w.score)}\n`;
  msg += `🎲 Probabilidad: ${w.probability}%\n\n`;
  msg += `💰 Entrada: ${fmtBtc(w.levels.entry)} BTC\n`;
  msg += `🛑 SL: ${fmtBtc(w.levels.sl)} BTC (${pct(w.levels.entry, w.levels.sl)})\n`;
  msg += `🎯 TP1 (33%): ${fmtBtc(w.levels.tp1)} BTC (${pct(w.levels.entry, w.levels.tp1)})\n`;
  msg += `🎯 TP2 (33%): ${fmtBtc(w.levels.tp2)} BTC (${pct(w.levels.entry, w.levels.tp2)})\n`;
  msg += `🎯 TP3 (34%): ${fmtBtc(w.levels.tp3)} BTC (${pct(w.levels.entry, w.levels.tp3)})\n\n`;
  msg += `⚙️ Apalancamiento sugerido: ${w.levels.leverage}x (máx 15x)\n`;
  msg += `📊 Riesgo: ${w.levels.riskBtc.toFixed(8)} BTC (5% de 0.00016 BTC) — nocional ${w.levels.notionalBtc.toFixed(8)} BTC\n\n`;

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

async function analyzePair(base) {
  const symbol = base.endsWith("/BTC") ? `${base.replace(/\/BTC$/, "")}/BTC:BTC` : `${base}/USDT:USDT`;
  let data30 = [], data5 = [];
  try {
    data30 = await fetchPionexKlines(symbol, "30m");
  } catch (e) {
    throw new Error(`klines 30m ${e.message}`);
  }
  try {
    data5 = await fetchPionexKlines(symbol, "5m");
  } catch (e) {
    throw new Error(`klines 5m ${e.message}`);
  }
  if (!data30 || data30.length < 20 || !data5 || data5.length < 20) {
    throw new Error(`datos insuficientes (30m=${data30?.length}, 5m=${data5?.length})`);
  }

  const pool = buildIndicatorPool(data30, data5);
  const results = evaluateStrategies(data30, data5, pool);
  const candidates = rankCandidates(results);

  if (!candidates.length) {
    return { base, label: pairLabel(symbol), trade: false };
  }

  const best = candidates[0];
  const atr5m = pool.p5.atr;
  const entry = pool.p5.precio;
  const levels = calculateLevels(entry, atr5m, best.direction);

  if (!levels) {
    return { base, label: pairLabel(symbol), trade: false };
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

  console.log("🔄 Iniciando análisis multi-estrategia INTERNO (10 pares base BTC, 30M contexto / 5M gatillo)...");
  const winners = [];
  const errors = [];

  for (const base of INTERNAL_MULTI_STRATEGY_LIST) {
    try {
      const res = await analyzePair(base);
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
      msg = `🧠 MULTI-ESTRATEGIA INTERNA (30M/5M)\n\n❌ Sin oportunidades válidas`;
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