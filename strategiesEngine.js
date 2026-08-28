import axios from "axios";
import dotenv from "dotenv";
import { calculateRSI, calculateADX, calculateATR, calculateBB } from "./indicators.js";

dotenv.config();

export const MULTI_STRATEGY_LIST = [
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

export const STRATEGY_NAMES = [
  "SMC_Reversal",
  "Trend_Pullback",
  "VP_Mean_Revert",
  "Breakout",
  "Liquidity_Grab",
  "RSI_Divergence"
];

const MIN_SCORE = 60;
const MIN_PROB = 40;
const ENSEMBLE_BONUS = 5;
const PIONEX_INTERVALS = {
  "1m": "1M", "5m": "5M", "15m": "15M", "30m": "30M",
  "1h": "60M", "2h": "120M", "4h": "4H"
};

const STRATEGY_DEFINITIONS = `
1. SMC_Reversal (Smart Money Concepts): busca giros identificando zonas de liquidity sweep de máximos/mínimos previos, seguido de un CHoCH (Change of Character). La entrada se sitúa en el Order Block (OB) no mitigado o Fair Value Gap (FVG). Contexto: zonas clave HTF.
2. Trend_Pullback (Continuación de Tendencia): tendencial pro-tendencia. Confirmada la tendencia (EMA 20/50/200 o HH/HL), opera retrocesos a soporte/resistencia o Fibonacci OTE (0.618-0.786). Confirmación: velas de rechazo.
3. VP_Mean_Revert (Reversión a la Media con Perfil de Volumen): explota el retorno al POC desde VAH/VAL del Volume Profile en mercado en rango (baja volatilidad tendencial).
4. Breakout (Ruptura de Niveles): captura volumen expansivo rompiendo resistencia/soporte o patrón de compresión (triángulo/cuña). Debe ir con incremento de volumen; esperar retesteo del nivel roto. Fiabilidad extra si hay retesteo.
5. Liquidity_Grab (Barrido de Liquidez): el precio supera niveles obvios (EQH/EQL) para activar stops y órdenes de ruptura, cerrando de nuevo dentro del rango dejando mecha larga. Confirmación: absorción rápida y vela de amplio cuerpo en contra del falso rompimiento.
6. RSI_Divergence (Divergencia del RSI): desacople entre precio y RSI. Alcista: precio lower low con RSI higher low. Bajista: precio higher high con RSI lower high. Confirmación: cruce de línea de señal del RSI fuera de sobrecompra/sobreventa.
`;

let bot = null;
let getChatId = null;

export function initStrategiesEngine(botInstance, chatIdGetter) {
  bot = botInstance;
  getChatId = chatIdGetter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function symbolForPair(base) {
  if (base.endsWith("/BTC") || base.endsWith("BTC")) {
    const cleanBase = base.replace(/\/BTC$/, "").replace(/BTC$/, "");
    if (cleanBase && cleanBase !== "BTC") {
      return `${cleanBase}/BTC:BTC`;
    }
  }
  return `${base}/USDT:USDT`;
}

function symbolToPionex(symbol) {
  return symbol.replace("/", "_").replace(/:(USDT|BTC)$/, "_PERP");
}

function intervalToPionex(tf) {
  return PIONEX_INTERVALS[tf] || "60M";
}

async function fetchPionexKlines(symbol, interval, limit = 100) {
  const pionexSymbol = symbolToPionex(symbol);
  const pionexInterval = intervalToPionex(interval);
  const url = `https://api.pionex.com/api/v1/market/klines?symbol=${pionexSymbol}&interval=${pionexInterval}&limit=${limit}`;
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

async function fetchPionexTicker(symbol) {
  const pionexSymbol = symbolToPionex(symbol);
  const url = `https://api.pionex.com/api/v1/market/tickers?symbol=${pionexSymbol}`;
  const response = await axios.get(url, { timeout: 15000 });
  if (!response.data?.result || !response.data?.data?.tickers?.length) return null;
  const t = response.data.data.tickers[0];
  const open = parseFloat(t.open);
  const close = parseFloat(t.close);
  const percentage = open > 0 ? ((close - open) / open) * 100 : 0;
  return {
    symbol: t.symbol,
    last: close,
    percentage,
    quoteVolume: t.amount,
    baseVolume: t.volume,
    open,
    high: parseFloat(t.high),
    low: parseFloat(t.low)
  };
}

async function fetchPionexFunding(symbol) {
  const pionexSymbol = symbolToPionex(symbol);
  const url = `https://api.pionex.com/api/v1/market/fundingRates?symbol=${pionexSymbol}`;
  const response = await axios.get(url, { timeout: 15000 });
  if (!response.data?.result || !response.data?.data?.rates?.length) return null;
  const rate = parseFloat(response.data.data.rates[0].fundingRate);
  return isNaN(rate) ? null : rate * 100;
}

const AI_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "google/gemini-2.5-pro",
  "openai/gpt-5",
  "deepseek/deepseek-v3.2",
  "qwen/qwen3.5-plus-20260420",
  "moonshotai/kimi-k2.5",
  "z-ai/glm-5",
  "google/gemini-2.5-flash"
];

async function callAI(messages, modelIndex = 0) {
  if (modelIndex >= AI_MODELS.length) throw new Error("All models failed");
  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: AI_MODELS[modelIndex], messages },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://localhost",
          "X-Title": "Crypto Telegram Agent"
        },
        timeout: 60000
      }
    );
    return response.data.choices[0].message.content;
  } catch (error) {
    console.warn(`⚠️ Multi-estrategia: modelo ${AI_MODELS[modelIndex]} falló, intentando siguiente...`);
    return callAI(messages, modelIndex + 1);
  }
}

