# AgenteKucoin — Lógica de trading y guía de replicación

> Bot de futuros crypto para KuCoin Futures. Ensemble de **6 estrategias** que abre posiciones LONG/SHORT automáticamente, con gestión dinámica de riesgo (TP escalonado 40/40/20, trailing SL y breakeven) y notificaciones evento-por-evento vía Telegram. Incluye modo **DRY-RUN** (simulación sin arriesgar capital).

## 1. Visión general y arquitectura

```
main.py (orquestador)
├── scanner_multiestrategia.py   → Escanea pares, fusiona señales de las 6 estrategias y rankea candidatos
├── engine/
│   ├── signals.py               → Estructura Signal (strategy, side, score, probability, price, sl, tp1/tp2/tp3)
│   ├── indicators.py            → fetch_ohlcv (solo velas CERRADAS), indicadores, volumen relativo, divergencia RSI
│   ├── scoring_engine.py        → Score PONDERADO por estrategia + gate de calidad + índice de probabilidad + filtros de entrada
│   ├── risk_manager.py          → PositionTracker, dimensionado por riesgo (10% del margen), cooldown, días rojos, slots dinámicos, reconstrucción tras reinicio
│   ├── position_lifecycle.py    → Apertura a mercado + coloca SOLO el SL (100%) + TPs gestionados internamente + ensure_sl_protection
│   ├── trailing_manager.py      → Trailing SL + cierres parciales TP1/TP2/TP3 + detección de SL
│   └── persistence.py           → Estado en Redis (Upstash) con backoff + fallback a archivo local
├── strategies/
│   ├── base_strategy.py         → Interfaz común (load_frames / _load_frame_15m con caché / analyze)
│   ├── smc_reversal.py          → SMC Reversal (barrido de liquidez + CHoCH en OB/FVG)
│   ├── trend_pullback.py        → Tendencia + Pullback (EMA + Fibonacci 0.618-0.786)
│   ├── vp_mean_revert.py        → Volume Profile Mean Revert
│   ├── breakout.py              → Breakout de rangos
│   ├── liquidity_grab.py        → Liquidity Grab (EQL/EQH + mecha)
│   ├── rsi_divergence.py        → Divergencia RSI
│   └── registry.py              → Registro de las 6 estrategias activas
├── executor.py                  → Conexión KuCoin Futures + DryRunExchange (simulación)
├── notifier.py                  → Alertas Telegram
├── telegram_listener.py         → Comandos Telegram (/estado, /pausar, /reanudar, /reset, /capital, /margin, /help)
├── bot_state.py                 → Estado en memoria (paused, trading_resume_timestamp)
├── trade_logger.py              → Historial trades JSON + CSV, cooldown post-SL
├── time_utils.py                → Hora de España (CET/CEST) + pausa de escaneo fin de semana
└── config.py                    → Toda la configuración + pool de pares (MULTI_PAIRS)
```

**Estrategias DESHABILITADAS** (solo referencia en `Estrategias Anteriores/`): CM EMA Trend Bars, CRT, 1H, 30M. No se importan en el runtime.

## 2. Universo y temporalidad

- **Pool:** 26 pares, formato KuCoin Futures `PAR/USDT:USDT` (MULTI_PAIRS en config.py). Ej: `SOL/USDT:USDT`, `BTC/USDT:USDT`.
- **Timeframe:** todo el análisis sobre **15m**. No hay filtro de régimen 1H (las 6 estrategias se evalúan siempre).
- **Velas cerradas (obligatorio):** `fetch_ohlcv(closed_only=True)` descarta la vela en formación. Las 6 estrategias operan solo sobre velas CERRADAS.
- **Escaneo:** cron cada 5 min en segundos `:20` UTC (`SCAN_MINUTES=0,5,...,55`, `SCAN_SECOND=20`).
- **Pausa fin de semana:** no se abren nuevas posiciones Viernes 20:00 → Domingo 07:00 (hora de España). El monitoreo de posiciones abiertas NO se detiene.

