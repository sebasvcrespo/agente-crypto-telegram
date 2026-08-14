# AGENTS.md — Guía para asistentes de código

## Arquitectura del proyecto

Bot de Telegram que analiza criptomonedas usando datos de exchanges y los envía a IA para recomendaciones de trading.

| Archivo | Función |
|---------|---------|
| `index.js` (~1250 líneas) | Bot principal: Telegram handler, parsing de comandos, APIs de exchanges, análisis con IA |
| `indicators.js` | Indicadores técnicos: BB, RSI, ATR, ADX, SellBuyRate |
| `protocolo.txt` | Protocolo de trading completo (13 secciones) para prompts de IA |
| `.env` | Variables de entorno (no versionado) |
| `log.txt` | Log de errores en runtime |

## Variables de entorno requeridas

```
TELEGRAM_BOT_TOKEN=...
OPENROUTER_API_KEY=...
```

## Fuentes de datos (Exchange APIs)

### Bitget (futuros perpetuos)
- Usa **ccxt** con `options: { defaultType: 'swap' }` → perpetuos por defecto
- Símbolo formato ccxt: `EVAA/USDT:USDT`
- API pública, no requiere API key
- ~60+ pares disponibles
- Tiene rate limiting (manejar con retry + delay)

### Pionex (perpetuos)
- API REST pública, no requiere API key
- **CRÍTICO:** El sufijo para perpetuos es `_PERP`, tanto para base USDT como BTC
- Símbolo correcto USDT: `EVAA_USDT_PERP` (NO `EVAA_USDT` que es spot)
- Símbolo correcto BTC: `ETH_BTC_PERP`, `ADA_BTC_PERP`, etc.
- Pares en base BTC soportados: `ADA/BTC`, `ORDI/BTC`, `PAXG/BTC`, `LINK/BTC`, `XRP/BTC`, `SOL/BTC`, `ETH/BTC`, `BNB/BTC`, `DOGE/BTC`, `SUI/BTC` (y cualquier par cruzado contra BTC).
- 601+ pares perpetuos disponibles
- Función de conversión: `symbolToPionex()` en `index.js` (reemplaza `/` → `_`, `:USDT` o `:BTC` → `_PERP`)
- Klines endpoint: `GET /api/v1/market/klines?symbol=XXX_PERP&interval=60M|120M|4H&limit=100` (1h, 2h, 4h)
- Tickers endpoint: `GET /api/v1/market/tickers?symbol=XXX_PERP`

### Formato de conversión de símbolo

```
Input USDT: "EVAA/USDT:USDT" -> Pionex: "EVAA_USDT_PERP"
Input BTC:  "ADA/BTC:BTC"    -> Pionex: "ADA_BTC_PERP"
Bitget:     "EVAA/USDT:USDT"  (formato ccxt estándar)
```

## Sistema de comandos

### Formato: `/PAR [FUENTE] [DIRECCION]`

- **PAR** (requerido): Ticker de la cripto (ej: BTC, ETH, EVAA, ADA)
- **FUENTE** (opcional): `Bitget` o `Pionex` (default: Bitget)
- **DIRECCION** (opcional): `Long`, `Short` o `Neutral`

### Comandos válidos

```
/BTC              → Análisis Bot solo (sin fuente explícita)
/BTC Long         → Bot Long + Futuros Long (fuente por defecto: Bitget)
/BTC Pionex Long  → Bot Long + Futuros Long (datos Pionex)
/ETH Bitget Short → Bot Short + Futuros Short (datos Bitget)
/ADA Pionex Long  → Bot Long + Futuros Long (datos Pionex)
```

### Lógica de parsing (`parseFlexibleCommand`)

1. Detecta fuente (Bitget/Pionex) y la elimina de `parts`
2. Detecta dirección (Long/Short/Neutral)
3. Si hay fuente → activa `botIntent` para análisis dual (Bot + Futuros)
4. Neutral → solo Bot Neutral (sin análisis de futuros)

## Análisis horario automático (BTC)

- Cron job cada hora (`node-cron`)
- Usa Pionex como fuente primaria
- Genera tabla con RSI, ADX, ATR, Bollinger Bands
- Se envía a un canal de Telegram (chat ID configurado)
- **Filtro ATR del Screener (Sección 13 de `protocolo.txt`):** para BTC/Majors el ATR(1h) requerido es **>0.40%** (Long/Short) y **>0.30%** (Neutral); las altcoins mantienen **>1.2%** / **>1.8%**
- **Filtro de Volumen (24h) del Screener (Sección 13):** **>200K USD** en las tres direcciones (Long, Short y Neutral)

