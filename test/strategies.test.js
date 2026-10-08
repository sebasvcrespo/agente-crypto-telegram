import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIndicatorPool, evaluateStrategies, rankCandidates, classifyMarketState, filterByMarketRegime,
  smcReversal, trendPullback, vpMeanRevert, breakout, liquidityGrab, rsiDivergence,
  STRATEGY_LIST, MIN_SCORE, MIN_PROB
} from "../strategies.js";
import { INTERNAL_MULTI_STRATEGY_LIST, symbolToPionex } from "../multiStrategyEngine.js";
import { calculateLevels, applyLeverageCap } from "../riskManager.js";

const TF = 3600000;
const MIN15 = 900000;

function mk(t, o, h, l, c, v) {
  return [t, o, h, l, c, v];
}

function trend1h(n, start, stepPct = 0.003, vol = 1000) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 + stepPct);
    out.push(mk(i * TF, o, c * 1.001, o * 0.999, c, vol));
    p = c;
  }
  return out;
}

function flat15(n, price, vol = 1000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = price * (1 + Math.sin(i / 4) * 0.001);
    out.push(mk(i * MIN15, o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c, vol));
  }
  return out;
}

function breakoutSeries() {
  const p15 = [];
  for (let i = 0; i < 99; i++) {
    const o = 100 + Math.sin(i / 3) * 0.3;
    const c = 100 + Math.sin((i + 1) / 3) * 0.3;
    p15.push(mk(i * MIN15, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c, 1000));
  }
  p15.push(mk(99 * MIN15, 100.2, 103.2, 100.1, 103, 6000));
  return p15;
}

function smcSeries() {
  const p15 = [];
  for (let i = 0; i < 93; i++) {
    p15.push(mk(i * MIN15, 100, 100.2, 99.0 + (i % 2) * 0.1, 100, 1000));
  }
  p15.push(mk(93 * MIN15, 100, 100.2, 99.2, 100, 1000));
  p15.push(mk(94 * MIN15, 100, 100.0, 99.4, 99.8, 1000));
  p15.push(mk(95 * MIN15, 99.8, 100.0, 98.0, 99.8, 1500));
  p15.push(mk(96 * MIN15, 99.8, 100.7, 99.6, 100.6, 1200));
  p15.push(mk(97 * MIN15, 100.6, 101.0, 100.4, 100.9, 1200));
  p15.push(mk(98 * MIN15, 100.9, 101.3, 100.7, 101.2, 1200));
  p15.push(mk(99 * MIN15, 101.2, 101.6, 101.0, 101.4, 1200));
  return p15;
}

function pullback1h() {
  const out = trend1h(250, 100, 0.002);
  let p = out[out.length - 1][4];
  for (let i = 250; i < 260; i++) {
    const o = p;
    const c = p * 0.996;
    out.push(mk(i * TF, o, o * 1.001, c * 0.999, c, 1000));
    p = c;
  }
  return out;
}

function pullback15() {
  const out = flat15(119, 100);
  out.push(mk(119 * MIN15, 100, 100.3, 98.5, 100.1, 1200));
  return out;
}

function vpSeries() {
  const p1h = [];
  for (let i = 0; i < 100; i++) {
    const o = 100 + (i % 3) * 0.1;
    const c = 100.1 + (i % 3) * 0.1;
    p1h.push(mk(i * TF, o, 100.3, 99.9, c, 5000));
  }
  let p = 100;
  for (let i = 100; i < 120; i++) {
    const o = p;
    const c = p * 0.995;
    p1h.push(mk(i * TF, o, o * 1.001, c * 0.999, c, 50));
    p = c;
  }
  return p1h;
}

function liquidity1h() {
  const n = 130;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(mk(i * TF, 100, 100.1, 99.9, 100, 1000));
  }
  const set = (i, o, h, l, c, v) => { out[i] = mk(i * TF, o, h, l, c, v); };
  set(98, 99.9, 100.0, 99.5, 99.9, 1000);
  set(99, 99.9, 100.0, 99.5, 99.9, 1000);
  set(100, 98.2, 99.5, 98.0, 99.0, 1000);
  set(101, 99.9, 100.1, 99.5, 100, 1000);
  set(102, 99.9, 100.1, 99.5, 100, 1000);
  for (let i = 103; i <= 120; i++) {
    set(i, 100 + i * 0.01, 100.2 + i * 0.01, 99.9 + i * 0.01, 100.1 + i * 0.01, 1000);
  }
  set(124, 99.9, 101.4, 99.8, 101.2, 1000);
  set(125, 99.9, 101.4, 99.8, 101.2, 1000);
  set(126, 100.0, 101.0, 98.0, 99.5, 1000);
  set(127, 99.9, 101.0, 99.8, 100.2, 1000);
  set(128, 99.9, 101.0, 99.8, 100.2, 1000);
  set(129, 100.2, 100.5, 100.0, 100.3, 1000);
  return out;
}