function computeIndicatorSet(ohlcv) {
  const o = ohlcv.map((d) => d[1]);
  const h = ohlcv.map((d) => d[2]);
  const l = ohlcv.map((d) => d[3]);
  const c = ohlcv.map((d) => d[4]);
  const v = ohlcv.map((d) => d[5]);
  const precio = c[c.length - 1];
  return {
    precio,
    bb: calculateBB(c, 20, 2),
    rsi: calculateRSI(c, 14),
    adx: calculateADX(h, l, c, 14),
    atr: calculateATR(h, l, c, 14),
    vol: v.reduce((a, b) => a + b, 0),
    volMedia: v.slice(-34).reduce((a, b) => a + b, 0) / Math.min(34, v.length),
    lastVol: v[v.length - 1]
  };
}

function fmt(v, dec = 8) {
  return v == null ? "N/A" : v.toFixed(dec);
}

function fmtV(num) {
  if (num == null || isNaN(num)) return "N/A";
  return Number(num).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function buildContextText(label, tf30, tf5, ticker, funding) {
  const n = (s) => (s == null ? "N/A" : s.toFixed(2));
  const adxFmt = (adx) => (adx ? `ADX ${adx.adx} | DI+ ${adx.diPlus} | DI- ${adx.diMinus}` : "N/A");
  const bbFmt = (bb) => (bb ? `BB(20,2) > U ${fmt(bb.upper)} | Mid ${fmt(bb.middle)} | L ${fmt(bb.lower)} (ancho ${((bb.upper - bb.lower) / bb.middle * 100).toFixed(2)}%)` : "N/A");
  const atrPct = (atr) => (atr ? `${(atr / (tf30?.precio || 1) * 100).toFixed(2)}%` : "N/A");

  const fundingLine = funding == null || isNaN(funding) ? "N/A" : `${funding > 0 ? "+" : ""}${funding.toFixed(4)}%`;

  return `
PAR: ${label}
PRECIO ACTUAL (30M): ${fmt(tf30?.precio)}

--- TIME-FRAME MAYOR 30M (contexto y zona) ---
RSI(14): ${n(tf30?.rsi)}
ADX/DMI(14): ${adxFmt(tf30?.adx)}
ATR(14): ${fmt(tf30?.atr)} (${atrPct(tf30?.atr)})
${bbFmt(tf30?.bb)}
Volumen últimas velas: ${fmtV(tf30?.lastVol)} (media 34: ${fmtV(tf30?.volMedia)})

--- TIME-FRAME GATILLO 5M (entrada, SL y TPs) ---
RSI(14): ${n(tf5?.rsi)}
ADX/DMI(14): ${adxFmt(tf5?.adx)}
ATR(14): ${fmt(tf5?.atr)} (${(tf5?.atr && tf30?.precio ? (tf5.atr / tf30.precio * 100).toFixed(2) : "N/A")}%)
${bbFmt(tf5?.bb)}
Volumen últimas velas: ${fmtV(tf5?.lastVol)} (media 34: ${fmtV(tf5?.volMedia)})

--- DATOS 24H ---
Precio: ${fmt(ticker?.last) || "N/A"}
Change 24h: ${ticker?.percentage != null ? `${ticker.percentage > 0 ? "+" : ""}${ticker.percentage.toFixed(2)}%` : "N/A"}
Volumen 24h (en BTC): ${fmtV(ticker?.quoteVolume)}

--- FUNDING RATE ---
${fundingLine}
`.trim();
}

function buildPrompt(label, contextText) {
  return `Eres un trader cuantitativo profesional que opera TODO en par BASE BTC (los precios se expresan en BTC, no en USD). Debes evaluar las 6 estrategias de trading sobre el par ${label} y devolver un score (0-100), una probabilidad (0-100%) y los niveles exactos de entrada/SL/TP para la dirección que consideres mejor.

DEFINICIONES DE LAS 6 ESTRATEGIAS:
${STRATEGY_DEFINITIONS}

REGLA DE TEMPORALIDADES:
- TIME-FRAME MAYOR: 30M (para identificar la zona de interés, tendencia y contexto).
- GATILLO: 5M (para calcular con precisión la ENTRADA, el STOP LOSS y los 3 TAKE PROFITS, basándote en el ATR de 5M y la estructura de 5M).
- NO analices en 1H/2H/4H. Usa SOLO 30M (contexto) y 5M (gatillo).

CRITERIOS DE SCORING (por cada estrategia):
- Score 0-100 = calidad técnica de la señal en ese par y momento.
- Probabilidad 0-100% = probabilidad proyectada de éxito.
- Aplica ENSEMBLE BONUS: si una misma dirección (LONG/SHORT) es soportada por varias estrategias a la vez, suma +5 puntos de score por cada estrategia adicional confluente.
- Solo considera una señal válida si score >= ${MIN_SCORE} y probabilidad >= ${MIN_PROB}.

DATOS DEL PAR:
${contextText}

INSTRUCCIONES:
1. Evalúa CADA UNA de las 6 estrategias y asigna score + probabilidad a cada una (solo para las que tengan señal; si no hay señal, pon score 0).
2. Identifica la MEJOR estrategia (mayor score, considerando el ensemble bonus por confluencia) y la dirección (LONG o SHORT o NEUTRAL).
3. Para la mejor estrategia, calcula PRECIOS EN BTC:
   - Entrada (price): nivel preciso del gatillo 5M.
   - SL: según la estructura de la estrategia (bajo el mínimo del sweep/OB/FVG para LONG, arriba para SHORT), entre 0.5-1.5× ATR(5m).
   - TP1, TP2, TP3: 3 objetivos escalonados (salen 33%, 33%, 34% del capital). El último TP (TP3) NO debe superar 1.7R (1.7 × distancia SL). Los TP se distribuyen dentro de ese rango (ej TP1 ~0.5-0.6R, TP2 ~1.2R, TP3 ~1.7R).
   - Apalancamiento sugerido (leverage): máximo 4x, y SIEMPRE menor o igual al que permita que el SL no liquide (ajustalo según la distancia % del SL para que una liquidación forzada ocurra DESPUÉS que el SL técnico).

RESPONDE SOLO con JSON válido, sin texto adicional ni markdown. Formato EXACTO:
{
  "best_strategy": "NOMBRE_DE_UNA_DE_LAS_6",
  "direction": "LONG o SHORT o NEUTRAL",
  "score": <numero 0-100>,
  "probability": <numero 0-100>,
  "entry_btc": <numero precio en BTC>,
  "sl_btc": <numero>,
  "tp1_btc": <numero>,
  "tp2_btc": <numero>,
  "tp3_btc": <numero>,
  "leverage": <numero>,
  "per_strategy": { "SMC_Reversal": {"score": 0, "probability": 0}, "Trend_Pullback": {...}, ... }
}
Si NINGUNA estrategia tiene una señal válida (ninguna supera score ${MIN_SCORE} y prob ${MIN_PROB}), devuelve:
{ "best_strategy": "NONE", "direction": "NO_TRADE", "score": 0, "probability": 0, "per_strategy": {} }`;
}

function parseAIJson(content) {
  if (!content) return null;
  const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.substring(start, end + 1));
  } catch (e) {
    return null;
  }
}