## 3. Las 6 estrategias (entrada, SL, score, probabilidad)

Cada estrategia devuelve señales `Signal` con `score` (0-100), `probability` (0-1), `entry_price`, `stop_loss` y `details`. Por defecto cada estrategia usa `score=25` / `prob=0.30` como base, con bonificaciones si se cumplen condiciones específicas.

| Estrategia | Lógica de entrada | Score base | SL | Nota |
|---|---|---|---|---|
| **Breakout** | Ruptura de rango de consolidación (últimas 20 velas) con volumen ≥ 1.8× promedio. LONG si cierre > resistencia; SHORT si cierre < soporte. | 35 | Nivel roto si distancia ≥ 1 ATR, si no punto medio del rango ± 0.25×ATR | Peso 1.2 (el más alto). Estructura `vp_zone`. |
| **SMC_Reversal** | Barrido de liquidez (mínimo/máximo de las velas previas) + CHoCh (cierre más allá del extremo de la vela del sweep) + OB o FVG no mitigado (tamaño ≥ 0.2×ATR). | 25 (+10 OB, +15 FVG) | `min(sweep, low[-3:]) − 0.25×ATR` (long) / `max(sweep, high[-3:]) + 0.25×ATR` (short) | Dispara en ~90% de señales; peso 0.6 para no dominar. |
| **RSI_Divergence** | Divergencia regular RSI(14): LL precio + HL RSI (long) / HH precio + LH RSI (short), con pivotes 2×2 y confirmación en últimas velas. | 35 | Swing low/high de últimas 8 velas ± 1.0×ATR | Peso 1.1. Estructura `swing_zone`. |
| **VP_Mean_Revert** | Precio fuera del Value Area (por debajo de VAL → long; por encima de VAH → short) con bajo volumen en el bin actual (LVN < 45% del promedio). Objetivo: POC. | 25 | `min(close,val) − max(1×ATR, entry×1.1%)` (long) / espejo (short) | Peso 1.0 (SL corregido: antes quedaba invertido el 98.7% de veces). Estructura `vp_zone`. |
| **Trend_Pullback** | Tendencia EMA20>EMA50>EMA200 (long) / EMA20<EMA50<EMA200 (short) + precio en zona Fibonacci 0.618-0.786 o cerca de EMA20/50 + vela de rechazo (mecha ≥ 50% del rango). | 25 | Swing de últimas 8 velas ± 1.0×ATR | Peso 0.8. Estructura `swing_zone`. |
| **Liquidity_Grab** | Barrido de EQL (long) / EQH (short) en últimas 120 velas con mecha de rechazo ≥ 50% del rango (WICK_MIN_RATIO=0.50). | 25 | Mínimo/máximo de mecha o últimas 3 velas ± 0.25×ATR, con colchón mínimo `max(1×ATR, entry×1.1%)` | Peso 0.7. |

**Pesos por estrategia** (`STRATEGY_WEIGHTS`): Breakout 1.2, RSI_Divergence 1.1, VP_Mean_Revert 1.0, Trend_Pullback 0.8, SMC_Reversal 0.6, Liquidity_Grab 0.7. Se aplican en el score ponderado del ensemble.

## 4. Colocación de SL (Stop Loss)

Cada estrategia propone su propio `stop_loss`. Luego el ensemble los combina:

- **SL del candidato (EnsembleCandidate):** el más defensivo → para LONG toma el `stop_loss` **mínimo** (más abajo), para SHORT el **máximo** (más arriba).
- **Banda obligatoria (todas las estrategias):** `MIN_SL_DISTANCE_PCT=1.0%` ≤ distancia entry→SL ≤ `MAX_SL_DISTANCE_PCT=4.0%`. Fuera de banda se descarta el candidato (`select_best`) y `calculate_order` rechaza el sizing como red de seguridad.
- **SL mínimo garantizado:** las estrategias aplican `SL_MIN_BUFFER_PCT=1.1%` (colchón sobre la banda del 1%) para no rozar la banda por ruido de coma flotante.
- **En apertura (`position_lifecycle.open_position`):** se coloca SOLO el SL (100% del tamaño) como orden stop-market en el exchange (`reduceOnly`, dirección opuesta). Los TPs NO se colocan en el exchange; se gestionan internamente vía `trailing_manager`.
- **TP1 hit:** SL se mueve a Break Even+ (`entry × (1 ± ESTIMATED_FEE_PERCENT)`, fee 0.15%).
- **TP2 hit:** SL se mueve al nivel TP1.
- **Al arrancar (`ensure_sl_protection`):** se verifica que cada posición gestionada tenga stop abierto en el exchange; si falta y se conoce el nivel, se repone; si no se conoce el nivel, no se inventa (se deja constancia).

## 5. Scoring y probabilidad (ensemble)

### 5.1 Score final del candidato (`EnsembleCandidate.score()`)
```
score_final = Σ (score_estrategia × peso_estrategia) + ENSEMBLE_BONUS × (n_estrategias − 1)
```
- `ENSEMBLE_BONUS = 15` pts por cada estrategia adicional desde la 2da (premia confluencia).
- `MIN_SCORE = 35` sobre el score PONDERADO (no la suma bruta).

### 5.2 Índice de probabilidad (`_calculate_probability()`)
Independiente del score (antes era `score/100 + factores` y `MIN_PROB` no filtraba nada). Base `PROB_BASE = 0.40`, cada factor suma +0.05, tope 0.95:

| Factor | Condición | +Prob |
|---|---|---|
| Estructura/zona | `structure_quality` ∈ {vp_zone, swing_zone, ob_fvg_zone} | +0.05 |
| Volumen | RVOL > 1.5 | +0.05 |
| Distancia al SL | distancia entry→SL ≥ 1×ATR | +0.05 |
| Confluencia | ≥ 3 estrategias activas | +0.05 |
| Calidad | ≥ 1 estrategia de calidad (QUALITY_STRATEGIES) | +0.05 |

- `MIN_PROB = 0.45` (filtra de verdad ahora).

### 5.3 Gate de calidad (`REQUIRE_QUALITY_STRATEGY`)
Exige al menos una estrategia con edge positivo demostrado (`QUALITY_STRATEGIES = ("Breakout", "RSI_Divergence)`). Evidencia: con ellas winrate 73-76% y PnL positivo; sin ellas 33-40% y negativo.

## 6. Filtros de entrada (confluencia y calidad)

Aplicados en `_apply_entry_filters` tras el score/prob:

1. **Gate de calidad:** descarta candidatos sin Breakout ni RSI_Divergence.
2. **Fuerza relativa vs BTC (`RELATIVE_STRENGTH_FILTER_ENABLED`):** compara retorno 4h (16 velas 15m) del par vs BTC en la misma ventana. Descarta si el par va EN CONTRA del mercado. Sin referencia disponible no bloquea.
3. **Volatilidad (`VOLATILITY_FILTER_ENABLED`):** techo `ATR(14) del 15m ≤ 0.6% del precio`. Tramo alto rinde peor.
4. **Franja bloqueada (`SESSION_BLOCK_HOURS_UTC = ((0,12),)`):** 00-12 UTC cerrado por completo (pierde en ambas mitades del período).
5. **Anti-momentum (`MOMENTUM_FILTER_ENABLED`):** descarta entradas que van en contra del movimiento de las últimas 4 velas 15m (1h) por encima de 0.3% o 0.5×ATR15m.

### Umbrales por franja horaria (`SESSION_STRICT_HOURS_UTC`)
Dentro de 00-12 UTC se exigen umbrales más altos: `SESSION_STRICT_MIN_SCORE = 50`, `SESSION_STRICT_MIN_PROB = 0.55`.

