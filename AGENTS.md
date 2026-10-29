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
- **Perfil pares base BTC (30m):** `analyzeWithAI30m(..., isBtcBase=true)` aplica perfil extendido: duración máx **3–4h**, SL ±**2×ATR(30m)**, TP **3×ATR(30m)**, **ratio riesgo/beneficio 1:1.5 obligatorio** (si no se logra con estructura real → NO TRADE), range con BB 1H (BB 2H si queda corta). Los pares USDT mantienen el perfil scalp (2–3h, SL 0.5–1×ATR, TP 0.5–1.5×ATR, ratio ≥1).

## Escaneo multi-par base BTC (`runMultiPairScan`)

- Cron `0,30 * * * *` con `setTimeout` de **30s** (arranca a :00:30 y :30:30, después de los flujos A y B).
- Lista fija `MULTI_PAIR_LIST`: XRP/BTC, ADA/BTC, ORDI/BTC, LINK/BTC, SUI/BTC, DOGE/BTC, SOL/BTC, PAXG/BTC, ETH/BTC, BNB/BTC, MSTRX/BTC (con sufijo `/BTC` para que `symbolForPair()` derive `XXX/BTC:BTC` → perpetuo Pionex `XXX_BTC_PERP`; NO pasar solo el ticker o fetchea `/USDT`).
- Iteración secuencial con `sleep(1200)` por par; fetch `["30m","1h","2h","4h"]` + indicadores 30m.
- Gate: `evaluateScreener30m` en las 3 direcciones (majors según `MAJOR_COINS`; ORDI/SUI/PAXG caen como alts). Como máximo una dirección puede pasar por diseño (rangos de RSI/ADX mutuamente excluyentes).
- **Conversión de volumen:** para pares base BTC el `quoteVolume` viene en BTC → `tickerWithUsdVolume(ticker, true, btcUsd)` lo multiplica por el precio BTC/USDT (`getBtcUsdPrice()`, Pionex con fallback ccxt) antes del screener. Sin esto, TODOS los pares base BTC quedan bloqueados por el filtro de 200K. Los call sites de `evaluateScreener` en `analyzeBotOpportunity`, `compareBotVsFutures` y `analyzePairWithSource` aplican la misma conversión.
- Ranking de los que pasan: `Score = |SellBuyRate(30m) normalizado| × (ADX(30m)/20)`; el SBR crudo es volumen-pesado y no comparable entre pares → `indicators.sellBuyRate30mNorm` lo divide por el volumen medio de 34 velas de 30m. Solo el top 1 va a la IA (`analyzeWithAI30m` con `symbolLabel` del par).
- El ticker pasado a `analyzeWithAI30m` va convertido a USD (`tickerWithUsdVolume`) para que la IA vea el volumen 24h en dólares, no en BTC.
- Salida: un único mensaje consolidado `⏱️ ESCANEO MULTI-PAR (30M)` con mejor oportunidad (+config IA), otros que pasaron (dirección+score), NO TRADE con motivo L/S y errores de fetch. Si ninguno pasa → mensaje compacto sin gastar LLM.
- **Comando manual `Escaneo`:** dispara `runMultiPairScan(true)` inmediatamente (ignora estado Cerrado). Con par (`Escaneo ETH/BTC`, `escaneo sol`, `escaneo ORDIBTC`...) dispara `runSinglePairScan()`: normaliza cualquier formato vía `normalizeScanPair()` (acepta `ETH`, `ETH/BTC`, `ETHBTC`, `/USDT`, `:BTC`...), corre el screener 30m en las 3 direcciones; si alguna pasa → IA para ese par; si ninguna pasa → reporte detallado de filtros fallidos por dirección sin gastar LLM. Funciona con pares base USDT también (sin conversión de volumen).

## Motor multi-estrategia interno (`multiStrategyEngine.js` + `strategies.js` + `riskManager.js`)

