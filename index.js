import http from "http";
import { Bot, GrammyError, HttpError } from "grammy";
import dotenv from "dotenv";
import axios from "axios";
import cron from "node-cron";
import ccxt from "ccxt";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLatestIndicators, getIndicatorsForTimeframe } from "./indicators.js";

dotenv.config();

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack);
  }
});

const REQUIRED_ENV = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ FALTA variable de entorno: ${key}`);
    console.error("Debes configurarla en Render -> Environment -> Environment Variables");
    process.exit(1);
  }
}

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot running\n');
}).listen(process.env.PORT || 3000, () => {
  console.log(`🌐 HTTP server listening on port ${process.env.PORT || 3000}`);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const futuresExchange = new ccxt.kucoinfutures();
const spotExchange = new ccxt.kucoin();

let botStatus = "Cerrado";
let chatId = null;

const protocolo = fs.readFileSync(path.join(__dirname, "protocolo.txt"), "utf-8");

function decimalsForPrice(price) {
  if (price < 0.001) return 8;
  if (price < 0.01) return 6;
  if (price < 0.1) return 5;
  if (price < 1) return 4;
  if (price < 10) return 3;
  return 2;
}

function formatIndicatorsText(data) {
  const bb = data.bb_4h;
  const dec = decimalsForPrice(data.precio);
  const bbLine = bb
    ? `BB 4H > Upper: ${bb.upper.toFixed(dec)} | Mid: ${bb.middle.toFixed(dec)} | Lower: ${bb.lower.toFixed(dec)}`
    : "BB 4H: N/A";

  const r1 = data.rsi["1h"]?.toFixed(1) ?? "N/A";
  const r4 = data.rsi["4h"]?.toFixed(1) ?? "N/A";

  const a1 = data.adx["1h"];
  const a4 = data.adx["4h"];
  const adx1 = a1 ? `ADX ${a1.adx} | DI+ ${a1.diPlus} | DI- ${a1.diMinus}` : "N/A";
  const adx4 = a4 ? `ADX ${a4.adx} | DI+ ${a4.diPlus} | DI- ${a4.diMinus}` : "N/A";

  const at1 = data.atr["1h"] ? `${data.atr["1h"].toFixed(dec)} (${data.atr["1h_pct"]})` : "N/A";
  const at4 = data.atr["4h"] ? `${data.atr["4h"].toFixed(dec)} (${data.atr["4h_pct"]})` : "N/A";

  const sbr = data.sellBuyRate !== null ? data.sellBuyRate.toFixed(2) : "N/A";

  const output = `
PRECIO ACTUAL: $${data.precio.toFixed(dec)} (1H) | $${data.precio4h.toFixed(dec)} (4H)
HORA (UTC): ${data.timestamp}

--- INDICADORES 1H ---
RSI(14): ${r1}
ADX/DMI(14): ${adx1}
ATR(14): ${at1}

--- INDICADORES 4H ---
RSI(14): ${r4}
ADX/DMI(14): ${adx4}
ATR(14): ${at4}
${bbLine}

--- SELL/BUY RATES (periodo 34) ---
Valor: ${sbr}
${sbr !== "N/A" ? (data.sellBuyRate > 0 ? "→ Presión COMPRADORA dominante" : "→ Presión VENDEDORA dominante") : ""}
`;
  return output;
}

function formatTickerText(ticker, label = "DATOS 24H") {
  if (!ticker) {
    return `--- ${label} ---\n• Price Change: N/A\n• Volume (24h): N/A\n• Volume Change: N/A\n`;
  }

  const pc = ticker.percentage !== undefined
    ? `${ticker.percentage > 0 ? "+" : ""}${ticker.percentage.toFixed(2)}%`
    : "N/A";

  const vol = ticker.quoteVolume !== undefined
    ? `$${Number(ticker.quoteVolume).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : "N/A";

  const vc = "N/A";

  return `--- ${label} ---\n• Price Change: ${pc}\n• Volume (24h): ${vol}\n• Volume Change: ${vc}\n`;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchMarketDataForPair(symbol, isFutures = true, timeframes = ["1h", "4h"]) {
  const ex = isFutures ? futuresExchange : spotExchange;
  const exchangeName = isFutures ? "KuCoin Futures" : "KuCoin Spot";
  
  const results = {};
  for (const tf of timeframes) {
    let ohlcv = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        ohlcv = await ex.fetchOHLCV(symbol, tf, undefined, 100);
        break;
      } catch (e) {
        if (e.message?.includes("429") && attempt < 3) {
          const delay = attempt * 2000;
          console.log(`⏳ Rate limit en ${exchangeName} ${tf}, esperando ${delay}ms (intento ${attempt}/3)...`);
          await sleep(delay);
        } else {
          throw e;
        }
      }
    }
    console.log(`📊 ${exchangeName} ${symbol}: ${tf}=${ohlcv.length} velas`);
    results[tf] = ohlcv;
  }

  try {
    const ticker = await ex.fetchTicker(symbol);
    results._ticker = ticker;
  } catch (e) {
    console.log(`⚠️ No se pudo obtener ticker 24h para ${symbol}: ${e.message}`);
    results._ticker = null;
  }

  return results;
}