## 7. Gestión de posición (TPs, trailing, BE+, catch-up)

### Asignación de TPs (`TP_ALLOCATION = [0.20, 0.30, 0.50]`)
- TP1 = 20% a 1.0R, TP2 = 30% a 2.0R, TP3 = 50% (runner) a 2.5R. `TP_CAP_R = 2.5`.
- TP1_R = 1.0, TP2_R = 2.0, TP3_R = 2.5 (múltiplos de la distancia entry→SL).

### Ciclo de trailing (`trailing_manager.monitor_trailing`, cada 1 min)
1. Verifica si se ejecutó el SL (inicial o protector).
2. TP1 no tocado y precio toca TP1 → cierra 20%, SL a **Break Even+**.
3. TP1 hit y TP2 no tocado y precio toca TP2 → cierra 30%, SL al nivel **TP1**.
4. TP2 hit y TP3 no tocado y precio toca TP3 → cierra el restante 50% (final).
- PnL estimado como fallback cuando el exchange no devuelve fills (`_estimate_partial_pnl`, fee taker 0.06% entrada + salida).
- Cada hito envía notificación Telegram (`tp1`/`tp2`/`tp3`/`sl`/`close`) y guarda log local en `telegram_messages.jsonl`.

### Breakeven+
`breakeven_plus = entry × (1 + 0.0015)` (long) / `(1 − 0.0015)` (short). Cierres protectores (BE+ o nivel TP1) se registran como `reason="breakeven"` (no como `stop_loss`), para no romper la racha de SL consecutivos.

### Recuperación tras reinicio (`reconstruct_from_exchange` + `catchup_missing_closes`)
3 niveles:
1. Re-hidratar desde `multistrategy_state.json` (gestión activa).
2. Desde órdenes stop en el exchange (caso legacy, SL + TPs abiertos).
3. Solo SL en el exchange (caso normal: TPs internos) → reconstruye niveles TP desde config e **infere hits** comparando precio actual con TP1/TP2/TP3. Si el precio ya superó un TP, marca el hito y mueve el SL al nivel correspondiente.
- `catchup_missing_closes` cierra a mercado las porciones pendientes ya superadas durante el downtime (idempotente: no re-cierra tramos ya cerrados). El SL real del exchange es fuente de verdad; nunca se degrada a un nivel inferior.
- Posiciones sin SL ni estado guardado se registran como **heredadas** (`is_reconciled=True`): solo ocupan slot, no se gestionan, se liberan al cerrar.

## 8. Riesgo, cooldowns y límites de cartera

### Dimensionado (`RiskManager.calculate_order`)
- Riesgo = 10% del margen por posición (`BASE_RISK_PERCENT = 0.10`), siempre 100% (sin escalado por racha: `STREAK_RISK_MULTIPLIERS = {0:1.0,1:1.0,2:1.0}`).
- Tope duro: nunca supera 10% del capital libre (`free_balance × 0.10`).
- Margen por posición configurable vía `/margin` (default `DEFAULT_POSITION_MARGIN_USD = 60`), persistido en Redis.
- Nocional = riesgo ÷ distancia SL. Leverage = nocional ÷ margen por posición, acotado al máximo que el exchange permite por par (ETC 50x, SOL 75x, BTC 125x...; fallback `DEFAULT_MAX_LEVERAGE = 20`).
- `MIN_KUCOIN_NOTIONAL_USD = 5.0`.

### Límites de cartera (slots)
- `MAX_CONCURRENT_TRADES_BASE = 3` (slots base).
- `MAX_CONCURRENT_TRADES_ABSOLUTE = 4` (tope duro).
- Cada posición abierta > `POSITION_AGE_HOURS_FOR_EXTRA_SLOT = 24h` habilita 1 slot extra (gestionada o heredada).
- Una posición por par. Antes de abrir se consulta KuCoin (`_sync_exchange_positions`): posiciones desconocidas se registran como heredadas y ocupan slot; si KuCoin no responde se bloquean nuevas aperturas.