- **Módulo independiente, 100% determinista (SIN IA).** Réplica de la lógica de señales de `docs/LOGICA_Y_REPLICA.md` (AgenteKucoin): detectores, scores, pesos, probabilidad, confluencias, bonus, SL y filtros. No altera los flujos de 1H, multipar 30m (ambos **sugeridos/desactivados**) ni el multi-estrategia antiguo de `strategiesEngine.js` (sigue existiendo pero **no se ejecuta** desde el cron).
- **ÚNICO flujo automático activo.** Los análisis horario BTC 1H (`runHourlyAnalysis`), escaneo multi-par 30m (`runMultiPairScan`) y flujo 30m BTC (`runHalfHourlyAnalysis`) están **suspendidos** (crons comentados en `index.js`). El comando manual `Escaneo` sigue disponible.
- Cron `0,15,30,45 * * * *` con un `setTimeout` de **20s** (20s tras el cierre de cada vela 15M). Respeta `Abierto/Cerrado` y la **pausa de fin de semana** (Vie 20:00 → Dom 07:00 hora España, `isWeekendPause`). **El flujo automático solo envía Telegram si hay señal válida** (sin spam de "sin oportunidades"; el detalle va a consola). Comando manual: **`Multi`** (fuerza, ignora Cerrado y la pausa de fin de semana, responde siempre aunque no haya señales). Alias legacy: `multiestrategia` y `estrategia` (mismo handler).
- Recorre los 12 pares (`INTERNAL_MULTI_STRATEGY_LIST`): **BTC/USDT** (el primero, par directo USDT) y los demás base BTC: XRP, ADA, ORDI, LINK, SUI, DOGE, SOL, PAXG, ETH, BNB, MSTRX (`/BTC`).
- **Temporalidad única: 15M, 200 velas CERRADAS** (`dropFormingCandles` descarta la vela en formación; `CLOSED_COUNT=200`). Sin contexto 1H y **sin filtro de régimen** (las 6 estrategias se evalúan siempre). `buildFrame15m(ohlcv15m)` arma el frame con RSI(14) Wilder, ATR(14) Wilder (array `calculateATRArray`), EMA20/50/200 y arrays OHLCV.
- **Estrategias (paridad con AgenteKucoin; cada señal: `score`, `prob` 0-1, `entry` = último cierre, `suggestedSlPrice`, `details` con `structure_quality`/`atr`/`rvol`):**
  - `SMC_Reversal`: `SWEEP_PRIOR_WINDOW=20`, `SWEEP_LOOKBACK=30`, `CHOCH_WINDOW=10`, penetración estricta; CHoCH = cierre más allá del **extremo de la vela del sweep** dentro de 10 velas, invalidación si rompe el extremo del sweep antes; exige OB o FVG **no mitigado** (≥`0.2×ATR`, con chequeo de mitigación). SL = `min(sweep, low[-3:]) − 0.25×ATR` (LONG) / `max(sweep, high[-3:]) + 0.25×ATR` (SHORT). Score **25 +10 OB +15 FVG**; prob **0.30 +0.05 OB +0.10 FVG** (tope 0.95). Estructura `ob_fvg_zone`.
  - `Trend_Pullback`: EMAs **15m** 20>50>200 y `close > ema20` (espejo SHORT); zona Fib **0.618-0.786 del último impulso (pivotes 3×3 confirmados)** o solape del rango de la última vela con la zona EMA20/50; vela de rechazo (mecha ≥50% del rango y cierre a favor, estricto). SL = swing de 8 velas ± `1.0×ATR`. Score 25; prob 0.30 (+0.05 si fib **y** EMA). Estructura `swing_zone`.
  - `VP_Mean_Revert`: Volume Profile **proporcional** (cada vela distribuye su volumen uniforme en 24 sub-bines) sobre 120 velas, 24 bines globales; POC = bin de mayor volumen; área de valor = bines que suman 68% (VAH/VAL = percentil 90/10 de sus centros); LVN = bin del precio actual < **45% del promedio** de bines (`LVN_THRESHOLD=0.45`). Precio fuera del VA. SL = `min(close,VAL) − max(1×ATR, 1.1%×close)` / `max(close,VAH) + max(1×ATR, 1.1%×close)` (colchón `SL_MIN_BUFFER_PCT=1.1%`). Score 25; prob 0.30. Estructura `vp_zone`; `targetPrice` = POC (solo referencia).
  - `Breakout`: rango de 20 velas **previas** a la vela trigger (`closed[:-1]`), cierre de la trigger fuera del rango, volumen ≥`1.8×` el promedio de 20. SL = nivel roto ∓`0.25×ATR` si la distancia ≥1 ATR, si no punto medio del rango ∓`0.25×ATR`. Score **35**; prob 0.30 (+0.05 si rvol ≥2.0). Estructura `vp_zone`.
  - `Liquidity_Grab`: EQH/EQL = **pares** de highs/lows dentro de 0.1% en las últimas **40** velas (lookback 120); barrido en la vela trigger (penetra el nivel y cierra por dentro) + mecha de rechazo ≥50%. SL = `min(min(triggerLow, low[-3:]) − 0.25×ATR, entry − max(1×ATR, 1.1%×entry))` / espejo SHORT. Score 25; prob 0.30. Estructura `swing_zone`.
  - `RSI_Divergence`: divergencia regular (LL precio + HL RSI / HH precio + LH RSI) con pivotes 2×2, alineación ≤3 velas y **frescura** (`confirm_idx = pivote+2`, `0 ≤ último−confirm_idx ≤ 2`). SL = swing de 8 velas ± `1.0×ATR`. Score **35**; prob 0.30. Estructura `swing_zone`. Nota de paridad: el código Python de AgenteKucoin toma por bug los pivotes máximos de la serie de mínimos; aquí se usan los **pivotes mínimos reales** de lows, tal como documenta `LOGICA_Y_REPLICA.md` (LL/HH reales).
