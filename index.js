import http from "http";
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot running\n');
}).listen(process.env.PORT || 3000);

import { Bot } from "grammy";
import dotenv from "dotenv";
import axios from "axios";
import cron from "node-cron";
import ccxt from "ccxt";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLatestIndicators } from "./indicators.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const exchange = new ccxt.bybit();

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

async function fetchMarketData() {
  const ohlcv1h = await exchange.fetchOHLCV("BTC/USDT", "1h", undefined, 100);
  const ohlcv4h = await exchange.fetchOHLCV("BTC/USDT", "4h", undefined, 100);
  return { ohlcv1h, ohlcv4h };
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

async function sendSafeTelegram(text) {
  if (!chatId) return;
  const LIMIT = 4000;
  if (text.length <= LIMIT) {
    await bot.api.sendMessage(chatId, text);
  } else {
    await bot.api.sendMessage(chatId, text.substring(0, LIMIT) + "\n\n*(Análisis recortado por límite de caracteres)*");
  }
}

async function runHourlyAnalysis() {
  if (botStatus === "Abierto" || !chatId) {
    console.log(`⏭️ Skip: status=${botStatus}, chatId=${chatId}`);
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
  runHourlyAnalysis();
});

bot.command("start", async (ctx) => {
  chatId = ctx.chat.id;
  await ctx.reply(
    "🤖 *Bot Analista Crypto Activo*\n\n" +
    "Comandos disponibles:\n" +
    "• `Cerrado` — Activa el análisis automático cada hora\n" +
    "• `Abierto` — Pausa el análisis (cuando tengas un bot ejecutando)\n" +
    "• Envíame una captura para análisis manual\n\n" +
    `Estado actual: *${botStatus}*`,
    { parse_mode: "Markdown" }
  );
});

bot.on("message:text", async (ctx) => {
  chatId = ctx.chat.id;
  const text = ctx.message.text.trim().toLowerCase();

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
    runHourlyAnalysis();
    return;
  }

  await ctx.reply("Comando no reconocido. Usa *Abierto* o *Cerrado* para controlar el análisis automático, o envía una captura de pantalla.", { parse_mode: "Markdown" });
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
bot.start();