async function fetchMarketData(timeframes = ["1h", "4h"]) {
  const result = await fetchBestEffort("BTC", timeframes);
  return result.data;
}

function symbolsForPair(base) {
  const futuresSymbol = `${base}/USDT:USDT`;
  const spotSymbol = `${base}/USDT`;
  return { futuresSymbol, spotSymbol };
}

async function fetchBestEffort(base, timeframes = ["1h", "4h"]) {
  const { futuresSymbol, spotSymbol } = symbolsForPair(base);
  try {
    const data = await fetchMarketDataForPair(futuresSymbol, true, timeframes);
    return { data, market: "futuros", symbol: futuresSymbol };
  } catch (e) {
    console.log(`⚠️ ${futuresSymbol} en futuros FALLÓ: ${e.message}. Esperando 3s antes de spot...`);
    await sleep(3000);
    const data = await fetchMarketDataForPair(spotSymbol, false, timeframes);
    return { data, market: "spot", symbol: spotSymbol };
  }
}

const CLAUDE_MODELS = [
  "anthropic/claude-3-5-sonnet",
  "anthropic/claude-3-7-sonnet",
  "google/gemini-2.5-flash"
];

async function tryWithFallback(messages, modelIndex = 0) {
  if (modelIndex >= CLAUDE_MODELS.length) {
    throw new Error("All models failed");
  }
  
  try {
    console.log(`🧠 Usando modelo: ${CLAUDE_MODELS[modelIndex]}`);
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: CLAUDE_MODELS[modelIndex],
        messages
      },
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
    console.warn(`⚠️ Modelo ${CLAUDE_MODELS[modelIndex]} falló, intentando siguiente...`);
    return tryWithFallback(messages, modelIndex + 1);
  }
}

async function analyzeWithAI(indicatorsText, ticker = null) {
  const tickerText = formatTickerText(ticker, "DATOS 24H BTC");
  return tryWithFallback([
    {
      role: "user",
      content: `Eres un trader profesional de criptomonedas. Analiza los siguientes datos de BTCUSDT siguiendo ESTRICTAMENTE el protocolo de trading.

DATOS DEL MERCADO:
${indicatorsText}
${tickerText}
PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles.
2. Sigue el checklist del punto 12 del protocolo
3. Determina: BOT LONG, BOT SHORT o NO TRADE
4. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
5. Si es LONG o SHORT: calcula SL estructural+ATR, rango, grids, leverage por convicción
6. NO muestres capital ni cálculos intermedios

RESPONDE EN ESPAÑOL. Máximo 15 líneas. Formato EXACTO:

✅ BOT LONG (o ❌ BOT SHORT)
• Entry: $XX.XXX
• SL: $XX.XXX
• TP: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• Leverage: Xx

Si la recomendación es LONG: SL es el límite inferior, TP el superior. Si es SHORT: SL es el límite superior, TP el inferior.`
    }
  ]);
}

async function openRouterChat(messages) {
  return tryWithFallback(messages);
}