## Timeframes de análisis (1h + 2h + 4h)

- Todos los flujos (`analyzePair`, `analyzeBotOpportunity`, `compareBotVsFutures`, `analyzePairWithSource`, `runHourlyAnalysis`, `chatWithAI`) fetchean **1h, 2h y 4h** (`timeframes = ["1h", "2h", "4h"]`).
- `getLatestIndicators(ohlcv1h, ohlcv4h, ohlcv2h)` calcula **BB(20,2) en 1H, 2H y 4H** (`bb_1h`, `bb_2h`, `bb_4h`).
- `formatIndicatorsText` envía a la IA las 3 BB con su **ancho %** relativo al precio, más un bloque `REFERENCIA RANGE/SL`.

### Rango / SL (lógica definida en Sección 6 de `protocolo.txt`)

- **RANGE del bot grid** → **BB(20,2) de 2H** como referencia principal (BB 1H solo como estructura fina). Evita usar BB 4H sola: es ~2× más ancha y genera SL/rango enormes.
- **SL** → soporte/resistencia estructural (BB 4H o swing) **± 1–1.5×ATR(14) de 1H**.
- Si el SL implica pérdida **>8–10% a 1x**, reducir capital (Sección 4) y/o bajar leverage (Sección 5) hasta dejar pérdida real proyectada en **5–8%**.
- Los prompts de análisis incluyen un bullet `EXTRA:` con esta directiva (8 bloques de instrucciones en `index.js`).

## Indicadores técnicos (`indicators.js`)

| Indicador | Función | Default |
|-----------|---------|---------|
| Bollinger Bands | `calculateBB(close, period, stdDev)` | 20, 2σ |
| RSI | `calculateRSI(close, period)` | 14 |
| ATR | `ATR(high, low, close, period)` | 14 |
| ADX | `calculateADX(high, low, close, period)` | 14 |
| SellBuyRate | `calculateSellBuyRate(o, h, l, c, v, period)` | 34 |

- `getLatestIndicators(ohlcv1h, ohlcv4h, ohlcv2h)` devuelve `bb_1h`, `bb_2h`, `bb_4h`, RSI/ADX/ATR de 1h y 4h, y `sellBuyRate`.
- `getIndicatorsForTimeframe(ohlcv, tf)` calcula todos los indicadores para una TF puntual (usado por `/PAR ADX 1h`, `/PAR BB`, etc.).

## Comandos útiles

```bash
# Verificar sintaxis
node -c index.js

# Ejecutar bot locally
npm start

# Ejecutar bot en background (producción)
node index.js > log.txt 2>&1 &
```

## Despliegue

- **Plataforma:** Render (auto-deploy desde `origin/main`)
- **Repo:** `https://github.com/sebasvcrespo/agente-crypto-telegram.git`
- **Branch:** `main`
- Al hacer push a main, Render despliega automáticamente

## Errores comunes

| Error | Causa | Solución |
|-------|-------|----------|
| `MARKET_INVALID_SYMBOL` en Pionex | Símbolo sin `_PERP` | Verificar `symbolToPionex()` use `_PERP` |
| Rate limit en Bitget | Demasiadas requests | Ya manejado con retry + delay en `fetchMarketDataForPair` |
| "Par no disponible" | Par no existe en ninguna fuente | Verificar si el par existe en Bitget o Pionex |
| `409 Conflict` en `getUpdates` al iniciar | Instancia anterior del bot aún con polling activo (tras redeploy) | Ya manejado: `startBotWithRetry()` reintenta cada 5s (hasta 12 veces) |

## Notas importantes

- **NO agregar comentarios** al código a menos que se pida explícitamente
- **Formato de fechas:** Las APIs usan timestamps en milisegundos
- **Pionex PERP:** Siempre usar `_PERP` suffix, nunca `_USDT` para perpetuos
- **Bitget swap:** ccxt ya usa perpetuos por defecto con `defaultType: 'swap'`
- **Fallback:** Cuando Pionex falla, el bot intenta Bitget automáticamente (en modo auto)
- **Persistencia de estado:** `chatId` y `botStatus` se guardan en `state.json` (no versionado, ver `.gitignore`) via `setChatId()`/`setBotStatus()`. Sobreviven a restarts/deploys para que el análisis horario no se salte por `chatId=null`
- **Rango/SL acotado:** el range del bot usa BB 2H (no BB 4H sola) y el SL se ancla a estructura ± 1–1.5×ATR(1h). Ver sección "Timeframes de análisis".
- **Protocolo de trading:** Ver `protocolo.txt` para la lógica completa de análisis