async function analyzePair(base) {
  const symbol = symbolForPair(base);
  const label = pairLabel(symbol);
  const data = {};
  for (const tf of ["5m", "30m", "1h"]) {
    try {
      data[tf] = await fetchPionexKlines(symbol, tf, 100);
    } catch (e) {
      console.log(`⚠️ Multi-estrategia: klines ${label} ${tf} falló: ${e.message}`);
      data[tf] = [];
    }
  }
  if (!data["30m"]?.length) {
    throw new Error(`Par ${label} sin datos 30m`);
  }
  let ticker = null;
  try { ticker = await fetchPionexTicker(symbol); } catch (e) {}
  let funding = null;
  try { funding = await fetchPionexFunding(symbol); } catch (e) {}

  const tf30 = computeIndicatorSet(data["30m"]);
  const tf5 = computeIndicatorSet(data["5m"].length ? data["5m"] : data["30m"]);
  const contextText = buildContextText(label, tf30, tf5, ticker, funding);
  const prompt = buildPrompt(label, contextText);
  const content = await callAI([{ role: "user", content: prompt }]);
  const parsed = parseAIJson(content);

  if (!parsed || !parsed.per_strategy || parsed.best_strategy === "NONE" || parsed.best_strategy === "NO_TRADE") {
    return { base, label, trade: false };
  }

  const score = Number(parsed.score) || 0;
  const probability = Number(parsed.probability) || 0;
  if (score < MIN_SCORE || probability < MIN_PROB) {
    return { base, label, trade: false };
  }

  return {
    base,
    label,
    trade: true,
    strategy: parsed.best_strategy,
    direction: parsed.direction || "NEUTRAL",
    score,
    probability,
    entry: Number(parsed.entry_btc),
    sl: Number(parsed.sl_btc),
    tp1: Number(parsed.tp1_btc),
    tp2: Number(parsed.tp2_btc),
    tp3: Number(parsed.tp3_btc),
    leverage: Number(parsed.leverage) || 1,
    per_strategy: parsed.per_strategy
  };
}

