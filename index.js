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
const exchange = new ccxt.bitget({ options: { defaultType: 'swap' } });

const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

const state = loadState();
let botStatus = state.botStatus || "Abierto";
let chatId = state.chatId || null;

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ botStatus, chatId }, null, 2));
  } catch (err) {
    console.error("❌ Error guardando state.json:", err.message);
  }
}

function setChatId(id) {
  chatId = id;
  saveState();
}

function setBotStatus(status) {
  botStatus = status;
  saveState();
}

const protocolo = fs.readFileSync(path.join(__dirname, "protocolo.txt"), "utf-8");

function decimalsForPrice(price, isBtcBase = false) {
  if (isBtcBase) return 8;
  if (price < 0.001) return 8;
  if (price < 0.01) return 6;
  if (price < 0.1) return 5;
  if (price < 1) return 4;
  if (price < 10) return 3;
  return 2;
}

function formatIndicatorsText(data, isBtcBase = false) {
  const dec = decimalsForPrice(data.precio, isBtcBase);
  const currencySymbol = isBtcBase ? "" : "$";
  const currencyUnit = isBtcBase ? " BTC" : "";

  const formatBBLine = (tf, bb) => {
    if (!bb) return `BB ${tf}: N/A`;
    const mid = bb.middle || data.precio;
    const width = mid > 0 ? ((bb.upper - bb.lower) / mid * 100).toFixed(1) : "N/A";
    return `BB ${tf} > Upper: ${bb.upper.toFixed(dec)}${currencyUnit} | Mid: ${bb.middle.toFixed(dec)}${currencyUnit} | Lower: ${bb.lower.toFixed(dec)}${currencyUnit} (ancho: ${width}%)`;
  };

  const bbLines = [
    formatBBLine("1H", data.bb_1h),
    formatBBLine("2H", data.bb_2h),
    formatBBLine("4H", data.bb_4h)
  ].join("\n");

  const r1 = data.rsi["1h"]?.toFixed(1) ?? "N/A";
  const r4 = data.rsi["4h"]?.toFixed(1) ?? "N/A";

  const a1 = data.adx["1h"];
  const a4 = data.adx["4h"];
  const adx1 = a1 ? `ADX ${a1.adx} | DI+ ${a1.diPlus} | DI- ${a1.diMinus}` : "N/A";
  const adx4 = a4 ? `ADX ${a4.adx} | DI+ ${a4.diPlus} | DI- ${a4.diMinus}` : "N/A";

  const at1 = data.atr["1h"] ? `${data.atr["1h"].toFixed(dec)}${currencyUnit} (${data.atr["1h_pct"]})` : "N/A";
  const at4 = data.atr["4h"] ? `${data.atr["4h"].toFixed(dec)}${currencyUnit} (${data.atr["4h_pct"]})` : "N/A";

  const sbr = data.sellBuyRate !== null ? data.sellBuyRate.toFixed(2) : "N/A";

  const has30m = data.rsi?.["30m"] != null;
  let block30m = "";
  if (has30m) {
    const r30 = data.rsi["30m"]?.toFixed(1) ?? "N/A";
    const a30 = data.adx["30m"];
    const adx30 = a30 ? `ADX ${a30.adx} | DI+ ${a30.diPlus} | DI- ${a30.diMinus}` : "N/A";
    const at30 = data.atr["30m"] ? `${data.atr["30m"].toFixed(dec)}${currencyUnit} (${data.atr["30m_pct"]})` : "N/A";
    const bb30Line = formatBBLine("30M", data.bb_30m);
    const sbr30 = data.sellBuyRate30m !== null && data.sellBuyRate30m !== undefined ? data.sellBuyRate30m.toFixed(2) : "N/A";
    block30m = `
--- INDICADORES 30M (vela cerrada) ---
RSI(14): ${r30}
ADX/DMI(14): ${adx30}
ATR(14): ${at30}
Sell/Buy Rate(34): ${sbr30}
${bb30Line}
`;
  }

  const output = `
PRECIO ACTUAL: ${currencySymbol}${data.precio.toFixed(dec)}${currencyUnit} (1H) | ${currencySymbol}${data.precio4h.toFixed(dec)}${currencyUnit} (4H)
HORA (UTC): ${data.timestamp}

--- INDICADORES 1H ---
RSI(14): ${r1}
ADX/DMI(14): ${adx1}
ATR(14): ${at1}

--- INDICADORES 4H ---
RSI(14): ${r4}
ADX/DMI(14): ${adx4}
ATR(14): ${at4}
${bbLines}
${block30m}
--- SELL/BUY RATES (periodo 34) ---
Valor: ${sbr}
${sbr !== "N/A" ? (data.sellBuyRate > 0 ? "→ Presión COMPRADORA dominante" : "→ Presión VENDEDORA dominante") : ""}

--- REFERENCIA RANGE/SL ---
RANGE del bot grid: usar BB 2H como referencia principal (BB 1H como estructura fina). SL: soporte/resistencia estructural (BB 4H o swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reducir capital y/o leverage (pérdida real proyectada 5-8%).
${has30m ? "MODO SCALP 30M (trade máx 2-3h, profit chico): RANGE con BB 30M/1H. SL estructural (swing 30M/1H o BB) ± 0.5-1×ATR(30m). TP realista: 0.5-1.5×ATR(30m). Ratio TP/SL ≥ 1." : ""}
`;
  return output;
}

function formatTickerText(ticker, label = "DATOS 24H", isBtcBase = false) {
  if (!ticker) {
    return `--- ${label} ---\n• Price Change: N/A\n• Volume (24h): N/A\n• Volume Change: N/A\n`;
  }

  const pc = ticker.percentage !== undefined
    ? `${ticker.percentage > 0 ? "+" : ""}${ticker.percentage.toFixed(2)}%`
    : "N/A";

  const currencySymbol = isBtcBase ? "" : "$";
  const currencyUnit = isBtcBase ? " BTC" : "";

  const vol = ticker.quoteVolume !== undefined
    ? `${currencySymbol}${Number(ticker.quoteVolume).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}${currencyUnit}`
    : "N/A";

  const vc = "N/A";

  return `--- ${label} ---\n• Price Change: ${pc}\n• Volume (24h): ${vol}\n• Volume Change: ${vc}\n`;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getBtcUsdPrice() {
  try {
    const t = await fetchPionexTicker("BTC/USDT:USDT");
    if (t?.last) return t.last;
  } catch (e) {}
  try {
    const t = await exchange.fetchTicker("BTC/USDT:USDT");
    if (t?.last) return t.last;
  } catch (e) {}
  return null;
}

function tickerWithUsdVolume(ticker, isBtcBase, btcUsd) {
  if (!ticker || ticker.quoteVolume == null || !isBtcBase || !btcUsd) return ticker;
  return { ...ticker, quoteVolume: Number(ticker.quoteVolume) * btcUsd };
}

function formatLeverageText(leverage) {
  if (!leverage || !leverage.max) {
    return `--- MAX LEVERAGE ---\nN/A`;
  }
  const src = leverage.source === "pionex" ? "Pionex" : "Bitget";
  let tierLine = "";
  if (leverage.tiers?.length) {
    const tiers = leverage.tiers.slice(0, 4)
      .map(t => `${t.maxLev}x hasta ${t.notional.toLocaleString("en-US")} USDT`)
      .join(" | ");
    tierLine = `\nEscalones por nocional: ${tiers}`;
  }
  return `--- MAX LEVERAGE (${src}) ---\nMáximo disponible: ${leverage.max}x${tierLine}`;
}

function formatFundingText(funding) {
  if (funding === null || funding === undefined || isNaN(funding)) {
    return `--- FUNDING RATE ---\nN/A`;
  }
  return `--- FUNDING RATE ---\n${funding > 0 ? "+" : ""}${funding.toFixed(4)}%`;
}

const MAJOR_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "LINK", "AVAX", "TON", "TRX", "LTC", "DOT", "BCH"];

const MULTI_PAIR_LIST = ["XRP/BTC", "ADA/BTC", "ORDI/BTC", "LINK/BTC", "SUI/BTC", "DOGE/BTC", "SOL/BTC", "PAXG/BTC", "ETH/BTC", "BNB/BTC"];

function evaluateScreener(pairIndicators, ticker, direction, isMajor = false) {
  const dir = (direction || "").toUpperCase();
  if (!["LONG", "SHORT", "NEUTRAL"].includes(dir)) return null;

  const problems = [];
  const add = (msg) => problems.push(msg);

  const rsi1 = pairIndicators.rsi?.["1h"];
  const rsi4 = pairIndicators.rsi?.["4h"];
  const adx1 = pairIndicators.adx?.["1h"]?.adx;
  const adx4 = pairIndicators.adx?.["4h"]?.adx;
  const atr1 = pairIndicators.atr?.["1h_pct"] != null ? parseFloat(pairIndicators.atr["1h_pct"]) : null;
  const volUsd = ticker?.quoteVolume != null ? Number(ticker.quoteVolume) : null;
  const change = ticker?.percentage != null ? Number(ticker.percentage) : null;

  if (volUsd != null && !isNaN(volUsd) && volUsd <= 200000) {
    add(`Volumen 24h ${Math.round(volUsd).toLocaleString("en-US")} USDT ≤ 200K`);
  }

  if (dir === "NEUTRAL") {
    if (adx1 != null && adx1 >= 18) add(`ADX(1h) ${adx1} ≥ 18 (no lateral)`);
    if (adx4 != null && adx4 >= 18) add(`ADX(4h) ${adx4} ≥ 18 (no lateral)`);
    if (rsi1 != null && (rsi1 < 45 || rsi1 > 55)) add(`RSI(1h) ${rsi1.toFixed(1)} fuera de 45-55`);
    if (change != null && (change < -3 || change > 3)) add(`Cambio 24h ${change.toFixed(2)}% fuera de -3% a 3%`);
    const atrMin = isMajor ? 0.30 : 1.8;
    if (atr1 != null && atr1 < atrMin) add(`ATR(1h) ${atr1.toFixed(2)}% < ${atrMin.toFixed(2)}% (Neutral)`);
    return problems.length ? problems : null;
  }

  if (rsi1 != null) {
    if (dir === "LONG" && (rsi1 < 52 || rsi1 > 64)) add(`RSI(1h) ${rsi1.toFixed(1)} fuera de 52-64`);
    if (dir === "SHORT" && (rsi1 < 33 || rsi1 > 45)) add(`RSI(1h) ${rsi1.toFixed(1)} fuera de 33-45`);
  }
  if (rsi4 != null) {
    if (dir === "LONG" && rsi4 < 50) add(`RSI(4h) ${rsi4.toFixed(1)} < 50 (tendencia 4H bajista)`);
    if (dir === "SHORT" && rsi4 > 50) add(`RSI(4h) ${rsi4.toFixed(1)} > 50 (tendencia 4H alcista)`);
  }
  if (adx1 != null && (adx1 < 25 || adx1 > 35)) add(`ADX(1h) ${adx1} fuera de 25-35`);
  if (adx4 != null && (adx4 < 15 || adx4 > 25)) add(`ADX(4h) ${adx4} fuera de 15-25`);
  if (change != null) {
    if (dir === "LONG" && (change < 0 || change > 5)) add(`Cambio 24h ${change.toFixed(2)}% fuera de 0-5%`);
    if (dir === "SHORT" && (change < -5 || change > 0)) add(`Cambio 24h ${change.toFixed(2)}% fuera de -5% a 0%`);
  }
  const atrMin = isMajor ? 0.40 : 1.2;
  if (atr1 != null && atr1 < atrMin) add(`ATR(1h) ${atr1.toFixed(2)}% < ${atrMin.toFixed(2)}%`);

  return problems.length ? problems : null;
}