function liquidity15() {
  const out = flat15(119, 99.5);
  out.push(mk(119 * MIN15, 99.5, 99.8, 97.5, 99.0, 1500));
  return out;
}

function divergence15() {
  const closes = [];
  for (let i = 0; i < 15; i++) closes.push(100);
  closes.push(100, 100.2, 100.1);
  for (let i = 0; i < 9; i++) closes.push(99.0 - i * 0.9);
  closes.push(90.5);
  for (let i = 0; i < 6; i++) closes.push(91.5 + i * 0.9);
  for (let i = 0; i < 7; i++) closes.push(95.2 - i * 0.95);
  closes.push(89.0);
  for (let i = 0; i < 5; i++) closes.push(90.2 + i * 1.0);

  const out = [];
  let prev = closes[0];
  for (let i = 0; i < closes.length; i++) {
    const o = prev;
    const c = closes[i];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3 + i * 0.01, c, 1000));
    prev = c;
  }
  return out;
}

test("STRATEGY_LIST expone las 6 estrategias del documento", () => {
  assert.deepEqual(STRATEGY_LIST, [
    "SMC_Reversal", "Trend_Pullback", "VP_Mean_Revert",
    "Breakout", "Liquidity_Grab", "RSI_Divergence"
  ]);
});

test("symbolToPionex convierte pares base BTC a sufijo _PERP", () => {
  assert.equal(symbolToPionex("XRP/BTC:BTC"), "XRP_BTC_PERP");
  assert.equal(symbolToPionex("ETH/BTC:BTC"), "ETH_BTC_PERP");
  assert.equal(symbolToPionex("BTC/USDT:USDT"), "BTC_USDT_PERP");
  for (const base of INTERNAL_MULTI_STRATEGY_LIST) {
    const symbol = base.endsWith("/BTC") ? `${base.replace("/BTC", "")}/BTC:BTC` : `${base}:USDT`;
    assert.ok(symbolToPionex(symbol).endsWith("_PERP"), `${symbol} debe mapear a _PERP`);
  }
});

test("SMC_Reversal detecta sweep + CHoCH (LONG)", () => {
  const pool = buildIndicatorPool(trend1h(260, 100), smcSeries());
  const r = smcReversal(pool);
  assert.ok(r, "debe generar señal");
  assert.equal(r.signal, "LONG");
  assert.ok(r.suggestedSlPrice < r.entry, "SL debe quedar bajo la entrada en LONG");
  assert.match(r.reasons[0], /Sweep/);
});