function pairLabel(symbol) {
  return symbol.replace(/:(USDT|BTC)$/, "");
}

function fmtBtc(v) {
  if (v == null || isNaN(v)) return "N/A";
  return v.toFixed(8);
}

function formatWinnerMessage(w) {
  const dirIcon = w.direction === "LONG" ? "🟢" : w.direction === "SHORT" ? "🔴" : "⚪";
  const bar = (score) => {
    const filled = Math.max(1, Math.round(score / 10));
    return "█".repeat(filled).padEnd(10, "░");
  };
  let msg = `🎯 MEJOR OPCIÓN MULTI-ESTRATEGIA\n\n`;
  msg += `🔹 Par: ${w.label}\n`;
  msg += `🎯 Estrategia ganadora: ${w.strategy}\n`;
  msg += `📈 Dirección: ${w.direction} ${dirIcon}\n`;
  msg += `⭐ Score: ${w.score} ${bar(w.score)}\n`;
  msg += `🎲 Probabilidad: ${w.probability}%\n\n`;
  msg += `💰 Entrada: ${fmtBtc(w.entry)} BTC\n`;
  msg += `🛑 SL: ${fmtBtc(w.sl)} BTC\n`;
  msg += `🎯 TP1: ${fmtBtc(w.tp1)} BTC (33%)\n`;
  msg += `🎯 TP2: ${fmtBtc(w.tp2)} BTC (33%)\n`;
  msg += `🎯 TP3: ${fmtBtc(w.tp3)} BTC (34%)\n\n`;
  msg += `⚙️ Apalancamiento sugerido: ${w.leverage}x\n\n`;
  msg += `[Operativa manual en el exchange — el bot solo alerta]`;
  return msg;
}