function evaluateScreener30m(pairIndicators, ticker, direction, isMajor = false) {
  const dir = (direction || "").toUpperCase();
  if (!["LONG", "SHORT", "NEUTRAL"].includes(dir)) return null;

  const problems = [];
  const add = (msg) => problems.push(msg);

  const rsi30 = pairIndicators.rsi?.["30m"];
  const rsi1 = pairIndicators.rsi?.["1h"];
  const adx30Obj = pairIndicators.adx?.["30m"];
  const adx30 = adx30Obj?.adx;
  const diPlus30 = adx30Obj?.diPlus;
  const diMinus30 = adx30Obj?.diMinus;
  const atr30 = pairIndicators.atr?.["30m_pct"] != null ? parseFloat(pairIndicators.atr["30m_pct"]) : null;
  const volUsd = ticker?.quoteVolume != null ? Number(ticker.quoteVolume) : null;

  if (volUsd != null && !isNaN(volUsd) && volUsd <= 200000) {
    add(`Volumen 24h ${Math.round(volUsd).toLocaleString("en-US")} USDT ≤ 200K`);
  }

  if (dir === "NEUTRAL") {
    if (adx30 != null && adx30 >= 15) add(`ADX(30m) ${adx30} ≥ 15 (no lateral)`);
    if (rsi30 != null && (rsi30 < 45 || rsi30 > 55)) add(`RSI(30m) ${rsi30.toFixed(1)} fuera de 45-55`);
    const atrMinN = isMajor ? 0.20 : 1.2;
    if (atr30 != null && atr30 < atrMinN) add(`ATR(30m) ${atr30.toFixed(2)}% < ${atrMinN.toFixed(2)}% (Neutral)`);
    return problems.length ? problems : null;
  }

  if (rsi30 != null) {
    if (dir === "LONG" && (rsi30 < 52 || rsi30 > 72)) add(`RSI(30m) ${rsi30.toFixed(1)} fuera de 52-72`);
    if (dir === "SHORT" && (rsi30 < 28 || rsi30 > 48)) add(`RSI(30m) ${rsi30.toFixed(1)} fuera de 28-48`);
  }
  if (rsi1 != null) {
    if (dir === "LONG" && rsi1 < 45) add(`RSI(1h) ${rsi1.toFixed(1)} < 45 (contexto 1H bajista fuerte)`);
    if (dir === "SHORT" && rsi1 > 55) add(`RSI(1h) ${rsi1.toFixed(1)} > 55 (contexto 1H alcista fuerte)`);
  }
  if (adx30 != null) {
    if (adx30 < 18) add(`ADX(30m) ${adx30} < 18 (sin momentum)`);
    if (adx30 > 50) add(`ADX(30m) ${adx30} > 50 (movimiento agotado)`);
    if (dir === "LONG" && diPlus30 != null && diMinus30 != null && diPlus30 <= diMinus30) {
      add(`DI+(30m) ${diPlus30} ≤ DI-(30m) ${diMinus30}`);
    }
    if (dir === "SHORT" && diPlus30 != null && diMinus30 != null && diMinus30 <= diPlus30) {
      add(`DI-(30m) ${diMinus30} ≤ DI+(30m) ${diPlus30}`);
    }
  }
  const atrMin = isMajor ? 0.25 : 0.8;
  if (atr30 != null && atr30 < atrMin) add(`ATR(30m) ${atr30.toFixed(2)}% < ${atrMin.toFixed(2)}%`);

  return problems.length ? problems : null;
}