- **Ensemble (`rankCandidates(results, hourUtc)`):** agrupa señales por lado; **Score = Σ(scoreᵢ × pesoᵢ) + 15×(N−1)** (sin tope 100) con `STRATEGY_WEIGHTS` {Breakout 1.2, RSI_Divergence 1.1, VP_Mean_Revert 1.0, Trend_Pullback 0.8, SMC_Reversal 0.6, Liquidity_Grab 0.7}; `entry` = **promedio simple** de las señales coincidentes; `bestSlPrice` = el **más defensivo** (mínimo en LONG, máximo en SHORT). **Probabilidad independiente del score** = `0.40 + 0.05×factores` (tope 0.95): `structure_quality` del mejor score ∈ {vp_zone, swing_zone, ob_fvg_zone}, RVOL > 1.5 (del `details` de la mejor señal), distancia entry→SL ≥ `1.0×ATR`, confluencia N ≥ 3 y ≥1 estrategia de calidad (`QUALITY_STRATEGIES = ("Breakout", "RSI_Divergence")`). Umbrales: **`MIN_SCORE=35` sobre el score ponderado / `MIN_PROB=0.45`**; en la franja estricta 00-12 UTC → **50 / 0.55** (`effectiveThresholds`). Banda SL obligatoria: **1.0% ≤ distancia ≤ 4.0%** (fuera de banda se descarta). Orden: Score desc → Prob desc → distancia SL desc.
- **Filtros de entrada (`applyEntryFilters`):** (1) **gate de calidad**: exige ≥1 de Breakout/RSI_Divergence en la confluencia; (2) **fuerza relativa** (retorno 4h = 16 velas 15m): pares `/BTC` → LONG requiere retorno ≥ 0 y SHORT ≤ 0 (el retorno del par YA es la fuerza vs BTC); pares USDT → `par − BTC/USDT ≥ 0` para LONG (`≤ 0` SHORT); sin referencia disponible no bloquea; (3) **volatilidad**: ATR(14) 15m > **0.6%** del precio → descarta; (4) **franja bloqueada 00-12 UTC** → sin señales; (5) **anti-momentum**: recorrido adverso en las últimas 4 velas 15m > **0.3%** o > **0.5×ATR15m** → descarta.
- `riskManager.calculateLevels`: SL dinámico según `suggestedSlPrice` de la estrategia ganadora; **banda 1.0%–4.0%**; R = distancia SL; **gestión operativa manual: TP1=1R (cerrar 20%), TP2=2R (30%), TP3=2.5R (50%)**; tras TP1 → SL a **BE+ = entry×(1±0.15%)**; tras TP2 → SL al nivel TP1. **FEE_TOTAL=0.5%** (si TP1 no lo cubre → `null`). Dimensionamiento `idealNotional = riskBtc / (slDistancePct + FEE_TOTAL)`; **riesgo = 10% del capital** (`RISK_PERCENT`); `maxNotional = MAX_LEVERAGE × CAPITAL_BTC` (MAX_LEVERAGE=**10x**, `CAPITAL_BTC` default 0.00010, configurable vía `/aumentocapital`). `applyLeverageCap()` recalcula nocional, riesgo real y `riskCapped` con el límite real del exchange.
- Mensaje Telegram: par/estrategia ganadora, score ponderado (sin tope 100), probabilidad %, entrada/SL/TP1/TP2/TP3 en BTC con % y múltiplos R, instrucción de gestión (BE+ tras TP1, SL a TP1 tras TP2), POC de referencia (solo VP), apalancamiento/nocional y confluencias con score×peso por estrategia.
- **Tests:** `npm test` (node:test, sin dependencias nuevas). `test/strategies.test.js` cubre las 6 estrategias (fixtures 15m sintéticos con SL/score/prob exactos), ensemble (pesos + bonus 15 + factores de prob + umbrales estrictos), los 5 filtros de entrada, banda SL 1-4%, `calculateLevels` (TPs 1/2/2.5R, BE+, guarda de lado), `applyLeverageCap()`, `dropFormingCandles`, `isWeekendPause` y el pipeline completo iterando **todos los pares de `INTERNAL_MULTI_STRATEGY_LIST`**.

