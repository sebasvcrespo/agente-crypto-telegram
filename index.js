import http from "http";
import { Bot, GrammyError, HttpError } from "grammy";
import dotenv from "dotenv";
import axios from "axios";
import cron from "node-cron";
import ccxt from "ccxt";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLatestIndicators } from "./indicators.js";

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

function formatIndicatorsText(data) {
  const bb = data.bb_4h;
  const bbLine = bb
    ? `BB 4H > Upper: ${bb.upper.toFixed(0)} | Mid: ${bb.middle.toFixed(0)} | Lower: ${bb.lower.toFixed(0)}`
    : "BB 4H: N/A";

  const r1 = data.rsi["1h"]?.toFixed(1) ?? "N/A";
  const r4 = data.rsi["4h"]?.toFixed(1) ?? "N/A";

  const a1 = data.adx["1h"];
  const a4 = data.adx["4h"];
  const adx1 = a1 ? `ADX ${a1.adx} | DI+ ${a1.diPlus} | DI- ${a1.diMinus}` : "N/A";
  const adx4 = a4 ? `ADX ${a4.adx} | DI+ ${a4.diPlus} | DI- ${a4.diMinus}` : "N/A";

  const at1 = data.atr["1h"] ? `${data.atr["1h"].toFixed(1)} (${data.atr["1h_pct"]})` : "N/A";
  const at4 = data.atr["4h"] ? `${data.atr["4h"].toFixed(1)} (${data.atr["4h_pct"]})` : "N/A";

  const sbr = data.sellBuyRate !== null ? data.sellBuyRate.toFixed(2) : "N/A";

  return `
PRECIO ACTUAL: $${data.precio.toFixed(2)} (1H) | $${data.precio4h.toFixed(2)} (4H)
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
}

async function fetchMarketDataForPair(symbol, isFutures = true) {
  const ex = isFutures ? futuresExchange : spotExchange;
  const ohlcv1h = await ex.fetchOHLCV(symbol, "1h", undefined, 100);
  const ohlcv4h = await ex.fetchOHLCV(symbol, "4h", undefined, 100);
  return { ohlcv1h, ohlcv4h };
}

async function fetchMarketData() {
  return fetchMarketDataForPair("BTC/USDT:USDT");
}

function symbolsForPair(base) {
  const futuresSymbol = `${base}/USDT:USDT`;
  const spotSymbol = `${base}/USDT`;
  return { futuresSymbol, spotSymbol };
}

async function fetchBestEffort(base) {
  const { futuresSymbol, spotSymbol } = symbolsForPair(base);
  try {
    const data = await fetchMarketDataForPair(futuresSymbol, true);
    return { data, market: "futuros", symbol: futuresSymbol };
  } catch (e) {
    console.log(`⚠️ ${futuresSymbol} no disponible en futuros, usando spot`);
    const data = await fetchMarketDataForPair(spotSymbol, false);
    return { data, market: "spot", symbol: spotSymbol };
  }
}

async function analyzeWithAI(indicatorsText) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: `Eres un trader profesional de criptomonedas. Analiza los siguientes datos de BTCUSDT siguiendo ESTRICTAMENTE el protocolo de trading.

DATOS DEL MERCADO:
${indicatorsText}

PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Sigue el checklist del punto 12 del protocolo
2. Determina: BOT LONG, BOT SHORT o NO TRADE
3. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
4. Si es LONG o SHORT: calcula SL estructural+ATR, rango, grids, leverage por convicción
5. NO muestres capital ni cálculos intermedios

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
      ]
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
}

async function openRouterChat(messages) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "google/gemini-2.5-flash",
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
}