test("Trend_Pullback detecta tendencia + pullback + rechazo", () => {
  const pool = buildIndicatorPool(pullback1h(), pullback15());
  const r = trendPullback(pool);
  assert.ok(r, "debe generar señal");
  assert.equal(r.signal, "LONG");
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("VP_Mean_Revert detecta precio fuera de VA en LVN", () => {
  const candles = flat15(120, 90.5);
  candles[candles.length - 2][4] = 90;
  candles[candles.length - 1][4] = 90.5;
  const pool = buildIndicatorPool(vpSeries(), candles);
  const r = vpMeanRevert(pool);
  assert.ok(r, "debe generar señal");
  assert.equal(r.signal, "LONG");
  assert.ok(r.suggestedSlPrice < r.entry);
  assert.ok(r.targetPrice > r.entry, "POC debe quedar como objetivo favorable");
});

test("Breakout exige cierre fuera del rango y volumen >= 1.8x", () => {
  const pool = buildIndicatorPool(trend1h(260, 100), breakoutSeries());
  const r = breakout(pool);
  assert.ok(r, "debe generar señal");
  assert.equal(r.signal, "LONG");
  assert.ok(r.rvol >= 1.8);
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("Liquidity_Grab detecta barrido de EQL con mecha de rechazo", () => {
  const pool = buildIndicatorPool(liquidity1h(), liquidity15());
  const r = liquidityGrab(pool);
  assert.ok(r, "debe generar señal");
  assert.equal(r.signal, "LONG");
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("RSI_Divergence detecta divergencia regular", () => {
  const pool = buildIndicatorPool(trend1h(260, 100), divergence15());
  const r = rsiDivergence(pool);
  assert.ok(r, "debe generar señal");
  assert.equal(r.signal, "LONG");
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("Ensemble rankCandidates suma scores, bonus y calcula probabilidad determinista", () => {
  const signals = [
    { strategy: "Breakout", signal: "LONG", score: 75, prob: 75, reasons: [], suggestedSlPrice: 98, entry: 100, atr: 1, structure: true, rvol: 2 },
    { strategy: "Trend_Pullback", signal: "LONG", score: 70, prob: 70, reasons: [], suggestedSlPrice: 97, entry: 100, atr: 1, structure: true, rvol: 1.6 },
    { strategy: "SMC_Reversal", signal: "LONG", score: 60, prob: 60, reasons: [], suggestedSlPrice: 96, entry: 100, atr: 1, structure: false, rvol: 1 }
  ];
  const cands = rankCandidates(signals, null);
  assert.equal(cands.length, 1);
  const c = cands[0];
  assert.equal(c.direction, "LONG");
  assert.equal(c.score, 100);
  assert.equal(c.score, Math.round(Math.min(100, 75 + 70 + 60 + 5 * 2)));
  assert.equal(c.bestSlPrice, 96);
  assert.ok(c.probability >= MIN_PROB && c.probability <= 95);
});

test("rankCandidates descarta candidatos bajo MIN_PROB", () => {
  const cands = rankCandidates([
    { strategy: "Breakout", signal: "LONG", score: 60, prob: 60, reasons: [], suggestedSlPrice: 99.5, entry: 100, atr: 5, structure: false, rvol: 1 }
  ], null);
  assert.equal(cands.length, 0);
});

test("filterByMarketRegime alinea tendencia y bloquea transicion", () => {
  const signals = [
    { strategy: "Trend_Pullback", signal: "LONG" },
    { strategy: "Breakout", signal: "SHORT" },
    { strategy: "VP_Mean_Revert", signal: "SHORT" },
    { strategy: "RSI_Divergence", signal: "LONG" }
  ];

  assert.deepEqual(
    filterByMarketRegime(signals, { state: "trending", direction: "bullish" }),
    [signals[0]]
  );
  assert.deepEqual(
    filterByMarketRegime(signals, { state: "lateral", direction: "neutral" }),
    [signals[2], signals[3]]
  );
  assert.deepEqual(
    filterByMarketRegime(signals, { state: "transitional", direction: "neutral" }),
    []
  );
});

test("pipeline completo corre en todos los pares base BTC del proyecto", () => {
  for (const base of INTERNAL_MULTI_STRATEGY_LIST) {
    const price = base.endsWith("/BTC") ? 0.00002 : 60000;
    const d1h = trend1h(260, price, 0.002);
    const d15 = flat15(120, price);
    const pool = buildIndicatorPool(d1h, d15);
    assert.ok(pool.p1h && pool.p15, `${base}: pool incompleto`);

    const state = classifyMarketState(pool);
    assert.ok(["trending", "lateral", "transitional", "unknown"].includes(state.state));

    const results = evaluateStrategies(d1h, d15, pool);
    assert.ok(Array.isArray(results), `${base}: results debe ser array`);

    const cands = rankCandidates(results, state);
    for (const c of cands) {
      assert.ok(c.direction === "LONG" || c.direction === "SHORT");
      assert.ok(c.score >= MIN_SCORE && c.score <= 100);
      assert.ok(c.probability >= MIN_PROB && c.probability <= 95);
      assert.ok(c.entry > 0);
      if (c.direction === "LONG") assert.ok(c.bestSlPrice < c.entry);
      else assert.ok(c.bestSlPrice > c.entry);
    }
  }
});

test("calculateLevels mantiene la banda de SL 1%-3% con guarda de lado", () => {
  const symBtc = "XRP/BTC:BTC";
  assert.ok(calculateLevels(100, 2, "LONG", symBtc, 98), "2% LONG válido");
  assert.ok(calculateLevels(100, 2, "SHORT", symBtc, 102), "2% SHORT válido");
  assert.equal(calculateLevels(100, 0.5, "LONG", symBtc, 99.5), null, "<1% inválido");
  assert.equal(calculateLevels(100, 3, "LONG", symBtc, 96), null, ">3% inválido");
  assert.equal(calculateLevels(100, 2, "LONG", symBtc, 102), null, "SL lado incorrecto");
});

test("applyLeverageCap recalcula nocional y riesgo real", () => {
  const levels = calculateLevels(100, 2, "LONG", "XRP/BTC:BTC", 98);
  const capped = applyLeverageCap(levels, 2);
  assert.equal(capped.leverage, 2);
  assert.equal(capped.notionalBtc, 0.0002);
  assert.ok(capped.riskCapped);
  assert.ok(capped.riskBtc < levels.riskBtc);
  assert.equal(capped.exchangeMax, 2);
});