function validateAnalysisOutput(content, direction, maxLeverage) {
  if (!content) return content;
  const dir = (direction || "").toUpperCase();
  const warnings = [];

  const extractNum = (label) => {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*\\$?([0-9][0-9.,]*)`);
    const m = content.match(re);
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };

  const entry = extractNum("Entry");
  const sl = extractNum("SL");
  const levMatch = content.match(/Leverage\s*[:\\-]?\s*([0-9]+)x?/i);
  const lev = levMatch ? parseInt(levMatch[1], 10) : null;

  if (entry != null && sl != null && !isNaN(entry) && !isNaN(sl)) {
    if (dir === "LONG" && sl >= entry) warnings.push("SL no está por debajo del Entry (LONG)");
    if (dir === "SHORT" && sl <= entry) warnings.push("SL no está por encima del Entry (SHORT)");
  }

  if (lev != null) {
    if (lev > 4) warnings.push(`Leverage ${lev}x supera el máximo de 4x del protocolo`);
    if (maxLeverage != null && lev > maxLeverage) warnings.push(`Leverage ${lev}x supera el max del par (${maxLeverage}x)`);
  }

  if (!warnings.length) return content;
  return content + "\n\n⚠️ VALIDACIÓN: " + warnings.join(" | ");
}

async function fetchMarketDataForPair(symbol, timeframes = ["1h", "2h", "4h"], source = "auto") {
  if (symbol.endsWith(":BTC") && source === "auto") {
    source = "pionex";
  }

  const needs2h = timeframes.includes("2h");
  const tfs = timeframes.filter(tf => tf !== "2h");

  // Si source es "pionex" → solo Pionex
  if (source === "pionex") {
    const data = await fetchFromPionex(symbol, tfs);
    if (needs2h) data["2h"] = aggregateKlines(data["1h"], 2);
    return { data, exchange: "pionex" };
  }

  // Si source es "bitget" → solo Bitget (sin fallback)
  if (source === "bitget") {
    const results = {};
    let lastError = null;
    for (const tf of tfs) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const ohlcv = await exchange.fetchOHLCV(symbol, tf, undefined, 100);
          console.log(`📊 Bitget ${symbol}: ${tf}=${ohlcv.length} velas`);
          results[tf] = ohlcv;
          break;
        } catch (e) {
          if (e.message?.includes("429") && attempt < 3) {
            await sleep(attempt * 2000);
          } else {
            lastError = e;
            break;
          }
        }
      }
    }
    if (Object.keys(results).length === 0) {
      throw new Error(`Par ${symbol} no disponible en Bitget: ${lastError?.message}`);
    }
    try {
      results._ticker = await exchange.fetchTicker(symbol);
    } catch (e) {
      results._ticker = null;
    }
    try {
      await exchange.loadMarkets();
      const m = exchange.markets[symbol];
      const maxLev = m?.limits?.leverage?.max;
      results._leverage = maxLev ? { max: maxLev, source: "bitget" } : null;
    } catch (e) {
      results._leverage = null;
    }
    try {
      results._funding = await fetchBitgetFunding(symbol);
    } catch (e) {
      results._funding = null;
    }
    if (needs2h) results["2h"] = aggregateKlines(results["1h"], 2);
    return { data: results, exchange: "bitget" };
  }

  // source === "auto" → comportamiento actual (Bitget primario, Pionex fallback)
  let bitgetError = null;
  const results = {};

  for (const tf of tfs) {
    let ohlcv = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        ohlcv = await exchange.fetchOHLCV(symbol, tf, undefined, 100);
        break;
      } catch (e) {
        if (e.message?.includes("429") && attempt < 3) {
          const delay = attempt * 2000;
          console.log(`⏳ Rate limit en Bitget ${tf}, esperando ${delay}ms (intento ${attempt}/3)...`);
          await sleep(delay);
        } else {
          bitgetError = e;
          break;
        }
      }
    }
    if (ohlcv) {
      console.log(`📊 Bitget ${symbol}: ${tf}=${ohlcv.length} velas`);
      results[tf] = ohlcv;
    }
  }

  if (bitgetError && Object.keys(results).length === 0) {
    console.log(`⚠️ Bitget no disponible para ${symbol}: ${bitgetError.message}`);
    console.log(`🔄 Intentando fallback a Pionex...`);
    try {
      const pionexData = await fetchFromPionex(symbol, tfs);
      if (needs2h) pionexData["2h"] = aggregateKlines(pionexData["1h"], 2);
      return { data: pionexData, exchange: "pionex" };
    } catch (e) {
      throw new Error(`Par ${symbol} no disponible en ningún exchange`);
    }
  }

  if (needs2h) results["2h"] = aggregateKlines(results["1h"], 2);

  try {
    const ticker = await exchange.fetchTicker(symbol);
    results._ticker = ticker;
  } catch (e) {
    console.log(`⚠️ No se pudo obtener ticker 24h para ${symbol}: ${e.message}`);
    results._ticker = null;
  }

  try {
    await exchange.loadMarkets();
    const m = exchange.markets[symbol];
    const maxLev = m?.limits?.leverage?.max;
    results._leverage = maxLev ? { max: maxLev, source: "bitget" } : null;
  } catch (e) {
    results._leverage = null;
  }

  try {
    results._funding = await fetchBitgetFunding(symbol);
  } catch (e) {
    results._funding = null;
  }

  return { data: results, exchange: "bitget" };
}

async function fetchMarketData(timeframes = ["1h", "2h", "4h"]) {
  const { data } = await fetchBestEffort("BTC", timeframes);
  return data;
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

async function fetchBestEffort(base, timeframes = ["1h", "2h", "4h"]) {
  const symbol = symbolForPair(base);
  const { data, exchange: sourceExchange } = await fetchMarketDataForPair(symbol, timeframes);
  return { data, market: "futuros", symbol, exchange: sourceExchange };
}

const PIONEX_INTERVALS = {
  "1m": "1M", "5m": "5M", "15m": "15M", "30m": "30M",
  "1h": "60M", "2h": "120M", "4h": "4H", "8h": "8H", "12h": "12H", "1d": "1D"
};

function symbolToPionex(symbol) {
  return symbol.replace("/", "_").replace(/:(USDT|BTC)$/, "_PERP");
}

function intervalToPionex(tf) {
  return PIONEX_INTERVALS[tf] || "60M";
}

function aggregateKlines(ohlcv, factor) {
  if (!ohlcv?.length || factor <= 1) return ohlcv || [];
  const baseMs = ohlcv.length > 1 ? ohlcv[1][0] - ohlcv[0][0] : 3600000;
  const bucketMs = baseMs * factor;
  const out = [];
  let cur = null;
  for (const c of ohlcv) {
    const bucket = Math.floor(c[0] / bucketMs) * bucketMs;
    if (!cur || cur[0] !== bucket) {
      if (cur) out.push(cur);
      cur = [bucket, c[1], c[2], c[3], c[4], c[5]];
    } else {
      cur[2] = Math.max(cur[2], c[2]);
      cur[3] = Math.min(cur[3], c[3]);
      cur[4] = c[4];
      cur[5] += c[5];
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function fetchPionexKlines(symbol, interval, limit = 100) {
  const pionexSymbol = symbolToPionex(symbol);
  const pionexInterval = intervalToPionex(interval);
  const url = `https://api.pionex.com/api/v1/market/klines?symbol=${pionexSymbol}&interval=${pionexInterval}&limit=${limit}`;

  const response = await axios.get(url, { timeout: 15000 });

  if (!response.data?.result || !response.data?.data?.klines) {
    throw new Error(`Pionex klines error: ${JSON.stringify(response.data)}`);
  }

  const klines = response.data.data.klines;
  return klines.map(k => [
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

  if (!response.data?.result || !response.data?.data?.tickers?.length) {
    return null;
  }

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

async function fetchPionexRiskTable(symbol) {
  const pionexSymbol = symbolToPionex(symbol);
  const url = `https://api.pionex.com/api/v1/common/riskTable?symbol=${pionexSymbol}`;

  const response = await axios.get(url, { timeout: 15000 });

  if (!response.data?.result || !response.data?.data?.symbols?.length) {
    return null;
  }

  const sym = response.data.data.symbols[0];
  const tiers = (sym.rows || []).map(r => ({
    notional: parseFloat(r.notionalLimit),
    maxLev: parseFloat(r.maxLeverage)
  })).filter(r => !isNaN(r.maxLev) && !isNaN(r.notional));

  if (!tiers.length) return null;

  return { max: Math.max(...tiers.map(t => t.maxLev)), tiers, source: "pionex" };
}

async function fetchPionexFunding(symbol) {
  const pionexSymbol = symbolToPionex(symbol);
  const url = `https://api.pionex.com/api/v1/market/fundingRates?symbol=${pionexSymbol}`;

  const response = await axios.get(url, { timeout: 15000 });

  if (!response.data?.result || !response.data?.data?.rates?.length) {
    return null;
  }

  const rate = parseFloat(response.data.data.rates[0].fundingRate);
  return isNaN(rate) ? null : rate * 100;
}

async function fetchBitgetFunding(symbol) {
  const bitgetSymbol = symbol.replace("/USDT:USDT", "USDT");
  const url = `https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES&symbol=${bitgetSymbol}`;

  const response = await axios.get(url, { timeout: 15000 });

  if (response.data?.code !== "00000" || !response.data?.data?.length) {
    return null;
  }

  const rate = parseFloat(response.data.data[0].fundingRate);
  return isNaN(rate) ? null : rate * 100;
}

async function fetchFromPionex(symbol, timeframes = ["1h", "2h", "4h"]) {
  const needs2h = timeframes.includes("2h");
  const tfs = timeframes.filter(tf => tf !== "2h");
  const results = {};
  for (const tf of tfs) {
    try {
      const ohlcv = await fetchPionexKlines(symbol, tf, 100);
      console.log(`📊 Pionex ${symbol}: ${tf}=${ohlcv.length} velas`);
      results[tf] = ohlcv;
    } catch (e) {
      console.log(`⚠️ Pionex klines falló ${symbol} ${tf}: ${e.message}`);
      results[tf] = [];
    }
  }

  if (needs2h && results["1h"]?.length > 0) {
    results["2h"] = aggregateKlines(results["1h"], 2);
    console.log(`🔁 Pionex ${symbol}: 2h sintetizada desde 1h (${results["2h"].length} velas)`);
  }

  try {
    results._ticker = await fetchPionexTicker(symbol);
  } catch (e) {
    console.log(`⚠️ Pionex ticker falló ${symbol}: ${e.message}`);
    results._ticker = null;
  }

  try {
    results._leverage = await fetchPionexRiskTable(symbol);
  } catch (e) {
    console.log(`⚠️ Pionex riskTable falló ${symbol}: ${e.message}`);
    results._leverage = null;
  }

  try {
    results._funding = await fetchPionexFunding(symbol);
  } catch (e) {
    console.log(`⚠️ Pionex funding falló ${symbol}: ${e.message}`);
    results._funding = null;
  }

  const hasData = timeframes.some(tf => results[tf]?.length > 0);
  if (!hasData) {
    throw new Error(`Par ${symbol} no disponible en Pionex`);
  }

  return results;
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

async function tryWithFallback(messages, modelIndex = 0) {
  if (modelIndex >= AI_MODELS.length) {
    throw new Error("All models failed");
  }
  
  try {
    console.log(`🧠 Usando modelo: ${AI_MODELS[modelIndex]}`);
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: AI_MODELS[modelIndex],
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
    console.warn(`⚠️ Modelo ${AI_MODELS[modelIndex]} falló, intentando siguiente...`);
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
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles. Para BTCUSDT, el umbral de ATR(1h) en el Screener es >0.40% (no >1.2% como en altcoins).
2. Sigue el checklist del punto 12 del protocolo
3. Determina: BOT LONG, BOT SHORT, BOT NEUTRAL o NO TRADE
4. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
5. Si es LONG o SHORT: calcula SL estructural+ATR, rango, grids, leverage por convicción
6. Si es NEUTRAL: el precio está en rango lateral (ADX bajo, RSI cercano a 50). Calcula un range donde el bot opere comprando en el inferior y vendiendo en el superior, con SL por fuera del range en ambas direcciones
7. NO muestres capital ni cálculos intermedios
8. EXTRA: RANGE del bot grid con BB 2H como referencia principal (BB 1H = estructura fina). SL = soporte/resistencia estructural (BB 4H/swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reduce capital (Sección 4) y/o leverage (Sección 5): pérdida real proyectada 5-8%. El leverage final (máx 4x por protocolo) debe ser ≤ al MAX LEVERAGE del par mostrado en los datos; si el máximo del par es bajo, dimensiona range/SL/exposición más conservador y señala si no alcanza para la convicción deseada.
9. Alineación y crowding: para LONG el RSI(4h) debe estar ≥ 50 (tendencia 4H a favor) y el FUNDING RATE no debe ser positivamente elevado (>0.05% = longs hacinados). Para SHORT el RSI(4h) debe estar ≤ 50 y el funding no debe ser negativamente elevado (<-0.05% = shorts hacinados). Si el funding es extremo, reduce convicción o pasa a NO TRADE.

RESPONDE EN ESPAÑOL. Máximo 15 líneas. Formato EXACTO:

✅ BOT LONG / ✅ BOT SHORT / ✅ BOT NEUTRAL
• Entry: $XX.XXX
• SL: $XX.XXX
• TP: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• Leverage: Xx

LONG: SL inferior, TP superior. SHORT: SL superior, TP inferior. NEUTRAL: Range donde opera, SL fuera del range en ambas direcciones.`
    }
  ]);
}

async function analyzeWithAI30m(indicatorsText, ticker = null, symbolLabel = "BTCUSDT") {
  const tickerText = formatTickerText(ticker, "DATOS 24H " + symbolLabel);
  return tryWithFallback([
    {
      role: "user",
      content: `Eres un trader profesional de criptomonedas especializado en SCALPING con bots grid de CORTA DURACIÓN (máximo 2-3 horas por trade). Analiza los siguientes datos de ${symbolLabel}.

DATOS DEL MERCADO (30M recién cerrada + contexto 1H/2H/4H):
${indicatorsText}
${tickerText}
PROTOCOLO DE TRADING (referencia general):
${protocolo}

CONTEXTO DEL FLUJO:
- Este análisis se dispara al minuto 30 de cada hora con la vela de 30M recién cerrada.
- Objetivo: abrir un bot grid de corta duración (máx 2-3 horas) que capture un profit chico y salga.

INSTRUCCIONES:
1. Prioriza los indicadores de 30M para el timing de entrada; usa 1H y 4H solo como contexto de tendencia mayor.
2. Si la señal va CONTRA la tendencia de 4H (ej: SHORT con RSI(4h) alto en tendencia alcista, o LONG en caída), solo la aceptas si el momentum 30M está claramente girado a favor (ADX(30m) ≥ 18 con DI a favor, RSI(30m) cruzando la zona de entrada) y en ese caso reduce leverage y objetivo. Señala explícitamente que es contra-tendencia.
3. TP chico y realista: entre 0.5× y 1.5× ATR(30m) desde el entry. SL estructural (swing 30M/1H o banda BB) ± 0.5-1× ATR(30m). La relación TP/SL debe ser ≥ 1; si no lo es, NO TRADE.
4. Range del bot grid: BB 30M como referencia principal (BB 1H si la de 30M es demasiado estrecha). Grids pocos (4-8).
5. Leverage máximo 3x para este flujo aunque el par permita más; debe ser ≤ al MAX LEVERAGE del par mostrado en los datos.
6. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13).
7. Determina: BOT LONG, BOT SHORT, BOT NEUTRAL o NO TRADE
8. Si es NO TRADE: responde solo "❌ NO TRADE" y el motivo en 1 línea.
9. Crowding: LONG exige FUNDING RATE ≤ 0.05%; SHORT exige FUNDING RATE ≥ -0.05%. Funding extremo → baja convicción o NO TRADE.
10. NO muestres capital ni cálculos intermedios.

RESPONDE EN ESPAÑOL. Máximo 12 líneas. Formato EXACTO:

⏱️ BOT 30M LONG / ⏱️ BOT 30M SHORT / ⏱️ BOT 30M NEUTRAL
• Entry: $XX.XXX
• SL: $XX.XXX
• TP: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• Leverage: Xx
• Duración estimada: Xh

LONG: SL inferior, TP superior. SHORT: SL superior, TP inferior. NEUTRAL: Range donde opera, SL fuera del range en ambas direcciones.`
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

async function analyzePair(base, timeframes = ["1h", "2h", "4h"]) {
  console.log(`🔍 Analizando par: ${base}`);

  const [btcResult, pairResult] = await Promise.all([
    fetchBestEffort("BTC", timeframes),
    fetchBestEffort(base, timeframes)
  ]);

  const isBtcBase = pairResult.symbol.endsWith(":BTC");
  const btcIndicators = getLatestIndicators(btcResult.data["1h"], btcResult.data["4h"], btcResult.data["2h"]);
  const pairIndicators = getLatestIndicators(pairResult.data["1h"], pairResult.data["4h"], pairResult.data["2h"]);
  const btcText = formatIndicatorsText(btcIndicators, false);
  const pairText = formatIndicatorsText(pairIndicators, isBtcBase) + "\n" + formatLeverageText(pairResult.data._leverage) + "\n" + formatFundingText(pairResult.data._funding);
  const btcTickerText = formatTickerText(btcResult.data._ticker, "DATOS 24H BTC", false);
  const btcUsdForPair = isBtcBase ? await getBtcUsdPrice() : null;
  const pairTickerText = formatTickerText(tickerWithUsdVolume(pairResult.data._ticker, isBtcBase, btcUsdForPair), "DATOS 24H " + pairResult.symbol + (isBtcBase ? " [volumen 24h en USD]" : ""), false);

  let content = "";
  if (isBtcBase) {
    content = `Eres un trader profesional de criptomonedas.

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
4. Determina: BOT LONG, BOT SHORT, BOT NEUTRAL o NO TRADE. Dado que este par se cotiza en BTC, la recomendación debe ser exclusivamente para un BOT GRID (no dejes abierta una opción de futuros convencionales).
5. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
6. Si es LONG o SHORT: calcula SL estructural+ATR, rango, grids, leverage por convicción (máximo 4x según protocolo)
7. Si es NEUTRAL: el precio está en rango lateral (ADX bajo, RSI cercano a 50). Calcula un range donde el bot opere comprando en el inferior y vendiendo en el superior, con SL por fuera del range en ambas direcciones
8. NO muestres capital ni cálculos intermedios
9. EXTRA: RANGE del bot grid con BB 2H como referencia principal (BB 1H = estructura fina). SL = soporte/resistencia estructural (BB 4H/swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reduce capital (Sección 4) y/o leverage (Sección 5): pérdida real proyectada 5-8%. El leverage final (máx 4x por protocolo) debe ser ≤ al MAX LEVERAGE del par mostrado en los datos; si el máximo del par es bajo, dimensiona range/SL/exposición más conservador y señala si no alcanza para la convicción deseada.
10. Alineación y crowding: para LONG el RSI(4h) debe estar ≥ 50 (tendencia 4H a favor) y el FUNDING RATE no debe ser positivamente elevado (>0.05% = longs hacinados). Para SHORT el RSI(4h) debe estar ≤ 50 y el funding no debe ser negativamente elevado (<-0.05% = shorts hacinados). Si el funding es extremo, reduce convicción o pasa a NO TRADE.

RESPONDE EN ESPAÑOL. Máximo 20 líneas. Formato EXACTO para el análisis del par:

✅ BOT LONG / ✅ BOT SHORT / ✅ BOT NEUTRAL
• Entry: XX.XXX BTC
• SL: XX.XXX BTC
• TP: XX.XXX BTC
• Range: XX.XXX - XX.XXX BTC
• Grids: XX
• Leverage: Xx

LONG: SL inferior, TP superior. SHORT: SL superior, TP inferior. NEUTRAL: Range donde opera, SL fuera del range en ambas direcciones.`;
  } else {
    content = `Eres un trader profesional de criptomonedas.

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
4. Determina: BOT LONG, BOT SHORT, BOT NEUTRAL o NO TRADE
5. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
6. Si es LONG o SHORT: calcula SL estructural+ATR, rango, grids, leverage por convicción
7. Si es NEUTRAL: el precio está en rango lateral (ADX bajo, RSI cercano a 50). Calcula un range donde el bot opere comprando en el inferior y vendiendo en el superior, con SL por fuera del range en ambas direcciones
8. NO muestres capital ni cálculos intermedios
9. EXTRA: RANGE del bot grid con BB 2H como referencia principal (BB 1H = estructura fina). SL = soporte/resistencia estructural (BB 4H/swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reduce capital (Sección 4) y/o leverage (Sección 5): pérdida real proyectada 5-8%. El leverage final (máx 4x por protocolo) debe ser ≤ al MAX LEVERAGE del par mostrado en los datos; si el máximo del par es bajo, dimensiona range/SL/exposición más conservador y señala si no alcanza para la convicción deseada.
10. Alineación y crowding: para LONG el RSI(4h) debe estar ≥ 50 (tendencia 4H a favor) y el FUNDING RATE no debe ser positivamente elevado (>0.05% = longs hacinados). Para SHORT el RSI(4h) debe estar ≤ 50 y el funding no debe ser negativamente elevado (<-0.05% = shorts hacinados). Si el funding es extremo, reduce convicción o pasa a NO TRADE.

RESPONDE EN ESPAÑOL. Máximo 20 líneas. Formato EXACTO para el análisis del par:

✅ BOT LONG / ✅ BOT SHORT / ✅ BOT NEUTRAL
• Entry: $XX.XXX
• SL: $XX.XXX
• TP: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• Leverage: Xx

LONG: SL inferior, TP superior. SHORT: SL superior, TP inferior. NEUTRAL: Range donde opera, SL fuera del range en ambas direcciones.`;
  }

  return openRouterChat([{ role: "user", content }]);
}

async function chatWithAI(userMessage) {
  console.log("💬 Chat libre con IA...");

  const btcData = await fetchMarketData(["1h", "2h", "4h"]);
  const btcIndicators = getLatestIndicators(btcData["1h"], btcData["4h"], btcData["2h"]);
  const btcText = formatIndicatorsText(btcIndicators) + "\n" + formatLeverageText(btcData._leverage) + "\n" + formatFundingText(btcData._funding);
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
const VALID_SOURCES = ["BITGET", "PIONEX"];

function parseFlexibleCommand(text) {
  const cleanText = text.replace(/^\//, "").trim();
  const upperParts = cleanText.toUpperCase().split(/\s+/).map(p => p.replace(/[?!.,]+$/, ""));
  
  if (upperParts.length === 0) return null;
  
  const firstPart = upperParts[0];
  const btcMatch = firstPart.match(/^([A-Z0-9]+)[/_]?(BTC)$/);
  
  let symbol = "";
  if (btcMatch && btcMatch[1] !== "BTC") {
    symbol = `${btcMatch[1]}/BTC`;
  } else {
    symbol = firstPart.replace(/USDT\s*$/, "").trim();
  }
  
  if (!symbol) return null;

  // Detectar fuente (BITGET o PIONEX)
  let source = null;
  for (let i = 1; i < upperParts.length; i++) {
    if (VALID_SOURCES.includes(upperParts[i])) {
      source = upperParts[i].toLowerCase();
      break;
    }
  }

  // Filtrar partes que no son fuente
  const parts = upperParts.filter(p => !VALID_SOURCES.includes(p));

  const firstParam = parts[1] || null;
  const isIndicator = VALID_INDICATORS.includes(firstParam);
  const isTimeframe = VALID_TIMEFRAMES.includes(firstParam?.toLowerCase());
  
  let indicator = isIndicator ? firstParam : null;
  let timeframe = null;
  let allIndicators = false;
  
  if (isTimeframe) {
    timeframe = firstParam.toLowerCase();
    allIndicators = true;
  } else if (!isIndicator && parts[2] && VALID_TIMEFRAMES.includes(parts[2].toLowerCase())) {
    timeframe = parts[2].toLowerCase();
  }
  
  const isFutures = parts.includes("FUTUROS") || parts.includes("FUTURES");
  
  const hasLong = parts.includes("LONG") && !parts.includes("SHORT");
  const hasShort = parts.includes("SHORT") && !parts.includes("LONG");
  const hasNeutral = parts.includes("NEUTRAL") && !hasLong && !hasShort;
  
  const hasBotKeyword = parts.includes("BOT");
  const hasComparisonMode = hasBotKeyword && isFutures;

  // Si hay source, el botIntent se activa solo con LONG/SHORT/NEUTRAL
  const hasDirectionKeyword = hasLong || hasShort || hasNeutral;
  const botIntent = hasDirectionKeyword && (hasBotKeyword || isFutures || source)
    ? (hasLong ? "LONG" : hasShort ? "SHORT" : "NEUTRAL")
    : null;

  return {
    symbol,
    indicator,
    timeframe,
    allIndicators,
    isFutures,
    source,
    botIntent,
    comparisonMode: hasComparisonMode && !!botIntent
  };
}

function formatSingleIndicator(ind, tf, data, isBtcBase = false) {
  const dec = decimalsForPrice(data.precio, isBtcBase);
  const currencyUnit = isBtcBase ? " BTC" : "";
  
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
    return `ATR(14) ${tf}: ${atr.toFixed(dec)}${currencyUnit} (${pct})`;
  }
  
  if (ind === "BB" || ind === "BOLINGER") {
    const bb = data.bb ?? data.bb_4h;
    if (!bb) return `BB ${tf}: N/A`;
    return `BB(20,2) ${tf} | Upper: ${bb.upper.toFixed(dec)}${currencyUnit} | Mid: ${bb.middle.toFixed(dec)}${currencyUnit} | Lower: ${bb.lower.toFixed(dec)}${currencyUnit}`;
  }
  
  if (ind === "SBR" || ind === "SELLBUYRATE") {
    const sbr = data.sellBuyRate;
    if (sbr === null || sbr === undefined) return `Sell/Buy Rate: N/A`;
    return `Sell/Buy Rate ${tf}: ${sbr.toFixed(2)} ${sbr > 0 ? "→ COMPRADOR" : "→ VENDEDOR"}`;
  }
  
  return "Indicador no disponible";
}

async function getSingleIndicator(symbol, indicator, timeframe) {
  const timeframes = timeframe ? [timeframe] : ["1h", "2h", "4h"];
  const sym = symbolForPair(symbol);
  const { data } = await fetchMarketDataForPair(sym, timeframes);
  const isBtcBase = sym.endsWith(":BTC");
  
  if (timeframe && timeframes.length === 1) {
    const ind = getIndicatorsForTimeframe(data[timeframe], timeframe);
    return formatSingleIndicator(indicator, timeframe, ind, isBtcBase);
  }
  
  const ind = getLatestIndicators(data["1h"], data["4h"], data["2h"]);
  const results = [];
  for (const tf of timeframes) {
    const tfData = getIndicatorsForTimeframe(data[tf], tf);
    results.push(formatSingleIndicator(indicator, tf, tfData, isBtcBase));
  }
  return results.join("\n");
}

async function getAllIndicatorsForTimeframe(symbol, timeframe) {
  const sym = symbolForPair(symbol);
  const { data, exchange: sourceExchange } = await fetchMarketDataForPair(sym, [timeframe]);
  const isBtcBase = sym.endsWith(":BTC");
  
  const ind = getIndicatorsForTimeframe(data[timeframe], timeframe);
  const dec = decimalsForPrice(ind.precio, isBtcBase);
  const currencySymbol = isBtcBase ? "" : "$";
  const currencyUnit = isBtcBase ? " BTC" : "";
  
  return `📊 *${sym}* (${sourceExchange === "pionex" ? "Pionex" : "Bitget"} Futures) - *${timeframe.toUpperCase()}*\n\n` +
    `Precio: ${currencySymbol}${ind.precio.toFixed(dec)}${currencyUnit}\n` +
    `Hora: ${ind.timestamp}\n\n` +
    `• ${formatSingleIndicator("RSI", timeframe, ind, isBtcBase)}\n` +
    `• ${formatSingleIndicator("ADX", timeframe, ind, isBtcBase)}\n` +
    `• ${formatSingleIndicator("ATR", timeframe, ind, isBtcBase)}\n` +
    `• ${formatSingleIndicator("BB", timeframe, ind, isBtcBase)}\n` +
    `• ${formatSingleIndicator("SBR", timeframe, ind, isBtcBase)}`;
}

async function analyzeBotOpportunity(symbol, direction) {
  const timeframes = ["1h", "2h", "4h"];
  const sym = symbolForPair(symbol);
  const { data, exchange: sourceExchange } = await fetchMarketDataForPair(sym, timeframes);
  
  const isBtcBase = sym.endsWith(":BTC");
  const pairIndicators = getLatestIndicators(data["1h"], data["4h"], data["2h"]);
  const pairText = formatIndicatorsText(pairIndicators, isBtcBase) + "\n" + formatLeverageText(data._leverage) + "\n" + formatFundingText(data._funding);
  const btcUsd = isBtcBase ? await getBtcUsdPrice() : null;
  const tickerText = formatTickerText(tickerWithUsdVolume(data._ticker, isBtcBase, btcUsd), "DATOS 24H " + sym + (isBtcBase ? " [volumen 24h en USD]" : ""), false);

  const isNeutral = direction.toUpperCase() === "NEUTRAL";
  const directionLabel = isNeutral ? "NEUTRAL" : direction.toUpperCase();
  const currencySymbol = isBtcBase ? "" : "$";
  const currencyUnit = isBtcBase ? " BTC" : "";

  const isMajor = isBtcBase || MAJOR_COINS.includes(sym.split("/")[0].toUpperCase());
  const screenerProblems = evaluateScreener(pairIndicators, tickerWithUsdVolume(data._ticker, isBtcBase, btcUsd), directionLabel, isMajor);
  if (screenerProblems) {
    return `❌ NO TRADE\n\nNo cumple los filtros del Screener (Sección 13 del protocolo) para BOT ${directionLabel}:\n• ${screenerProblems.join("\n• ")}`;
  }

  return openRouterChat([{
    role: "user",
    content: `Eres un trader profesional. Analiza si es buena oportunidad para BOT ${directionLabel} en ${sym} (${sourceExchange === "pionex" ? "Pionex" : "Bitget"} Futures) siguiendo ESTRICTAMENTE el protocolo.

DATOS DEL PAR ${sym} (${sourceExchange === "pionex" ? "Pionex" : "Bitget"} Futures):
${pairText}
${tickerText}
PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles.
2. Aplica el checklist del punto 12 del protocolo
3. Determina: ✅ BOT ${directionLabel} o ❌ NO TRADE
4. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
5. Si es ${directionLabel}: calcula SL, rango, grids, leverage (máximo 4x según protocolo)
${isNeutral ? "6. Para NEUTRAL: el precio está en rango lateral (ADX bajo, RSI cercano a 50). Calcula un range donde el bot opere comprando en el inferior y vendiendo en el superior, con SL por fuera del range en ambas direcciones" : ""}
${isNeutral ? "7. " : "6. "}EXTRA: RANGE del bot grid con BB 2H como referencia principal (BB 1H = estructura fina). SL = soporte/resistencia estructural (BB 4H/swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reduce capital (Sección 4) y/o leverage (Sección 5): pérdida real proyectada 5-8%. El leverage final (máx 4x por protocolo) debe ser ≤ al MAX LEVERAGE del par mostrado en los datos; si el máximo del par es bajo, dimensiona range/SL/exposición más conservador y señala si no alcanza para la convicción deseada.
${isNeutral ? "8. " : "7. "}Alineación y crowding: para LONG el RSI(4h) debe estar ≥ 50 (tendencia 4H a favor) y el FUNDING RATE no debe ser positivamente elevado (>0.05% = longs hacinados). Para SHORT el RSI(4h) debe estar ≤ 50 y el funding no debe ser negativamente elevado (<-0.05% = shorts hacinados). Si el funding es extremo, reduce convicción o pasa a NO TRADE.

RESPONDE EN ESPAÑOL. Máximo 15 líneas. Formato EXACTO:

✅ BOT ${directionLabel}
• Entry: ${currencySymbol}XX.XXX${currencyUnit}
• SL: ${currencySymbol}XX.XXX${currencyUnit}
• TP: ${currencySymbol}XX.XXX${currencyUnit}
• Range: ${currencySymbol}XX.XXX - ${currencySymbol}XX.XXX${currencyUnit}
• Grids: XX
• Leverage: Xx

${isNeutral ? "NEUTRAL: Range donde opera el bot, SL fuera del range en ambas direcciones." : `SL/TP según protocolo: ${directionLabel === "LONG" ? "SL es límite inferior, TP límite superior" : "SL es límite superior, TP límite inferior"}.`}`
  }]).then(res => validateAnalysisOutput(res, directionLabel, data._leverage?.max || null));
}

async function compareBotVsFutures(symbol, direction) {
  const timeframes = ["1h", "2h", "4h"];
  const sym = symbolForPair(symbol);
  const { data, exchange: sourceExchange } = await fetchMarketDataForPair(sym, timeframes);

  const pairIndicators = getLatestIndicators(data["1h"], data["4h"], data["2h"]);
  const pairText = formatIndicatorsText(pairIndicators) + "\n" + formatLeverageText(data._leverage) + "\n" + formatFundingText(data._funding);

  const isNeutral = direction.toUpperCase() === "NEUTRAL";
  const directionLabel = isNeutral ? "NEUTRAL" : direction.toUpperCase();

  const isBtcBase = sym.endsWith(":BTC");
  const btcUsd = isBtcBase ? await getBtcUsdPrice() : null;
  const tickerText = formatTickerText(tickerWithUsdVolume(data._ticker, isBtcBase, btcUsd), "DATOS 24H " + sym + (isBtcBase ? " [volumen 24h en USD]" : ""), false);
  const isMajor = MAJOR_COINS.includes(sym.split("/")[0].toUpperCase());
  const screenerProblems = evaluateScreener(pairIndicators, tickerWithUsdVolume(data._ticker, isBtcBase, btcUsd), directionLabel, isMajor);
  if (screenerProblems) {
    return `❌ NO TRADE\n\nNo cumple los filtros del Screener (Sección 13 del protocolo) para ${directionLabel}:\n• ${screenerProblems.join("\n• ")}`;
  }

  return openRouterChat([{
    role: "user",
    content: `Eres un trader profesional de criptomonedas. Analiza si es mejor usar un BOT GRID o FUTUROS para una operación ${directionLabel} en ${sym} (${sourceExchange === "pionex" ? "Pionex" : "Bitget"} Futures).

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
5. Si el mercado está en rango (ADX bajo, RSI ~50), el BOT GRID (especialmente NEUTRAL) suele ser mejor. Si hay tendencia fuerte (ADX alto), los FUTUROS pueden ser mejores.
6. EXTRA: RANGE del bot grid con BB 2H como referencia principal (BB 1H = estructura fina). SL = soporte/resistencia estructural (BB 4H/swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reduce capital (Sección 4) y/o leverage (Sección 5): pérdida real proyectada 5-8%. El leverage final (máx 4x por protocolo) debe ser ≤ al MAX LEVERAGE del par mostrado en los datos; si el máximo del par es bajo, dimensiona range/SL/exposición más conservador y señala si no alcanza para la convicción deseada.
7. Alineación y crowding: para LONG el RSI(4h) debe estar ≥ 50 (tendencia 4H a favor) y el FUNDING RATE no debe ser positivamente elevado (>0.05% = longs hacinados). Para SHORT el RSI(4h) debe estar ≤ 50 y el funding no debe ser negativamente elevado (<-0.05% = shorts hacinados). Si el funding es extremo, reduce convicción o pasa a NO TRADE.

RESPONDE EN ESPAÑOL. Máximo 25 líneas. Formato EXACTO:

📊 COMPARACIÓN ${sym} — ${directionLabel}

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

${isNeutral ? "NEUTRAL: El bot grid opera comprando en el inferior del range y vendiendo en el superior. SL fuera del range en ambas direcciones." : `Para LONG: SL es límite inferior, TP es límite superior. Para SHORT: SL es límite superior, TP es límite inferior.`}`
  }]).then(res => validateAnalysisOutput(res, directionLabel, data._leverage?.max || null));
}

async function analyzePairWithSource(base, source, direction) {
  const timeframes = ["1h", "2h", "4h"];
  const sym = symbolForPair(base);
  const { data, exchange: sourceExchange } = await fetchMarketDataForPair(sym, timeframes, source);

  const isBtcBase = sym.endsWith(":BTC");
  const pairIndicators = getLatestIndicators(data["1h"], data["4h"], data["2h"]);
  const pairText = formatIndicatorsText(pairIndicators, isBtcBase) + "\n" + formatLeverageText(data._leverage) + "\n" + formatFundingText(data._funding);

  const isNeutral = direction.toUpperCase() === "NEUTRAL";
  const directionLabel = isNeutral ? "NEUTRAL" : direction.toUpperCase();
  const sourceLabel = sourceExchange === "pionex" ? "Pionex" : "Bitget";

  const isMajor = isBtcBase || MAJOR_COINS.includes(sym.split("/")[0].toUpperCase());
  const btcUsd = isBtcBase ? await getBtcUsdPrice() : null;
  const tickerText = formatTickerText(tickerWithUsdVolume(data._ticker, isBtcBase, btcUsd), "DATOS 24H " + sym + (isBtcBase ? " [volumen 24h en USD]" : ""), false);
  const screenerProblems = evaluateScreener(pairIndicators, tickerWithUsdVolume(data._ticker, isBtcBase, btcUsd), directionLabel, isMajor);
  if (screenerProblems) {
    return `❌ NO TRADE\n\nNo cumple los filtros del Screener (Sección 13 del protocolo) para BOT ${directionLabel} (${sourceLabel}):\n• ${screenerProblems.join("\n• ")}`;
  }

  if (isBtcBase) {
    return openRouterChat([{
      role: "user",
      content: `Eres un trader profesional. Analiza si es buena oportunidad para BOT ${directionLabel} en ${sym} (${sourceLabel}) siguiendo ESTRICTAMENTE el protocolo.

DATOS DEL PAR ${sym} (${sourceLabel}):
${pairText}
${tickerText}
PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles.
2. Aplica el checklist del punto 12 del protocolo
3. Determina: ✅ BOT ${directionLabel} o ❌ NO TRADE
4. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
5. Si es ${directionLabel}: calcula SL, rango, grids, leverage (máximo 4x según protocolo)
${isNeutral ? "6. Para NEUTRAL: el precio está en rango lateral (ADX bajo, RSI cercano a 50). Calcula un range donde el bot opere comprando en el inferior y vendiendo en el superior, con SL por fuera del range en ambas direcciones" : ""}
${isNeutral ? "7. " : "6. "}EXTRA: RANGE del bot grid con BB 2H como referencia principal (BB 1H = estructura fina). SL = soporte/resistencia estructural (BB 4H/swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reduce capital (Sección 4) y/o leverage (Sección 5): pérdida real proyectada 5-8%. El leverage final (máx 4x por protocolo) debe ser ≤ al MAX LEVERAGE del par mostrado en los datos; si el máximo del par es bajo, dimensiona range/SL/exposición más conservador y señala si no alcanza para la convicción deseada.
${isNeutral ? "8. " : "7. "}Alineación y crowding: para LONG el RSI(4h) debe estar ≥ 50 (tendencia 4H a favor) y el FUNDING RATE no debe ser positivamente elevado (>0.05% = longs hacinados). Para SHORT el RSI(4h) debe estar ≤ 50 y el funding no debe ser negativamente elevado (<-0.05% = shorts hacinados). Si el funding es extremo, reduce convicción o pasa a NO TRADE.

RESPONDE EN ESPAÑOL. Máximo 15 líneas. Formato EXACTO:

✅ BOT ${directionLabel}
• Entry: XX.XXX BTC
• SL: XX.XXX BTC
• TP: XX.XXX BTC
• Range: XX.XXX - XX.XXX BTC
• Grids: XX
• Leverage: Xx

${isNeutral ? "NEUTRAL: Range donde opera el bot, SL fuera del range en ambas direcciones." : `SL/TP según protocolo: ${directionLabel === "LONG" ? "SL es límite inferior, TP límite superior" : "SL es límite superior, TP límite inferior"}.`}`
    }]).then(res => validateAnalysisOutput(res, directionLabel, data._leverage?.max || null));
  }

  if (isNeutral) {
    return openRouterChat([{
      role: "user",
      content: `Eres un trader profesional. Analiza si es buena oportunidad para BOT NEUTRAL en ${sym} (${sourceLabel}) siguiendo ESTRICTAMENTE el protocolo.

DATOS DEL PAR ${sym} (${sourceLabel}):
${pairText}
${tickerText}
PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles.
2. Aplica el checklist del punto 12 del protocolo
3. Determina: ✅ BOT NEUTRAL o ❌ NO TRADE
4. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
5. Para NEUTRAL: el precio está en rango lateral (ADX bajo, RSI cercano a 50). Calcula un range donde el bot opere comprando en el inferior y vendiendo en el superior, con SL por fuera del range en ambas direcciones
6. EXTRA: RANGE del bot grid con BB 2H como referencia principal (BB 1H = estructura fina). SL = soporte/resistencia estructural (BB 4H/swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reduce capital (Sección 4) y/o leverage (Sección 5): pérdida real proyectada 5-8%. El leverage final (máx 4x por protocolo) debe ser ≤ al MAX LEVERAGE del par mostrado en los datos; si el máximo del par es bajo, dimensiona range/SL/exposición más conservador y señala si no alcanza para la convicción deseada.
7. Crowding: si el FUNDING RATE es extremo (|funding| > 0.05%), considera range más estrecho o NO TRADE (el mercado está hacinado en una dirección).

RESPONDE EN ESPAÑOL. Máximo 15 líneas. Formato EXACTO:

✅ BOT NEUTRAL
• Entry: $XX.XXX
• SL: $XX.XXX
• TP: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• Leverage: Xx

NEUTRAL: Range donde opera el bot, SL fuera del range en ambas direcciones.`
    }]).then(res => validateAnalysisOutput(res, "NEUTRAL", data._leverage?.max || null));
  }

  return openRouterChat([{
    role: "user",
    content: `Eres un trader profesional. Analiza si es conveniente abrir un BOT o FUTUROS para ${directionLabel} en ${sym} (${sourceLabel}).

FUENTE DE DATOS: ${sourceLabel}
DATOS DEL PAR ${sym}:
${pairText}
${tickerText}
PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Si Price Change 24h, Volume (24h) o Volume Change aparecen como "N/A", ignora esos filtros específicos del Screener (Sección 13) y evalúa la entrada con todos los demás parámetros disponibles.
2. Analiza si los indicadores cumplen los parámetros del protocolo para ${directionLabel}
3. Evalúa AMBAS opciones: BOT GRID y FUTUROS
4. Para cada opción, determina si cumple los filtros del Screener (Sección 13)
5. Si AMBAS no cumplen → "❌ NO TRADE" con motivo
6. Si solo Bot cumple → muestra Bot con 100% de capital
7. Si solo Futuros cumple → muestra Futuros con 100% de capital
8. Si ambas cumplen → distribuye el capital recomendado entre ambas (ej: 60% Bot / 40% Futuros)
9. EXTRA: RANGE del bot grid con BB 2H como referencia principal (BB 1H = estructura fina). SL = soporte/resistencia estructural (BB 4H/swing) ± 1-1.5×ATR(1h). Si el SL implica pérdida >8-10% a 1x, reduce capital (Sección 4) y/o leverage (Sección 5): pérdida real proyectada 5-8%. El leverage final (máx 4x por protocolo) debe ser ≤ al MAX LEVERAGE del par mostrado en los datos; si el máximo del par es bajo, dimensiona range/SL/exposición más conservador y señala si no alcanza para la convicción deseada.
10. Alineación y crowding: para LONG el RSI(4h) debe estar ≥ 50 (tendencia 4H a favor) y el FUNDING RATE no debe ser positivamente elevado (>0.05% = longs hacinados). Para SHORT el RSI(4h) debe estar ≤ 50 y el funding no debe ser negativamente elevado (<-0.05% = shorts hacinados). Si el funding es extremo, reduce convicción o pasa a NO TRADE.

RESPONDE EN ESPAÑOL. Máximo 25 líneas. Formato EXACTO:

📊 ANÁLISIS ${sym} — ${directionLabel} (${sourceLabel})

🔹 BOT GRID:
• Entry: $XX.XXX
• Range: $XX.XXX - $XX.XXX
• Grids: XX
• SL: $XX.XXX
• TP: $XX.XXX
• Leverage: Xx
• Capital: XX%

🔹 FUTUROS:
• Entry: $XX.XXX
• SL: $XX.XXX
• TP1: $XX.XXX
• TP2: $XX.XXX
• Leverage: Xx
• Capital: XX%

📌 RECOMENDACIÓN: [BOT GRID / FUTUROS / AMBOS]
• Motivo: [explicación breve]

${directionLabel === "LONG" ? "LONG: SL es límite inferior, TP es límite superior." : "SHORT: SL es límite superior, TP es límite inferior."}`
  }]).then(res => validateAnalysisOutput(res, directionLabel, data._leverage?.max || null));
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
  if (botStatus === "Cerrado" || !chatId) {
    console.log(`⏭️ Análisis automático saltado: status="${botStatus}", chatId="${chatId}"`);
    return;
  }

  console.log("🔄 Iniciando análisis horario de BTCUSDT (fuente: Pionex)...");
  try {
    const symbol = symbolForPair("BTC");
    const marketData = await fetchFromPionex(symbol, ["1h", "2h", "4h"]);
    console.log("✅ Datos OHLCV de Pionex obtenidos");

    const indicators = getLatestIndicators(marketData["1h"], marketData["4h"], marketData["2h"]);
    const indicatorsText = formatIndicatorsText(indicators) + "\n" + formatLeverageText(marketData._leverage) + "\n" + formatFundingText(marketData._funding);

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

function extractDirection30m(content) {
  const m = (content || "").match(/BOT\s*30M\s*(LONG|SHORT|NEUTRAL)/i);
  return m ? m[1].toUpperCase() : null;
}

async function runHalfHourlyAnalysis() {
  if (botStatus === "Cerrado" || !chatId) {
    console.log(`⏭️ Análisis 30m saltado: status="${botStatus}", chatId="${chatId}"`);
    return;
  }

  console.log("🔄 Iniciando análisis 30m de BTCUSDT (fuente: Pionex)...");
  try {
    const symbol = symbolForPair("BTC");
    const marketData = await fetchFromPionex(symbol, ["30m", "1h", "2h", "4h"]);
    console.log("✅ Datos OHLCV de Pionex obtenidos");

    const indicators = getLatestIndicators(marketData["1h"], marketData["4h"], marketData["2h"], marketData["30m"]);
    const indicatorsText = formatIndicatorsText(indicators) + "\n" + formatLeverageText(marketData._leverage) + "\n" + formatFundingText(marketData._funding);

    const ticker = marketData._ticker;
    const isMajor = MAJOR_COINS.includes("BTC");
    const longProblems = evaluateScreener30m(indicators, ticker, "LONG", isMajor);
    const shortProblems = evaluateScreener30m(indicators, ticker, "SHORT", isMajor);
    const neutralProblems = evaluateScreener30m(indicators, ticker, "NEUTRAL", isMajor);

    if (longProblems && shortProblems && neutralProblems) {
      console.log("🚫 Screener 30m bloqueó todas las direcciones");
      await sendSafeTelegram(
        `⏱️ ANÁLISIS 30M BTCUSDT\n\n❌ NO TRADE (Screener 30m)\n` +
        `• LONG → ${longProblems.join("; ")}\n` +
        `• SHORT → ${shortProblems.join("; ")}\n` +
        `• NEUTRAL → ${neutralProblems.join("; ")}`
      );
      console.log("✅ Análisis 30m completado (NO TRADE por screener).");
      return;
    }

    console.log("🧠 Enviando a OpenRouter para análisis 30m...");
    const analysis = await analyzeWithAI30m(indicatorsText, ticker);
    const direction = extractDirection30m(analysis);
    const validated = validateAnalysisOutput(analysis, direction, marketData._leverage?.max ?? null);

    console.log("📤 Enviando resultado a Telegram...");
    await sendSafeTelegram(`⏱️ ANÁLISIS 30M BTCUSDT\n\n${validated}`);
    console.log("✅ Análisis 30m completado y enviado.");
  } catch (error) {
    console.error("❌ Error en análisis 30m:", error.message);
    if (error.response) {
      console.error("Detalle:", JSON.stringify(error.response.data, null, 2).slice(0, 500));
    }
    await sendSafeTelegram(`⚠️ Error en el análisis 30m: ${error.message}`);
  }
}

cron.schedule("0 * * * *", () => {
  console.log("⏰ Cron ejecutándose...");
  runHourlyAnalysis().catch((err) => {
    console.error("❌ Error en cron de análisis:", err.message);
  });
});

cron.schedule("30 * * * *", () => {
  console.log("⏰ Cron 30m ejecutándose...");
  runHalfHourlyAnalysis().catch((err) => {
    console.error("❌ Error en cron de análisis 30m:", err.message);
  });
});

function pairLabel(symbol) {
  return symbol.replace(/:(USDT|BTC)$/, "");
}

async function runMultiPairScan(force = false) {
  if (!force && (botStatus === "Cerrado" || !chatId)) {
    console.log(`⏭️ Escaneo multi-par saltado: status="${botStatus}", chatId="${chatId}"`);
    return;
  }

  console.log("🔄 Iniciando escaneo multi-par (base BTC, temporalidad 30m)...");
  const btcUsd = await getBtcUsdPrice();
  console.log(`💵 Precio BTC/USDT para conversión de volumen: ${btcUsd ? btcUsd.toFixed(0) : "N/A"}`);
  const passed = [];
  const failed = [];
  const errors = [];

  for (const base of MULTI_PAIR_LIST) {
    try {
      const symbol = symbolForPair(base);
      const marketData = await fetchFromPionex(symbol, ["30m", "1h", "2h", "4h"]);
      const indicators = getLatestIndicators(marketData["1h"], marketData["4h"], marketData["2h"], marketData["30m"]);
      const ticker = marketData._ticker;
      const isMajor = MAJOR_COINS.includes(base.replace(/\/BTC$/, ""));

      const candidates = [];
      const failLines = [];
      for (const dir of ["LONG", "SHORT", "NEUTRAL"]) {
        const problems = evaluateScreener30m(indicators, tickerWithUsdVolume(ticker, true, btcUsd), dir, isMajor);
        if (!problems) {
          candidates.push(dir);
        } else if (dir !== "NEUTRAL") {
          failLines.push(`${dir[0]}: ${problems[0]}`);
        }
      }

      if (candidates.length) {
        const adx30 = indicators.adx?.["30m"]?.adx ?? 0;
        const sbr = indicators.sellBuyRate30mNorm ?? 0;
        const score = Math.abs(sbr) * (adx30 / 20);
        passed.push({ base, symbol, indicators, marketData, ticker, direction: candidates[0], score });
        console.log(`✅ ${base}: pasa screener (${candidates.join("/")}) score=${score.toFixed(2)}`);
      } else {
        failed.push(`${base} → ${failLines.join(" | ")}`);
        console.log(`🚫 ${base}: NO TRADE`);
      }
    } catch (e) {
      console.error(`⚠️ Error escaneando ${base}:`, e.message);
      errors.push(`${base} → error: ${e.message}`);
    }

    await sleep(1200);
  }

  try {
    let msg;
    if (!passed.length) {
      msg = `⏱️ ESCANEO MULTI-PAR (30M)\n\n❌ NO TRADE en ninguno de los pares`;
      for (const f of failed) msg += `\n• ${f}`;
      for (const e of errors) msg += `\n⚠️ ${e}`;
    } else {
      passed.sort((a, b) => b.score - a.score);
      const best = passed[0];
      const others = passed.slice(1);

      const indicatorsText = formatIndicatorsText(best.indicators, true) + "\n" + formatLeverageText(best.marketData._leverage) + "\n" + formatFundingText(best.marketData._funding);
      const analysis = await analyzeWithAI30m(indicatorsText, tickerWithUsdVolume(best.ticker, true, btcUsd), pairLabel(best.symbol));
      const validated = validateAnalysisOutput(analysis, extractDirection30m(analysis), best.marketData._leverage?.max ?? null);

      msg = `⏱️ ESCANEO MULTI-PAR (30M)\n\n🏆 MEJOR OPORTUNIDAD: ${pairLabel(best.symbol)} [screener: ${best.direction}, Score: ${best.score.toFixed(2)}]\n\n${validated.trim()}`;

      if (others.length) {
        msg += "\n\n📊 También pasaron el screener:";
        for (const o of others) msg += `\n• ${pairLabel(o.symbol)}: ${o.direction} (Score: ${o.score.toFixed(2)})`;
      }
      if (failed.length || errors.length) {
        msg += "\n";
      }
      if (failed.length) {
        msg += "\n❌ NO TRADE:";
        for (const f of failed) msg += `\n• ${f}`;
      }
      if (errors.length) {
        for (const e of errors) msg += `\n⚠️ ${e}`;
      }
    }

    console.log("📤 Enviando resultado del escaneo a Telegram...");
    await sendSafeTelegram(msg);
    console.log("✅ Escaneo multi-par completado y enviado.");
  } catch (error) {
    console.error("❌ Error en escaneo multi-par:", error.message);
    await sendSafeTelegram(`⚠️ Error en el escaneo multi-par: ${error.message}`);
  }
}

cron.schedule("0,30 * * * *", () => {
  setTimeout(() => {
    console.log("⏰ Cron multi-par ejecutándose...");
    runMultiPairScan().catch((err) => {
      console.error("❌ Error en cron multi-par:", err.message);
    });
  }, 30000);
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
    setChatId(ctx.chat.id);
    await ctx.reply(
      "🤖 *Bot Analista Crypto Activo*\n\n" +
      "*Comandos básicos:*\n" +
      "• `/PAR` — Analiza cualquier par con contexto BTC (ej: `/ETH`, `/BTC`)\n" +
      "• `/PAR TF` — Todos los indicadores en una temporalidad (ej: `/ETH 1h`, `/ADA 4h`)\n" +
      "• `Abierto` — Activa las alertas automáticas (BTC 1H, BTC 30M y escaneo multi-par)\n" +
      "• `Cerrado` — Pausa las alertas automáticas\n" +
      "• `Escaneo` — Escaneo multi-par manual inmediato\n\n" +
      "*Comandos avanzados:*\n" +
      "• `/PAR INDICADOR [TF]` — Indicador específico (ej: `/ETH ADX 1h`)\n" +
      "• `/PAR FUENTE DIRECCION` — Bot+Futuros con fuente (ej: `/ETH Pionex Long`, `/BTC Bitget Short`)\n" +
      "• `/PAR FUENTE NEUTRAL` — Solo Bot Neutral (ej: `/ETH Pionex Neutral`)\n" +
      "• `/PAR BOT LONG|SHORT|NEUTRAL` — Análisis sin fuente (ej: `/ETH BOT LONG`)\n" +
      "• `/PAR FUTUROS LONG|SHORT` — Análisis en futuros (ej: `/ETH FUTUROS LONG`)\n" +
      "• `/PAR BOT O FUTUROS LONG|SHORT` — Compara bot vs futuros\n" +
      "• `/help` — Esta ayuda\n\n" +
      "*Fuentes:* `Bitget`, `Pionex`\n" +
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
  setChatId(ctx.chat.id);
  await ctx.reply(
    "📖 *Guía de comandos*\n\n" +
    "*Análisis completo:*\n" +
    "• `/ETH` , `/BTC` , `/ADA`\n" +
    "  → Análisis completo con contexto BTC y recomendación\n\n" +
    "*Todos los indicadores en una TF:*\n" +
    "• `/ETH 1h` — RSI, ADX, ATR, BB, SBR en 1H\n" +
    "• `/BTC 4h` — Todos los indicadores en 4H\n\n" +
    "*Indicadores específicos:*\n" +
    "• `/ETH ADX 1h` — ADX con DI+/DI- en 1H\n" +
    "• `/ETH RSI 4h` — RSI en 4H\n" +
    "• `/ADA BB` — Bollinger Bands en 1h+2h+4h\n\n" +
    "*Análisis con fuente (Bot + Futuros):*\n" +
    "• `/ETH Pionex Long` — Bot Long + Futuros Long (datos Pionex)\n" +
    "• `/ETH Bitget Short` — Bot Short + Futuros Short (datos Bitget)\n" +
    "• `/BTC Pionex Neutral` — Solo Bot Neutral (datos Pionex)\n" +
    "• `/ADA Bitget Long` — Bot Long + Futuros Long (datos Bitget)\n\n" +
    "*Análisis sin fuente (comportamiento anterior):*\n" +
    "• `/ETH BOT LONG` — ¿Es buena oportunidad para LONG?\n" +
    "• `/ETH BOT SHORT` — ¿Es buena oportunidad para SHORT?\n" +
    "• `/ETH BOT NEUTRAL` — ¿Es bueno para bot neutral?\n" +
    "• `/ETH FUTUROS LONG` — Configuración futuros LONG\n" +
    "• `/ETH FUTUROS SHORT` — Configuración futuros SHORT\n" +
    "• `/ETH BOT O FUTUROS LONG` — Compara bot vs futuros\n\n" +
    "*Alertas automáticas:*\n" +
    "• `Abierto` — Activa (BTC 1H, BTC 30M, multi-par)\n" +
    "• `Cerrado` — Pausa\n" +
    "• `Escaneo` — Escaneo multi-par manual inmediato\n\n" +
    "*Fuentes:* `Bitget`, `Pionex`\n" +
    "*Temporalidades:* 15m, 30m, 1h, 2h, 4h",
    { parse_mode: "Markdown" }
  );
});

bot.on("message:text", async (ctx) => {
  try {
    setChatId(ctx.chat.id);
    const rawText = ctx.message.text.trim();
    const text = rawText.toLowerCase();

    if (rawText.startsWith("/")) {
      const cmd = parseFlexibleCommand(rawText);
      if (!cmd) {
        await ctx.reply("❌ Formato inválido. Usa /help para ver los comandos disponibles.");
        return;
      }

      const isBtcBase = cmd.symbol.endsWith("/BTC");
      const symbolLabel = isBtcBase ? cmd.symbol : `${cmd.symbol}USDT`;

      // Comparación bot vs futuros (sin fuente)
      if (cmd.comparisonMode && !cmd.source) {
        await ctx.reply(`🔄 Comparando BOT vs FUTUROS para ${symbolLabel} en ${cmd.botIntent}...`);
        const analysis = await compareBotVsFutures(cmd.symbol, cmd.botIntent);
        await ctx.reply(analysis);
        return;
      }

      // Con fuente seleccionada: analiza Bot+Futuros (o solo Neutral)
      if (cmd.source && cmd.botIntent) {
        const sourceLabel = cmd.source === "pionex" ? "Pionex" : "Bitget";
        await ctx.reply(`🔍 Analizando ${symbolLabel} con datos de ${sourceLabel} (${cmd.botIntent})...`);
        const analysis = await analyzePairWithSource(cmd.symbol, cmd.source, cmd.botIntent);
        await ctx.reply(analysis);
        return;
      }

      // Bot/Futuros sin fuente (comportamiento actual)
      if (cmd.botIntent) {
        await ctx.reply(`🔍 Analizando oportunidad ${cmd.botIntent} para ${symbolLabel}...`);
        const analysis = await analyzeBotOpportunity(cmd.symbol, cmd.botIntent);
        await ctx.reply(analysis);
        return;
      }

      if (cmd.indicator) {
        await ctx.reply(`🔍 Consultando ${cmd.indicator} ${cmd.timeframe || "1h+4h"} para ${symbolLabel}...`);
        const result = await getSingleIndicator(cmd.symbol, cmd.indicator, cmd.timeframe);
        await ctx.reply(result);
        return;
      }

      if (cmd.allIndicators) {
        await ctx.reply(`🔍 Obteniendo todos los indicadores en ${cmd.timeframe} para ${symbolLabel}...`);
        const result = await getAllIndicatorsForTimeframe(cmd.symbol, cmd.timeframe);
        await ctx.reply(result);
        return;
      }

      await ctx.reply(`🔍 Analizando ${symbolLabel} con contexto de BTC...\n\nEsto puede tomar hasta 30 segundos.`);
      const analysis = await analyzePair(cmd.symbol, ["1h", "2h", "4h"]);
      await ctx.reply(analysis);
      return;
    }

    if (text === "abierto") {
      setBotStatus("Abierto");
      await ctx.reply("🔓 *Modo Abierto* — Alertas activadas.\n\nRecibirás los análisis automáticos: BTC 1H (min 0), BTC 30M (min 30) y escaneo multi-par base BTC (min 0 y 30 +30s). Escribe *Cerrado* para pausarlas.", { parse_mode: "Markdown" });
      console.log("🔓 Bot status cambiado a: Abierto");
      return;
    }

    if (text === "cerrado") {
      setBotStatus("Cerrado");
      await ctx.reply("🔒 *Modo Cerrado* — Alertas pausadas.\n\nNo recibirás más análisis automáticos hasta que escribas *Abierto*.", { parse_mode: "Markdown" });
      console.log("🔒 Bot status cambiado a: Cerrado");
      return;
    }

    if (text === "escaneo") {
      if (!chatId) {
        await ctx.reply("⚠️ Aún no tengo registrado tu chat. Escribí *Abierto* primero.", { parse_mode: "Markdown" });
        return;
      }
      await ctx.reply("⏱️ Ejecutando escaneo multi-par manual (10 pares base BTC)...\n\nToma ~20 segundos.");
      runMultiPairScan(true).catch(async (err) => {
        console.error("❌ Error en escaneo manual:", err.message);
        await ctx.reply(`⚠️ Error en escaneo manual: ${err.message}`);
      });
      return;
    }

    console.log("💬 Chat libre detectado:", rawText.slice(0, 50));
    const reply = await chatWithAI(rawText);
    await ctx.reply(reply);
  } catch (error) {
    console.error("❌ Error en handler message:text:", error.message);
    if (error.message && error.message.includes("does not have market")) {
      await ctx.reply("❌ Ese par no está disponible en Bitget ni Pionex. Verifica el ticker e intenta de nuevo.");
    } else {
      await ctx.reply("⚠️ Ocurrió un error procesando tu mensaje. Intenta de nuevo.");
    }
  }
});

bot.on("message:photo", async (ctx) => {
  setChatId(ctx.chat.id);
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
            text: `Eres un trader profesional. Analiza este gráfico siguiendo este protocolo:\n\n${protocolo}\n\nDetermina: ✅ BOT LONG, ✅ BOT SHORT, ✅ BOT NEUTRAL o ❌ NO TRADE. Si es LONG/SHORT/NEUTRAL da: Entry, SL, TP, Range, Grids, Leverage. Máximo 10 líneas. Español.`
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

async function startBotWithRetry(attempt = 0) {
  const MAX_RETRIES = 12;
  try {
    await bot.start();
    console.log("✅ Polling de Telegram iniciado correctamente");
  } catch (err) {
    const isConflict = err.message && err.message.includes("409");
    if (isConflict && attempt < MAX_RETRIES) {
      console.warn(`⚠️ 409 Conflict (instancia previa aún activa). Reintento ${attempt + 1}/${MAX_RETRIES} en 5s...`);
      setTimeout(() => startBotWithRetry(attempt + 1), 5000);
    } else {
      console.error("❌ Error al iniciar el bot (posible token inválido):", err.message);
      console.error("Verifica que TELEGRAM_BOT_TOKEN esté bien configurado en Render");
    }
  }
}

startBotWithRetry();