### Registro de validación 2026-10-08

> Nota: este registro corresponde al ensemble anterior (2026-10-08, gestión 60/40 + BE neto, umbral SL 1-3%). La configuración activa desde 2026-10-29 es la paridad con AgenteKucoin de docs/LOGICA_Y_REPLICA.md (TP 20/30/50 a 1R/2R/2.5R, BE+ 0.15%, banda SL 1-4%).

- Se ejecutaron backtests exclusivamente de **30 días**, sin usar ventanas mayores como criterio de decisión.
- Metodología: 12 pares, una sola posición global, señal al cierre 1H, entrada en la primera vela 15M posterior, fee total 0.50%, SL primero en vela ambigua y gestión 60/40 + BE neto.
- Se corrigió `VP_Mean_Revert`: requiere desplazamiento 15M hacia el POC y usa el POC como TP1 estructural cuando es válido.
- Se añadió filtro de régimen: tendencia solo permite `Trend_Pullback`/`Breakout` alineados; lateral permite reversión; transicional no opera.
- Se compararon cuatro variantes en `backtest-multistrategy-30d-manual.json`:
  - `ENSEMBLE_60_40_BE`: 42 operaciones, +4.46%, PF 1.169, DD -5.42%.
  - `SMC_ONLY_60_40_BE`: 23 operaciones, +1.75%, PF 1.129, DD -5.62%.
  - `SMC_RSI_60_40_BE`: 33 operaciones, -0.86%, PF 0.961, DD -6.68%.
  - `SMC_LIQUIDITY_60_40_BE`: 23 operaciones, +1.75%, PF 1.129, DD -5.62%.