### Cooldowns
- **Por activo (`COOLDOWN_HOURS = 12`):** 12h desde el cierre (SL/TP3/cierre externo), nunca desde la apertura.
- **Por racha (`MAX_DAILY_LOSSES = 3`):** 3 SL consecutivos → cooldown fijo de `MIN_DAILY_LOCK_HOURS = 12h` desde el último SL (persistido en `daily_lock_until`, sobrevive cambio de día y reinicios). Cualquier cierre no-SL (TP, BE, externo) rompe la racha.
- `/reanudar` y `/reset` liberan el cooldown inmediatamente (`trading_resume_timestamp` como punto de corte).
- Fuente de verdad para la racha: KuCoin (`get_exchange_close_events` via historial de posiciones cerradas); fallback al historial local si falla. Si la API falla, propaga la excepción (no devuelve `[]` que desactivaría el freno).

## 9. Flujo de escaneo y apertura

1. `enforce_loss_lock()` se ejecuta al inicio de **cada** escaneo (haya o no señales): reconcilia cierres SL, cuenta la racha, activa cooldown de 12h si 3 SL consecutivos, notifica una vez por día, omite el escaneo si está bloqueado. Respeta pausa manual y pausa fin de semana.
2. `run()` recorre `MULTI_PAIRS` (omite pares en cooldown o duplicados recientes, `ANTI_DUP_WINDOW = 300s`).
3. `ScoringEngine.evaluate_symbol()` ejecuta las 6 estrategias sobre 200 velas 15m cerradas (caché compartida por símbolo, invalidada cada ciclo), agrupa señales por (símbolo, lado), crea `EnsembleCandidate`, aplica umbrales (score/prob, estrictos si franja 00-12 UTC).
4. `_apply_entry_filters`: gate calidad, fuerza relativa, volatilidad, franja bloqueada, anti-momentum.
5. `select_best()`: filtra cooldown/máx trades, valida banda SL (1%-4%), ordena por (score, probabilidad, distancia SL), devuelve hasta `dynamic_max_trades()` candidatos (un símbolo por candidato).
6. `open_best_candidates()`: para cada candidato, calcula orden (`risk_manager.calculate_order`), convierte a contratos, abre a mercado + coloca SL, notifica Telegram (`alert_multistrategy_open` con "Estrategia principal" + mix completo), registra en `trade_logger` y persiste estado.
7. Slots extra (3ro/4to) heredan el multiplicador de riesgo y margen de la última posición abierta.

## 10. Modo DRY_RUN

- `DRY_RUN` (env `KUCOIN_DRY_RUN`, default `false` = real; `true` = simulación).
- `executor.create_exchange()` devuelve `DryRunExchange` que envuelve el real:
  - `create_order` simula apertura/cierre al **precio real del ticker** (órdenes stop TP/SL se registran sin modificar la posición).
  - `fetch_positions` / `fetch_my_trades` leen estado simulado (`dry_run_positions.json`).
  - `set_leverage`, `set_margin_mode`, `cancel_all_orders`, `fetch_open_orders`, `request` → no-op (no tocan la red).
  - `fetch_ticker`, `fetch_balance`, `fetch_ohlcv`, `load_markets` → reales.
- Estado simulado sobrevive reinicios vía `dry_run_positions.json` y `dry_run_balance.json`.
- Paso a real: ejecutar con `KUCOIN_DRY_RUN=false`.

## 11. Archivos de datos y variables de entorno

**Archivos:** `trade_history.json` / `.csv`, `dry_run_positions.json`, `dry_run_balance.json`, `multistrategy_state.json`, `bot_reset_state.json`, `bot.log`, `telegram_messages.jsonl` (log local de alertas Telegram, categoría + texto HTML completo, se graba incluso si falla el envío).

