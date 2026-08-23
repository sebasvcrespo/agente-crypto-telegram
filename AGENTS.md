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
- Klines endpoint: `GET /api/v1/market/klines?symbol=XXX_PERP&interval=60M|30M|4H&limit=100` (1h, 30m, 4h)
- **`120M` ya NO se solicita a la API** (`MARKET_PARAMETER_ERROR`): la vela 2h SIEMPRE se sintetiza agregando 2 velas de 1h con `aggregateKlines()`, tanto en `fetchFromPionex` como en las ramas Bitget/auto de `fetchMarketDataForPair` (el fetch filtra "2h" del array y la genera al final)
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
- **Alineación 4H:** RSI(4h) **≥50** para LONG y **≤50** para SHORT (Sección 13)
- **Funding Rate:** **≤0.05%** para LONG y **≥-0.05%** para SHORT (evita crowding/hacinamiento). Pionex `GET /api/v1/market/fundingRates?symbol=XXX_PERP`, Bitget `GET /api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES&symbol=XXXUSDT` → `%`

## Análisis 30m automático (BTC) — scalping de corta duración

- Cron job al minuto 30 de cada hora (`30 * * * *`): corre con la vela de 30M recién cerrada (`runHalfHourlyAnalysis`).
- Fetch Pionex con `["30m", "1h", "2h", "4h"]`; los mensajes a Telegram se prefijan con `⏱️ ANÁLISIS 30M BTCUSDT`.
- Objetivo: bots grid de corta duración (máx 2–3 horas) con profit chico. Prompt dedicado `analyzeWithAI30m`: TP 0.5–1.5×ATR(30m), SL estructural ± 0.5–1×ATR(30m), range con BB 30M/1H, leverage máx **3x**.
- Gate duro previo con `evaluateScreener30m` (si las 3 direcciones fallan → envía `❌ NO TRADE (Screener 30m)` sin gastar LLM):
  - Vol 24h **>200K USD** (las tres direcciones)
  - ATR(30m): majors **>0.25%** (Long/Short) y **>0.20%** (Neutral); altcoins **>0.8%** / **>1.2%**
  - LONG: RSI(30m) **52–72**, RSI(1h) **≥45**, ADX(30m) **18–50** con **DI+ > DI−**
  - SHORT: RSI(30m) **28–48**, RSI(1h) **≤55**, ADX(30m) **18–50** con **DI− > DI+**
  - NEUTRAL: ADX(30m) **<15**, RSI(30m) **45–55**
  - No filtra por cambio 24h ni alineación estricta de RSI 4H (permite contra-tendencia; la IA debe bajar convicción en ese caso)
- Crowding por funding se evalúa en el prompt (no en el gate), igual que en el flujo horario.

## Escaneo multi-par base BTC (`runMultiPairScan`)

- Cron `0,30 * * * *` con `setTimeout` de **30s** (arranca a :00:30 y :30:30, después de los flujos A y B).
- Lista fija `MULTI_PAIR_LIST`: XRP/BTC, ADA/BTC, ORDI/BTC, LINK/BTC, SUI/BTC, DOGE/BTC, SOL/BTC, PAXG/BTC, ETH/BTC, BNB/BTC (con sufijo `/BTC` para que `symbolForPair()` derive `XXX/BTC:BTC` → perpetuo Pionex `XXX_BTC_PERP`; NO pasar solo el ticker o fetchea `/USDT`).
- Iteración secuencial con `sleep(1200)` por par; fetch `["30m","1h","2h","4h"]` + indicadores 30m.
- Gate: `evaluateScreener30m` en las 3 direcciones (majors según `MAJOR_COINS`; ORDI/SUI/PAXG caen como alts). Como máximo una dirección puede pasar por diseño (rangos de RSI/ADX mutuamente excluyentes).
- **Conversión de volumen:** para pares base BTC el `quoteVolume` viene en BTC → `tickerWithUsdVolume(ticker, true, btcUsd)` lo multiplica por el precio BTC/USDT (`getBtcUsdPrice()`, Pionex con fallback ccxt) antes del screener. Sin esto, TODOS los pares base BTC quedan bloqueados por el filtro de 200K. Los call sites de `evaluateScreener` en `analyzeBotOpportunity`, `compareBotVsFutures` y `analyzePairWithSource` aplican la misma conversión.
- Ranking de los que pasan: `Score = |SellBuyRate(30m) normalizado| × (ADX(30m)/20)`; el SBR crudo es volumen-pesado y no comparable entre pares → `indicators.sellBuyRate30mNorm` lo divide por el volumen medio de 34 velas de 30m. Solo el top 1 va a la IA (`analyzeWithAI30m` con `symbolLabel` del par).
- El ticker pasado a `analyzeWithAI30m` va convertido a USD (`tickerWithUsdVolume`) para que la IA vea el volumen 24h en dólares, no en BTC.
- Salida: un único mensaje consolidado `⏱️ ESCANEO MULTI-PAR (30M)` con mejor oportunidad (+config IA), otros que pasaron (dirección+score), NO TRADE con motivo L/S y errores de fetch. Si ninguno pasa → mensaje compacto sin gastar LLM.

## Gate duro del Screener (`evaluateScreener`)