function formatRanking(list) {
  const sorted = [...list].sort((a, b) => b.score - a.score);
  let msg = `\n📊 Ranking de oportunidades:`;
  for (const w of sorted.slice(0, 5)) {
    msg += `\n• ${w.label}: ${w.strategy} ${w.direction} (Score ${w.score}, ${w.probability}%)`;
  }
  return msg;
}

async function sendTelegram(text) {
  if (!bot || !getChatId) {
    console.warn("⚠️ Multi-estrategia: bot no inicializado, mensaje no enviado");
    return;
  }
  const chatTarget = getChatId();
  if (!chatTarget) {
    console.warn("⚠️ Multi-estrategia: no hay chatId, mensaje no enviado");
    return;
  }
  const LIMIT = 4000;
  try {
    if (text.length <= LIMIT) {
      await bot.api.sendMessage(chatTarget, text);
    } else {
      await bot.api.sendMessage(chatTarget, text.substring(0, LIMIT) + "\n\n*(Análisis recortado por límite de caracteres)*");
    }
  } catch (err) {
    console.error("❌ Multi-estrategia: error al enviar a Telegram:", err.message);
  }
}

export async function runMultiStrategyAnalysis(force = false) {
  if (!bot || !getChatId) {
    console.log("⏭️ Multi-estrategia: motor no inicializado.");
    return;
  }
  const chatTarget = getChatId();
  if (!chatTarget) {
    console.log("⏭️ Multi-estrategia saltado: no hay chatId configurado");
    return;
  }

  console.log("🔄 Iniciando análisis multi-estrategia independiente (10 pares base BTC, 30M/5M)...");
  const winners = [];
  const errors = [];

  for (const base of MULTI_STRATEGY_LIST) {
    try {
      const res = await analyzePair(base);
      if (res.trade) {
        winners.push(res);
        console.log(`✅ ${res.label}: ${res.strategy} ${res.direction} Score=${res.score} Prob=${res.probability}`);
      } else {
        console.log(`🚫 ${base}: sin señal válida`);
      }
    } catch (e) {
      console.error(`⚠️ Error multi-estrategia ${base}:`, e.message);
      errors.push(`${base} → ${e.message}`);
    }
    await sleep(1200);
  }

  try {
    let msg;
    if (!winners.length) {
      msg = `🧠 MULTI-ESTRATEGIA (30M/5M)\n\n❌ Sin Oportunidades`;
      if (errors.length) {
        msg += "\n\n⚠️ Errores:";
        for (const e of errors) msg += `\n• ${e}`;
      }
    } else {
      winners.sort((a, b) => b.score - a.score);
      const best = winners[0];
      msg = `🧠 MULTI-ESTRATEGIA (30M/5M)\n\n${formatWinnerMessage(best)}`;
      if (winners.length > 1) {
        msg += `\n${formatRanking(winners.slice(1))}`;
      }
      if (errors.length) {
        msg += `\n\n⚠️ Errores:
`;
        for (const e of errors) msg += `\n• ${e}`;
      }
    }
    console.log("📤 Enviando resultado multi-estrategia a Telegram...");
    await sendTelegram(msg);
    console.log("✅ Análisis multi-estrategia completado y enviado.");
  } catch (error) {
    console.error("❌ Error en multi-estrategia:", error.message);
    await sendTelegram(`⚠️ Error en el análisis multi-estrategia: ${error.message}`);
  }
}