- La configuración recomendada para la prueba manual es el ensemble actual, no SMC sola: TP1 60%, TP2 40%, BE neto después de TP1, fee 0.50%, una posición global y estado Telegram `Cerrado` mientras exista una posición.
- SMC_Reversal fue la mayor contribuyente positiva en la muestra, pero Breakout y Trend_Pullback quedaron negativos; no se desactivan definitivamente por depender de una sola ventana de 30 días.
- La muestra de 30 días es favorable pero insuficiente para afirmar rentabilidad estable. Registrar cada operación manual y volver a comparar en otra ventana separada de exactamente 30 días.

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
| RSI | `calculateRSI(close, period)` / `calculateRSIArray(close, period)` (serie) | 14 |
| ATR | `ATR(high, low, close, period)` | 14 |
| ADX | `calculateADX(high, low, close, period)` | 14 |
| SellBuyRate | `calculateSellBuyRate(o, h, l, c, v, period)` | 34 |

- `getLatestIndicators(ohlcv1h, ohlcv4h, ohlcv2h)` devuelve `bb_1h`, `bb_2h`, `bb_4h`, RSI/ADX/ATR de 1h y 4h, y `sellBuyRate`.
- `getIndicatorsForTimeframe(ohlcv, tf)` calcula todos los indicadores para una TF puntual (usado por `/PAR ADX 1h`, `/PAR BB`, etc.).
- `calculateVolumeProfile(ohlcv, numBuckets)` devuelve `poc`, `vah`, `val`, `minPrice`, `maxPrice`, `bucketSize`, `buckets`, `maxBucketVol`, `totalVol` (el histograma se usa para detectar LVN en `VP_Mean_Revert`).

## Comandos útiles

```bash
# Verificar sintaxis
node -c index.js

# Ejecutar bot locally
npm start

# Ejecutar tests (node:test)
npm test

# Ejecutar bot en background (producción)
node index.js > log.txt 2>&1 &
```

## Despliegue

- **Plataforma:** Render (`agente-crypto-telegram-ova6.onrender.com`, service `srv-d9dp6s6rnols73cu3on0`)
- **Repo:** `https://github.com/sebasvcrespo/agente-crypto-telegram.git`
- **Branch:** `main`
- **Auto-Deploy DESACTIVADO** (`autoDeployTrigger: off`): el `git push` **no** dispara deploy. El deploy se dispara **únicamente** con el webhook del proyecto (1 webhook = 1 deploy). Verificar antes de disparar que no exista ya un deploy para el commit de `HEAD`.

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
- **Persistencia de estado:** `chatId`, `botStatus` y `capitalBtc` se guardan en `state.json` (no versionado, ver `.gitignore`) via `setChatId()`/`setBotStatus()`/`setCapitalBtc()`. Sobreviven a restarts/deploys para que el análisis no se salte por `chatId=null`. `setCAPITAL_BTC()` (de `riskManager.js`) se sincroniza al arrancar y al cambiar el capital con `/aumentocapital`.
- **Comando `/aumentocapital`:** actualiza el `capitalBtc` (BTC disponible para dimensionar posiciones, default 0.00010) en `state.json`. El motor multi-estrategia interna lo usa para `maxNotional = MAX_LEVERAGE × CAPITAL_BTC`. Está documentado en `/start` y `/help`.
- **Semántica de estado (invertida):** `Abierto` = alertas automáticas ACTIVAS (default al arrancar sin state.json); `Cerrado` = alertas PAUSADAS (el flujo automático activo — multi-estrategia interna — omite el ciclo). Los guards chequean `botStatus === "Cerrado"`. Nota: un `state.json` viejo con `"Cerrado"` (semántica anterior) dejará al bot pausado tras el deploy → escribir `Abierto` en Telegram una vez.
- **Rango/SL acotado:** el range del bot usa BB 2H (no BB 4H sola) y el SL se ancla a estructura ± 1–1.5×ATR(1h). Ver sección "Timeframes de análisis".
- **Protocolo de trading:** Ver `protocolo.txt` para la lógica completa de análisis