- `evaluateScreener(pairIndicators, ticker, direction, isMajor)` computa **determinísticamente** los filtros de la Sección 13 (vol 24h >200K, ATR 1h, ADX 1h 25–35, RSI 1h, RSI 4h alineado, ADX 4h 15–25, change 24h, y NEUTRAL: ADX <18, RSI 45–55, change −3/3%).
- Se aplica en `analyzeBotOpportunity`, `compareBotVsFutures` y `analyzePairWithSource` **antes de llamar a la IA**: si falla → responde `❌ NO TRADE` con el motivo, sin gastar el LLM.
- `MAJOR_COINS` (BTC, ETH, BNB, SOL, ...) usa umbral ATR 0.40%/0.30%; el resto altcoins 1.2%/1.8%.
- `validateAnalysisOutput(content, direction, maxLeverage)` parsea la respuesta de la IA y agrega warning `⚠️ VALIDACIÓN` si SL está del lado incorrecto o leverage > 4x / > max del par.
- En el flujo 30m, `extractDirection30m(analysis)` extrae la dirección del prefijo `BOT 30M LONG|SHORT|NEUTRAL` antes de validar.

## Timeframes de análisis (1h + 2h + 4h)

- Todos los flujos (`analyzePair`, `analyzeBotOpportunity`, `compareBotVsFutures`, `analyzePairWithSource`, `runHourlyAnalysis`, `chatWithAI`) fetchean **1h, 2h y 4h** (`timeframes = ["1h", "2h", "4h"]`).
- `getLatestIndicators(ohlcv1h, ohlcv4h, ohlcv2h)` calcula **BB(20,2) en 1H, 2H y 4H** (`bb_1h`, `bb_2h`, `bb_4h`).
- `formatIndicatorsText` envía a la IA las 3 BB con su **ancho %** relativo al precio, más un bloque `REFERENCIA RANGE/SL`.

### Rango / SL (lógica definida en Sección 6 de `protocolo.txt`)

- **RANGE del bot grid** → **BB(20,2) de 2H** como referencia principal (BB 1H solo como estructura fina). Evita usar BB 4H sola: es ~2× más ancha y genera SL/rango enormes.
- **SL** → soporte/resistencia estructural (BB 4H o swing) **± 1–1.5×ATR(14) de 1H**.
- Si el SL implica pérdida **>8–10% a 1x**, reducir capital (Sección 4) y/o bajar leverage (Sección 5) hasta dejar pérdida real proyectada en **5–8%**.
- Los prompts de análisis incluyen un bullet `EXTRA:` con esta directiva (8 bloques de instrucciones en `index.js`).

## Máximo leverage por par (Pionex / Bitget)

- El bot obtiene el **max leverage disponible** de cada par y se lo manda a la IA como bloque `--- MAX LEVERAGE (Pionex/Bitget) ---` en todos los flujos.
- **Pionex:** `GET /api/v1/common/riskTable?symbol=XXX_PERP` (público, sin API key) → devuelve escalones por nocional con `maxLeverage`. Ej `DOS_USDT_PERP`: **25x** (≤10K USDT) → 20x → 10x → 5x → 2x. `fetchPionexRiskTable()` extrae `{ max, tiers, source: "pionex" }`.
- **Bitget:** ccxt → `exchange.markets[symbol].limits.leverage.max` tras `exchange.loadMarkets()`. Ej `DOS/USDT:USDT` = **10x**. `{ max, source: "bitget" }`.
- `formatLeverageText(leverage)` formatea el máximo + 4 escalones por nocional (`25x hasta 10,000 USDT | ...`). Si falla → `N/A`.
- **Regla en prompts y Sección 5 de `protocolo.txt`:** el leverage final (máx 4x por protocolo) **debe ser ≤ al max leverage del par**; si el máximo del par es bajo, dimensionar range/SL/exposición más conservador y señalar si no alcanza para la convicción deseada.

## Funding Rate (crowding)

- El bot obtiene el **funding rate actual** de cada par y lo manda a la IA como bloque `--- FUNDING RATE ---` en todos los flujos (`formatFundingText(funding)`).
- **Pionex:** `GET /api/v1/market/fundingRates?symbol=XXX_PERP` (público) → `fundingRate` fracción × 100 = %. `fetchPionexFunding()`.
- **Bitget:** `GET /api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES&symbol=XXXUSDT` (público) → `fundingRate` fracción × 100 = %. `fetchBitgetFunding()`. (ccxt `fetchTicker` NO expone `fundingRate` para Bitget).
- Se almacena como `data._funding` (porcentaje) en `fetchFromPionex` y ambas rutas de Bitget de `fetchMarketDataForPair`.
- **Regla en prompts y Sección 13:** LONG requiere funding **≤0.05%** y SHORT **≥-0.05%**; funding extremo → reduce convicción o NO TRADE.

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
- **Semántica de estado (invertida):** `Abierto` = alertas automáticas ACTIVAS (default al arrancar sin state.json); `Cerrado` = alertas PAUSADAS (los 3 flujos automáticos omiten el ciclo). Los guards chequean `botStatus === "Cerrado"`. Nota: un `state.json` viejo con `"Cerrado"` (semántica anterior) dejará al bot pausado tras el deploy → escribir `Abierto` en Telegram una vez.
- **Rango/SL acotado:** el range del bot usa BB 2H (no BB 4H sola) y el SL se ancla a estructura ± 1–1.5×ATR(1h). Ver sección "Timeframes de análisis".
- **Protocolo de trading:** Ver `protocolo.txt` para la lógica completa de análisis