**`.env`:**
```
KUCOIN_API_KEY=
KUCOIN_SECRET=
KUCOIN_PASSPHRASE=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
OPENROUTER_API_KEY=
KUCOIN_DRY_RUN=
```

## 12. Checklist para replicar en otro proyecto/directorio

1. **Estructura:** crear `config.py`, `main.py`, `executor.py`, `notifier.py`, `telegram_listener.py`, `bot_state.py`, `trade_logger.py`, `time_utils.py`, `keep_alive.py` (opcional) y carpetas `engine/`, `strategies/`.
2. **Config:** definir `MULTI_PAIRS`, timeframes, `MIN_SCORE`, `MIN_PROB`, `ENSEMBLE_BONUS`, `STRATEGY_WEIGHTS`, `QUALITY_STRATEGIES`, `REQUIRE_QUALITY_STRATEGY`, `TP_ALLOCATION`, `TP1_R/TP2_R/TP3_R`, `TP_CAP_R`, `MIN_SL_DISTANCE_PCT`, `MAX_SL_DISTANCE_PCT`, `SL_MIN_BUFFER_PCT`, `BASE_RISK_PERCENT`, `DEFAULT_POSITION_MARGIN_USD`, `COOLDOWN_HOURS`, `MAX_DAILY_LOSSES`, `MIN_DAILY_LOCK_HOURS`, `MAX_CONCURRENT_TRADES_BASE/ABSOLUTE`, `POSITION_AGE_HOURS_FOR_EXTRA_SLOT`, filtros (momentum, RS, volatilidad, sesión), `SCAN_MINUTES/SCAN_SECOND`, `WEEKEND_PAUSE_*`, `DRY_RUN`.
3. **Motor:** `signals.py` (dataclass Signal), `indicators.py` (fetch_ohlcv solo cerradas, add_indicators con RSI/EMA/ATR/ADX/MACD, chop_index, swing_highs_lows, volume_profile, rsi_divergence), `scoring_engine.py` (EnsembleCandidate, score ponderado + bonus confluencia, índice probabilidad por factores, filtros de entrada), `risk_manager.py` (PositionTracker, calculate_order con TPs en R, cooldowns, slots dinámicos, reconstrucción/catch-up), `position_lifecycle.py` (apertura a mercado + solo SL, move_sl, close_partial, ensure_sl_protection), `trailing_manager.py` (monitor_trailing cada 1 min, TP1/TP2/TP3, SL, PnL estimado).
4. **Estrategias:** `base_strategy.py` (interfaz + caché de frames por símbolo), `registry.py` (6 instancias), y cada estrategia con `analyze()` devolviendo lista de `Signal`.
5. **Orquestador:** `scanner_multiestrategia.py` (enforce_loss_lock al inicio de cada escaneo, run → evaluate_symbol → open_best_candidates → open_candidate, anti-duplicación 5 min, slots extra heredan riesgo/margen).
6. **Conectividad:** `executor.py` (ccxt kucoinfutures, DryRunExchange opcional, _place_stop_order con reduceOnly/stopPriceType MP, get_open_positions strict, get_exchange_close_events desde historial de posiciones cerradas + fallback órdenes, get_sl_stop_price, get_close_pnl).
7. **Notificaciones:** `notifier.py` (alertas open/tp1/tp2/tp3/sl/close con precios a 4 decimales, _save_telegram_log antes del POST, analyze_sl_distances opcional), `telegram_listener.py` (comandos).
8. **Persistencia:** `persistence.py` (Redis Upstash con backoff exponencial + fallback local/multistrategy_state.json), `trade_logger.py` (JSON/CSV, reconcile_exchange_closes con ventana 7 días).
9. **Scheduler:** `main.py` (scan_chain cada 5 min :20s, monitor_positions cada 1 min, initialize() con reconciliación + catch-up, _ensure_position_protection al arrancar).
10. **Tests:** verificar `py_compile` de todos los archivos y ejecutar suite de tests (≥150 tests OK). Validar en DRY_RUN antes de pasar a real.