function normalizeSymbol(text) {
  let s = text.replace(/^\//, "").toUpperCase();
  s = s.replace(/USDT\s*$/, "").trim();
  if (!s) return null;
  return s;
}

async function analyzePair(base, timeframes = ["1h", "4h"]) {
  console.log(`🔍 Analizando par: ${base}`);

  const [btcResult, pairResult] = await Promise.all([
    fetchBestEffort("BTC", timeframes),
    fetchBestEffort(base, timeframes)
  ]);

  const btcIndicators = getLatestIndicators(btcResult.data["1h"], btcResult.data["4h"]);
  const pairIndicators = getLatestIndicators(pairResult.data["1h"], pairResult.data["4h"]);
  const btcText = formatIndicatorsText(btcIndicators);
  const pairText = formatIndicatorsText(pairIndicators);
  const btcTickerText = formatTickerText(btcResult.data._ticker, "DATOS 24H BTC");
  const pairTickerText = formatTickerText(pairResult.data._ticker, "DATOS 24H " + pairResult.symbol);

  const content = `Eres un trader profesional de criptomonedas.

--- CONTEXTO BTC (solo informativo, sin recomendación) ---
${btcText}
${btcTickerText}
--- ANÁLISIS DEL PAR ${pairResult.symbol} (${pairResult.market}) ---
${pairText}
${pairTickerText}
PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles.
2. Primero da un breve panorama de BTC (2-3 líneas, solo contexto, sin recomendación de trade)
3. Luego analiza ${pairResult.symbol} siguiendo ESTRICTAMENTE el protocolo (punto 12 del checklist)
4. Determina: BOT LONG, BOT SHORT o NO TRADE
5. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
6. Si es LONG o SHORT: calcula SL estructural+ATR, rango, grids, leverage por convicción
7. NO muestres capital ni cálculos intermedios

RESPONDE EN ESPAÑOL. Máximo 20 líneas. Formato EXACTO para el análisis del par:

✅ BOT LONG (o ❌ BOT SHORT)
• Entry: $XX.XXX
• SL: $XX.XXX
• TP: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• Leverage: Xx

Si la recomendación es LONG: SL es el límite inferior, TP el superior. Si es SHORT: SL es el límite superior, TP el inferior.`;

  return openRouterChat([{ role: "user", content }]);
}

async function chatWithAI(userMessage) {
  console.log("💬 Chat libre con IA...");

  const btcData = await fetchMarketData(["1h", "4h"]);
  const btcIndicators = getLatestIndicators(btcData["1h"], btcData["4h"]);
  const btcText = formatIndicatorsText(btcIndicators);
  const tickerText = formatTickerText(btcData._ticker, "DATOS 24H BTC");

  const content = `Eres un asistente trader experto en criptomonedas. Respondes preguntas sobre crypto, trading, análisis técnico, etc.

DATOS ACTUALES DE BTC/USDT (para contexto de mercado):
${btcText}
${tickerText}
El usuario pregunta:
${userMessage}

Responde de forma útil, clara y concisa. Si te pregunta sobre un par específico del que no tienes datos, usa tu conocimiento general. Si puedes dar contexto de precios actuales basado en los datos de BTC, hazlo.`;

  return openRouterChat([{ role: "user", content }]);
}

const VALID_INDICATORS = ["ADX", "RSI", "ATR", "BB", "SBR", "SELLBUYRATE"];
const VALID_TIMEFRAMES = ["15m", "30m", "1h", "2h", "4h"];

function parseFlexibleCommand(text) {
  const cleanText = text.replace(/^\//, "").trim();
  const upperParts = cleanText.toUpperCase().split(/\s+/).map(p => p.replace(/[?!.,]+$/, ""));
  const lowerParts = cleanText.toLowerCase().split(/\s+/);
  
  if (upperParts.length === 0) return null;
  
  const symbol = upperParts[0].replace(/USDT\s*$/, "").trim();
  if (!symbol) return null;
  
  const firstParam = upperParts[1] || null;
  const isIndicator = VALID_INDICATORS.includes(firstParam);
  const isTimeframe = VALID_TIMEFRAMES.includes(firstParam?.toLowerCase());
  
  let indicator = isIndicator ? firstParam : null;
  let timeframe = null;
  let allIndicators = false;
  
  if (isTimeframe) {
    timeframe = firstParam.toLowerCase();
    allIndicators = true;
  } else if (!isIndicator && upperParts[2] && VALID_TIMEFRAMES.includes(upperParts[2].toLowerCase())) {
    timeframe = upperParts[2].toLowerCase();
  }
  
  const isFutures = upperParts.includes("FUTUROS") || upperParts.includes("FUTURES");
  
  const hasLong = upperParts.includes("LONG") && !upperParts.includes("SHORT");
  const hasShort = upperParts.includes("SHORT") && !upperParts.includes("LONG");
  
  const hasBotKeyword = upperParts.includes("BOT");
  const hasComparisonMode = hasBotKeyword && isFutures;
  const botIntent = (hasLong || hasShort) && (hasBotKeyword || isFutures) ? (hasLong ? "LONG" : "SHORT") : null;

  return {
    symbol,
    indicator,
    timeframe,
    allIndicators,
    isFutures,
    botIntent,
    comparisonMode: hasComparisonMode && !!botIntent
  };
}

function formatSingleIndicator(ind, tf, data) {
  const dec = decimalsForPrice(data.precio);
  
  if (ind === "ADX") {
    const adx = data.adx;
    if (!adx) return `ADX ${tf}: N/A`;
    return `ADX(14) ${tf} | DI+: ${adx.diPlus.toFixed(1)} | DI-: ${adx.diMinus.toFixed(1)} | ADX: ${adx.adx.toFixed(1)}`;
  }
  
  if (ind === "RSI") {
    const rsi = data.rsi ?? data.rsi?.[tf] ?? data.rsi?.["1h"];
    if (rsi === null || rsi === undefined) return `RSI ${tf}: N/A`;
    return `RSI(14) ${tf}: ${rsi.toFixed(1)}`;
  }
  
  if (ind === "ATR") {
    const atr = data.atr ?? data.atr?.[tf] ?? data.atr?.["1h"];
    const pct = data.atrPct ?? data.atr?.[`${tf}_pct`] ?? data.atr?.["1h_pct"];
    if (!atr) return `ATR ${tf}: N/A`;
    return `ATR(14) ${tf}: ${atr.toFixed(dec)} (${pct})`;
  }
  
  if (ind === "BB" || ind === "BOLINGER") {
    const bb = data.bb ?? data.bb_4h;
    if (!bb) return `BB ${tf}: N/A`;
    return `BB(20,2) ${tf} | Upper: ${bb.upper.toFixed(dec)} | Mid: ${bb.middle.toFixed(dec)} | Lower: ${bb.lower.toFixed(dec)}`;
  }
  
  if (ind === "SBR" || ind === "SELLBUYRATE") {
    const sbr = data.sellBuyRate;
    if (sbr === null || sbr === undefined) return `Sell/Buy Rate: N/A`;
    return `Sell/Buy Rate ${tf}: ${sbr.toFixed(2)} ${sbr > 0 ? "→ COMPRADOR" : "→ VENDEDOR"}`;
  }
  
  return "Indicador no disponible";
}

async function getSingleIndicator(symbol, indicator, timeframe) {
  const timeframes = timeframe ? [timeframe] : ["1h", "4h"];
  const { futuresSymbol, spotSymbol } = symbolsForPair(symbol);
  
  let data, market, sym;
  try {
    data = await fetchMarketDataForPair(futuresSymbol, true, timeframes);
    market = "futuros";
    sym = futuresSymbol;
  } catch (e) {
    console.log(`⚠️ Fallback a spot para ${spotSymbol} en 3s...`);
    await sleep(3000);
    data = await fetchMarketDataForPair(spotSymbol, false, timeframes);
    market = "spot";
    sym = spotSymbol;
  }
  
  if (timeframe && timeframes.length === 1) {
    const ind = getIndicatorsForTimeframe(data[timeframe], timeframe);
    return formatSingleIndicator(indicator, timeframe, ind);
  }
  
  const ind = getLatestIndicators(data["1h"], data["4h"]);
  const results = [];
  for (const tf of timeframes) {
    const tfData = getIndicatorsForTimeframe(data[tf], tf);
    results.push(formatSingleIndicator(indicator, tf, tfData));
  }
  return results.join("\n");
}

async function getAllIndicatorsForTimeframe(symbol, timeframe) {
  const { futuresSymbol, spotSymbol } = symbolsForPair(symbol);
  
  let data, market, sym;
  try {
    data = await fetchMarketDataForPair(futuresSymbol, true, [timeframe]);
    market = "futuros";
    sym = futuresSymbol;
  } catch (e) {
    console.log(`⚠️ Fallback a spot para ${spotSymbol} en 3s...`);
    await sleep(3000);
    data = await fetchMarketDataForPair(spotSymbol, false, [timeframe]);
    market = "spot";
    sym = spotSymbol;
  }
  
  const ind = getIndicatorsForTimeframe(data[timeframe], timeframe);
  const dec = decimalsForPrice(ind.precio);
  
  return `📊 *${sym}* (${market}) - *${timeframe.toUpperCase()}*\n\n` +
    `Precio: $${ind.precio.toFixed(dec)}\n` +
    `Hora: ${ind.timestamp}\n\n` +
    `• ${formatSingleIndicator("RSI", timeframe, ind)}\n` +
    `• ${formatSingleIndicator("ADX", timeframe, ind)}\n` +
    `• ${formatSingleIndicator("ATR", timeframe, ind)}\n` +
    `• ${formatSingleIndicator("BB", timeframe, ind)}\n` +
    `• ${formatSingleIndicator("SBR", timeframe, ind)}`;
}

async function analyzeBotOpportunity(symbol, direction, useFutures = null) {
  const timeframes = ["1h", "4h"];
  const { futuresSymbol, spotSymbol } = symbolsForPair(symbol);
  
  let data, market, sym;
  if (useFutures === true) {
    data = await fetchMarketDataForPair(futuresSymbol, true, timeframes);
    market = "futuros";
    sym = futuresSymbol;
  } else if (useFutures === false) {
    data = await fetchMarketDataForPair(spotSymbol, false, timeframes);
    market = "spot";
    sym = spotSymbol;
  } else {
    try {
      data = await fetchMarketDataForPair(futuresSymbol, true, timeframes);
      market = "futuros";
      sym = futuresSymbol;
    } catch (e) {
      console.log(`⚠️ Fallback a spot para ${spotSymbol} en 3s...`);
      await sleep(3000);
      data = await fetchMarketDataForPair(spotSymbol, false, timeframes);
      market = "spot";
      sym = spotSymbol;
    }
  }
  
  const pairIndicators = getLatestIndicators(data["1h"], data["4h"]);
  const pairText = formatIndicatorsText(pairIndicators);
  const tickerText = formatTickerText(data._ticker, "DATOS 24H " + sym);

  const marketType = market === "futuros" ? "Futures" : "Spot";

  return openRouterChat([{
    role: "user",
    content: `Eres un trader profesional. Analiza si es buena oportunidad para BOT ${direction.toUpperCase()} en ${sym} (${marketType}) siguiendo ESTRICTAMENTE el protocolo.

DATOS DEL PAR ${sym} (${marketType}):
${pairText}
${tickerText}
PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles.
2. Aplica el checklist del punto 12 del protocolo
3. Determina: ✅ BOT ${direction.toUpperCase()} o ❌ NO TRADE
4. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
5. Si es ${direction.toUpperCase()}: calcula SL, rango, grids, leverage

RESPONDE EN ESPAÑOL. Máximo 15 líneas. Formato EXACTO:

✅ BOT ${direction.toUpperCase()}
• Entry: $XX.XXX
• SL: $XX.XXX
• TP: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• Leverage: Xx

SL/TP según protocolo: ${direction.toUpperCase() === "LONG" ? "SL es límite inferior, TP límite superior" : "SL es límite superior, TP límite inferior"}.`
  }]);
}

async function compareBotVsFutures(symbol, direction) {
  const timeframes = ["1h", "4h"];
  const { futuresSymbol, spotSymbol } = symbolsForPair(symbol);

  let data, market, sym;
  try {
    data = await fetchMarketDataForPair(futuresSymbol, true, timeframes);
    market = "futuros";
    sym = futuresSymbol;
  } catch (e) {
    console.log(`⚠️ Fallback a spot para ${spotSymbol} en 3s...`);
    await sleep(3000);
    data = await fetchMarketDataForPair(spotSymbol, false, timeframes);
    market = "spot";
    sym = spotSymbol;
  }

  const pairIndicators = getLatestIndicators(data["1h"], data["4h"]);
  const pairText = formatIndicatorsText(pairIndicators);
  const tickerText = formatTickerText(data._ticker, "DATOS 24H " + sym);
  const marketType = market === "futuros" ? "Futures" : "Spot";

  return openRouterChat([{
    role: "user",
    content: `Eres un trader profesional de criptomonedas. Analiza si es mejor usar un BOT GRID o FUTUROS para una operación ${direction.toUpperCase()} en ${sym} (${marketType}).

DATOS DEL PAR ${sym}:
${pairText}
${tickerText}
PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles.
2. Analiza los datos y determina los parámetros para BOT GRID (range, grids, SL, TP, leverage)
3. Analiza los datos y determina los parámetros para FUTUROS (entry, SL, TP1, TP2, leverage)
4. COMPARA ambas opciones y recomienda cuál es mejor según las condiciones actuales del mercado
5. Si el mercado está en rango (ADX bajo), el BOT GRID suele ser mejor. Si hay tendencia fuerte (ADX alto), los FUTUROS pueden ser mejores.

RESPONDE EN ESPAÑOL. Máximo 25 líneas. Formato EXACTO:

📊 COMPARACIÓN ${sym} — ${direction.toUpperCase()}

🔹 BOT GRID:
• Entry: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• SL: $XX.XXX
• TP: $XX.XXX
• Leverage: Xx

🔹 FUTUROS:
• Entry: $XX.XXX
• SL: $XX.XXX
• TP1: $XX.XXX
• TP2: $XX.XXX
• Leverage: Xx

📌 RECOMENDACIÓN: [BOT GRID / FUTUROS]
• Motivo: [explicación breve]

Para LONG: SL es límite inferior, TP es límite superior.
Para SHORT: SL es límite superior, TP es límite inferior.`
  }]);
}

async function sendSafeTelegram(text) {
  if (!chatId) {
    console.warn("⚠️ sendSafeTelegram: no hay chatId, mensaje no enviado");
    return;
  }
  const LIMIT = 4000;
  try {
    if (text.length <= LIMIT) {
      await bot.api.sendMessage(chatId, text);
    } else {
      await bot.api.sendMessage(chatId, text.substring(0, LIMIT) + "\n\n*(Análisis recortado por límite de caracteres)*");
    }
  } catch (err) {
    console.error("❌ Error al enviar mensaje a Telegram:", err.message);
  }
}

async function runHourlyAnalysis() {
  if (botStatus === "Abierto" || !chatId) {
    console.log(`⏭️ Análisis automático saltado: status="${botStatus}", chatId="${chatId}"`);
    return;
  }

  console.log("🔄 Iniciando análisis horario de BTCUSDT...");
  try {
    const marketData = await fetchMarketData(["1h", "4h"]);
    console.log("✅ Datos OHLCV obtenidos");

    const indicators = getLatestIndicators(marketData["1h"], marketData["4h"]);
    const indicatorsText = formatIndicatorsText(indicators);

    console.log("🧠 Enviando a OpenRouter para análisis...");
    const analysis = await analyzeWithAI(indicatorsText, marketData._ticker);

    console.log("📤 Enviando resultado a Telegram...");
    await sendSafeTelegram(analysis);
    console.log("✅ Análisis horario completado y enviado.");
  } catch (error) {
    console.error("❌ Error en análisis horario:", error.message);
    if (error.response) {
      console.error("Detalle:", JSON.stringify(error.response.data, null, 2).slice(0, 500));
    }
    await sendSafeTelegram(`⚠️ Error en el análisis automático: ${error.message}`);
  }
}

cron.schedule("0 * * * *", () => {
  console.log("⏰ Cron ejecutándose...");
  runHourlyAnalysis().catch((err) => {
    console.error("❌ Error en cron de análisis:", err.message);
  });
});

const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (selfUrl) {
  cron.schedule("*/10 * * * *", () => {
    axios.get(selfUrl).then(() => {
      console.log("🏓 Auto-ping exitoso a", selfUrl);
    }).catch((err) => {
      console.error("❌ Auto-ping falló:", err.message);
    });
  });
  console.log(`🏓 Auto-ping cada 10 min activado para: ${selfUrl}`);
} else {
  console.warn("⚠️ Auto-ping desactivado: define RENDER_EXTERNAL_URL o SELF_URL");
}

bot.command("start", async (ctx) => {
  try {
    chatId = ctx.chat.id;
    await ctx.reply(
      "🤖 *Bot Analista Crypto Activo*\n\n" +
      "*Comandos básicos:*\n" +
      "• `/PAR` — Analiza cualquier par con contexto BTC (ej: `/ETH`, `/BTC`)\n" +
      "• `/PAR TF` — Todos los indicadores en una temporalidad (ej: `/ETH 1h`, `/ADA 4h`)\n" +
      "• `Cerrado` — Activa el análisis automático de BTC cada hora\n" +
      "• `Abierto` — Pausa el análisis automático\n\n" +
      "*Comandos avanzados:*\n" +
      "• `/PAR INDICADOR [TF]` — Indicador específico (ej: `/ETH ADX 1h`, `/BTC RSI 4h`, `/ADA ATR 15m`)\n" +
      "• `/PAR BOT LONG|SHORT` — Análisis de oportunidad (ej: `/ETH BOT LONG`, `/ADA SHORT`)\n" +
      "• `/PAR FUTUROS LONG|SHORT` — Análisis en futuros (ej: `/ETH FUTUROS LONG`)\n" +
      "• `/PAR BOT O FUTUROS LONG|SHORT` — Compara bot vs futuros (ej: `/ETH BOT O FUTUROS LONG`)\n" +
      "• `/help` — Esta ayuda\n\n" +
      "*Indicadores:* ADX, RSI, ATR, BB, SBR\n" +
      "*Temporalidades:* 15m, 30m, 1h, 2h, 4h (default: 1h+4h)\n\n" +
      `Estado actual: *${botStatus}*`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("❌ Error en comando /start:", error.message);
  }
});

bot.command("help", async (ctx) => {
  chatId = ctx.chat.id;
  await ctx.reply(
    "📖 *Guía de comandos*\n\n" +
    "*Análisis completo:*\n" +
    "• `/ETH` , `/BTC` , `/ADA`\n" +
    "  → Análisis completo con contexto BTC y recomendación\n\n" +
    "*Todos los indicadores en una TF:*\n" +
    "• `/ETH 1h` — RSI, ADX, ATR, BB, SBR en 1H\n" +
    "• `/BTC 4h` — Todos los indicadores en 4H\n" +
    "• `/ADA 15m` — Todos los indicadores en 15m\n\n" +
    "*Indicadores específicos:*\n" +
    "• `/ETH ADX 1h` — ADX con DI+/DI- en 1H\n" +
    "• `/ETH RSI 4h` — RSI en 4H\n" +
    "• `/BTC ATR 15m` — ATR en 15m\n" +
    "• `/ADA BB` — Bollinger Bands en 1h+4h\n\n" +
    "*Análisis de oportunidad:*\n" +
    "• `/ETH BOT LONG` — ¿Es buena oportunidad para LONG?\n" +
    "• `/ETH BOT SHORT` — ¿Es buena oportunidad para SHORT?\n" +
    "• `/ETH FUTUROS LONG` — Configuración futuros LONG con SL/TP/entry/leverage\n" +
    "• `/ETH FUTUROS SHORT` — Configuración futuros SHORT con SL/TP/entry/leverage\n" +
    "• `/ETH BOT O FUTUROS LONG` — Compara bot vs futuros y recomienda el mejor\n" +
    "• `/ETH BOT O FUTUROS SHORT` — Compara bot vs futuros y recomienda el mejor\n\n" +
    "*Temporalidades:* 15m, 30m, 1h, 2h, 4h",
    { parse_mode: "Markdown" }
  );
});

bot.on("message:text", async (ctx) => {
  try {
    chatId = ctx.chat.id;
    const rawText = ctx.message.text.trim();
    const text = rawText.toLowerCase();

    if (rawText.startsWith("/")) {
      const cmd = parseFlexibleCommand(rawText);
      if (!cmd) {
        await ctx.reply("❌ Formato inválido. Usa /help para ver los comandos disponibles.");
        return;
      }

      if (cmd.comparisonMode) {
        await ctx.reply(`🔄 Comparando BOT vs FUTUROS para ${cmd.symbol}USDT en ${cmd.botIntent}...`);
        const analysis = await compareBotVsFutures(cmd.symbol, cmd.botIntent);
        await ctx.reply(analysis);
        return;
      }

      if (cmd.botIntent) {
        const market = cmd.isFutures ? "futuros" : null;
        await ctx.reply(`🔍 Analizando oportunidad ${cmd.botIntent} para ${cmd.symbol}USDT (${market || "mejor disponible"})...`);
        const analysis = await analyzeBotOpportunity(cmd.symbol, cmd.botIntent, cmd.isFutures ? true : undefined);
        await ctx.reply(analysis);
        return;
      }

      if (cmd.indicator) {
        await ctx.reply(`🔍 Consultando ${cmd.indicator} ${cmd.timeframe || "1h+4h"} para ${cmd.symbol}USDT...`);
        const result = await getSingleIndicator(cmd.symbol, cmd.indicator, cmd.timeframe);
        await ctx.reply(result);
        return;
      }

      if (cmd.allIndicators) {
        await ctx.reply(`🔍 Obteniendo todos los indicadores en ${cmd.timeframe} para ${cmd.symbol}USDT...`);
        const result = await getAllIndicatorsForTimeframe(cmd.symbol, cmd.timeframe);
        await ctx.reply(result);
        return;
      }

      await ctx.reply(`🔍 Analizando ${cmd.symbol}USDT con contexto de BTC...\n\nEsto puede tomar hasta 30 segundos.`);
      const analysis = await analyzePair(cmd.symbol, ["1h", "4h"]);
      await ctx.reply(analysis);
      return;
    }

    if (text === "abierto") {
      botStatus = "Abierto";
      await ctx.reply("🔒 *Modo Abierto* — Análisis automático pausado.\n\nCuando cierres tu bot, escribe *Cerrado* para reanudar.", { parse_mode: "Markdown" });
      console.log("🔒 Bot status cambiado a: Abierto");
      return;
    }

    if (text === "cerrado") {
      botStatus = "Cerrado";
      await ctx.reply("🔓 *Modo Cerrado* — Análisis automático activado.\n\nCada hora analizaré BTCUSDT y te enviaré la configuración.", { parse_mode: "Markdown" });
      console.log("🔓 Bot status cambiado a: Cerrado");
      await runHourlyAnalysis();
      return;
    }

    console.log("💬 Chat libre detectado:", rawText.slice(0, 50));
    const reply = await chatWithAI(rawText);
    await ctx.reply(reply);
  } catch (error) {
    console.error("❌ Error en handler message:text:", error.message);
    if (error.message && error.message.includes("does not have market")) {
      await ctx.reply("❌ Ese par no existe en KuCoin. Verifica el ticker e intenta de nuevo.");
    } else {
      await ctx.reply("⚠️ Ocurrió un error procesando tu mensaje. Intenta de nuevo.");
    }
  }
});

bot.on("message:photo", async (ctx) => {
  chatId = ctx.chat.id;
  try {
    await ctx.reply("📸 Analizando captura manual...");

    const photo = ctx.message.photo.pop();
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');

    const content = await tryWithFallback([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Eres un trader profesional. Analiza este gráfico siguiendo este protocolo:\n\n${protocolo}\n\nDetermina: ✅ BOT LONG, ❌ BOT SHORT o ❌ NO TRADE. Si es LONG/SHORT da: Entry, SL, TP, Range, Grids, Leverage. Máximo 10 líneas. Español.`
          },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Image}` }
          }
        ]
      }
    ]);

    if (content) {
      await ctx.reply(content);
    } else {
      await ctx.reply("El modelo respondió pero el formato cambió.");
    }
  } catch (error) {
    console.error("❌ Error en foto:", error.message);
    await ctx.reply("Error al procesar la imagen.");
  }
});

console.log("🚀 Bot analista crypto iniciado. Esperando mensajes...");
console.log(`Estado inicial: ${botStatus}`);
bot.catch((err) => {
  console.error("❌ Error en polling de Telegram:");
  console.error("  Mensaje:", err.message);
  if (err.error instanceof GrammyError) {
    console.error("  Descripción:", err.error.description);
    console.error("  Código:", err.error.errorCode);
  } else if (err.error instanceof HttpError) {
    console.error("  HTTP error");
  }
});

bot.start().catch((err) => {
  console.error("❌ Error al iniciar el bot (posible token inválido):", err.message);
  console.error("Verifica que TELEGRAM_BOT_TOKEN esté bien configurado en Render");
});