function normalizeSymbol(text) {
  let s = text.replace(/^\//, "").toUpperCase();
  s = s.replace(/USDT\s*$/, "").trim();
  if (!s) return null;
  return s;
}

async function analyzePair(base) {
  console.log(`🔍 Analizando par: ${base}`);

  const [btcResult, pairResult] = await Promise.all([
    fetchBestEffort("BTC"),
    fetchBestEffort(base)
  ]);

  const btcIndicators = getLatestIndicators(btcResult.data.ohlcv1h, btcResult.data.ohlcv4h);
  const pairIndicators = getLatestIndicators(pairResult.data.ohlcv1h, pairResult.data.ohlcv4h);
  const btcText = formatIndicatorsText(btcIndicators);
  const pairText = formatIndicatorsText(pairIndicators);

  const content = `Eres un trader profesional de criptomonedas.

--- CONTEXTO BTC (solo informativo, sin recomendación) ---
${btcText}

--- ANÁLISIS DEL PAR ${pairResult.symbol} (${pairResult.market}) ---
${pairText}

PROTOCOLO DE TRADING:
${protocolo}

INSTRUCCIONES:
1. Primero da un breve panorama de BTC (2-3 líneas, solo contexto, sin recomendación de trade)
2. Luego analiza ${pairResult.symbol} siguiendo ESTRICTAMENTE el protocolo (punto 12 del checklist)
3. Determina: BOT LONG, BOT SHORT o NO TRADE
4. Si es NO TRADE: di solo "❌ NO TRADE" y el motivo en 1 línea
5. Si es LONG o SHORT: calcula SL estructural+ATR, rango, grids, leverage por convicción
6. NO muestres capital ni cálculos intermedios

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

  const btcData = await fetchMarketData();
  const btcIndicators = getLatestIndicators(btcData.ohlcv1h, btcData.ohlcv4h);
  const btcText = formatIndicatorsText(btcIndicators);

  const content = `Eres un asistente trader experto en criptomonedas. Respondes preguntas sobre crypto, trading, análisis técnico, etc.

DATOS ACTUALES DE BTC/USDT (para contexto de mercado):
${btcText}

El usuario pregunta:
${userMessage}

Responde de forma útil, clara y concisa. Si te pregunta sobre un par específico del que no tienes datos, usa tu conocimiento general. Si puedes dar contexto de precios actuales basado en los datos de BTC, hazlo.`;

  return openRouterChat([{ role: "user", content }]);
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
    const { ohlcv1h, ohlcv4h } = await fetchMarketData();
    console.log("✅ Datos OHLCV obtenidos");

    const indicators = getLatestIndicators(ohlcv1h, ohlcv4h);
    const indicatorsText = formatIndicatorsText(indicators);

    console.log("🧠 Enviando a OpenRouter para análisis...");
    const analysis = await analyzeWithAI(indicatorsText);

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
      "*Comandos:*\n" +
      "• `/TICKER` — Ej: `/ETH` `/COOKIEUSDT` — Analiza cualquier par con contexto BTC\n" +
      "• `Cerrado` — Activa el análisis automático de BTC cada hora\n" +
      "• `Abierto` — Pausa el análisis automático\n" +
      "• Envíame una captura — Analiza el gráfico manualmente\n" +
      "• Cualquier texto — Pregúntame sobre crypto\n\n" +
      `Estado actual: *${botStatus}*`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("❌ Error en comando /start:", error.message);
  }
});

bot.on("message:text", async (ctx) => {
  try {
    chatId = ctx.chat.id;
    const rawText = ctx.message.text.trim();
    const text = rawText.toLowerCase();

    if (text.startsWith("/")) {
      const symbol = normalizeSymbol(rawText);
      if (!symbol) {
        await ctx.reply("❌ Formato inválido. Usa por ejemplo: \`/ETH\`, \`/COOKIEUSDT\`", { parse_mode: "Markdown" });
        return;
      }
      await ctx.reply(`🔍 Analizando ${symbol}USDT con contexto de BTC...\n\nEsto puede tomar hasta 30 segundos.`);
      const analysis = await analyzePair(symbol);
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

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "google/gemini-2.5-flash",
        messages: [
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
        ]
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

    const content = response.data.choices[0]?.message?.content;
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
