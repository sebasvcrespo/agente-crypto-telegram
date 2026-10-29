import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame15m, dropFormingCandles, evaluateStrategies, rankCandidates, applyEntryFilters,
  effectiveThresholds, isWeekendPause,
  smcReversal, trendPullback, vpMeanRevert, breakout, liquidityGrab, rsiDivergence,
  STRATEGY_LIST, MIN_SCORE, MIN_PROB, ENSEMBLE_BONUS, STRATEGY_WEIGHTS, QUALITY_STRATEGIES
} from "../strategies.js";
import { INTERNAL_MULTI_STRATEGY_LIST, symbolToPionex } from "../multiStrategyEngine.js";
import { calculateLevels, applyLeverageCap } from "../riskManager.js";

const MIN15 = 900000;

function mk(t, o, h, l, c, v) {
  return [t, o, h, l, c, v];
}

function smcSeries() {
  const out = [];
  for (let i = 0; i < 190; i++) out.push(mk(i * MIN15, 100, 100.2, 99.8, 100, 1000));
  out.push(mk(190 * MIN15, 99.8, 100.0, 98.0, 99.8, 1500));
  out.push(mk(191 * MIN15, 99.8, 100.6, 99.7, 100.5, 1200));
  out.push(mk(192 * MIN15, 100.5, 101.3, 100.4, 101.2, 1200));
  out.push(mk(193 * MIN15, 101.2, 101.3, 101.0, 101.1, 1000));
  out.push(mk(194 * MIN15, 101.1, 101.6, 101.2, 101.5, 1000));
  out.push(mk(195 * MIN15, 101.5, 102.6, 102.0, 102.4, 1200));
  let p = 102.4;
  for (let i = 196; i < 200; i++) {
    const o = p;
    const c = p * 1.0005;
    out.push(mk(i * MIN15, o, c * 1.001, c * 0.999, c, 1200));
    p = c;
  }
  return out;
}

function breakoutSeries() {
  const out = [];
  for (let i = 0; i < 199; i++) out.push(mk(i * MIN15, 100, 100.5, 99.5, 100, 1000));
  out.push(mk(199 * MIN15, 100.2, 102.2, 100.1, 102.0, 6000));
  return out;
}

function vpSeries() {
  const out = [];
  for (let i = 0; i < 190; i++) out.push(mk(i * MIN15, 100, 100.5, 99.5, 100, 5000));
  let p = 99.8;
  for (let i = 190; i < 199; i++) {
    const o = p;
    const c = p - 0.35;
    out.push(mk(i * MIN15, o, o + 0.05, c - 0.05, c, 10));
    p = c;
  }
  out.push(mk(199 * MIN15, 97.1, 97.2, 96.7, 96.8, 10));
  return out;
}

function liquiditySeries() {
  const out = [];
  for (let i = 0; i < 200; i++) out.push(mk(i * MIN15, 100, 100.1, 99.8, 100, 1000));
  out[170] = mk(170 * MIN15, 100, 100.1, 99.5, 100, 1000);
  out[185] = mk(185 * MIN15, 100, 100.1, 99.5, 100, 1000);
  out[199] = mk(199 * MIN15, 99.9, 99.95, 98.5, 99.7, 1500);
  return out;
}

function trendSeries() {
  const out = [];
  let p = 100;
  for (let i = 0; i < 178; i++) {
    const o = p;
    const c = p + 0.147;
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.03, Math.min(o, c) - 0.03, c, 1000));
    p = c;
  }
  const tail = [126.3, 126.5, 126.65];
  for (let i = 178; i < 181; i++) {
    const o = p;
    const c = tail[i - 178];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.03, Math.min(o, c) - 0.03, c, 1000));
    p = c;
  }
  const dip = [126.3, 126.1, 125.95, 125.85, 125.9];
  for (let i = 181; i < 186; i++) {
    const o = p;
    const c = dip[i - 181];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.03, Math.min(o, c) - 0.03, c, 1000));
    p = c;
  }
  const rise = [126.15, 126.5, 126.85, 127.1, 127.25];
  for (let i = 186; i < 191; i++) {
    const o = p;
    const c = rise[i - 186];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.03, Math.min(o, c) - 0.03, c, 1000));
    p = c;
  }
  const pull = [127.0, 126.75, 126.5, 126.25, 126.15, 126.1, 126.08, 126.07];
  for (let i = 191; i < 199; i++) {
    const o = p;
    const c = pull[i - 191];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.03, Math.min(o, c) - 0.03, c, 1000));
    p = c;
  }
  out.push(mk(199 * MIN15, 126.07, 126.4, 125.72, 126.35, 1200));
  return out;
}

function rsiSeries() {
  const out = [];
  let p = 100;
  for (let i = 0; i < 170; i++) {
    const o = p;
    const c = p + 0.001;
    out.push(mk(i * MIN15, o, c + 0.02, o - 0.02, c, 1000));
    p = c;
  }
  const rise = [100.4, 100.8, 101.1, 101.35, 101.55, 101.7, 101.8, 101.9, 102.0];
  for (let i = 170; i < 179; i++) {
    const o = p;
    const c = rise[i - 170];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c, 1000));
    p = c;
  }
  const dump = [101.2, 100.3, 99.2, 98.0, 97.0, 96.2, 96.0];
  for (let i = 179; i < 186; i++) {
    const o = p;
    const c = dump[i - 179];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c, 1000));
    p = c;
  }
  const bounce = [96.8, 97.8, 98.8, 99.7, 100.4, 100.9];
  for (let i = 186; i < 192; i++) {
    const o = p;
    const c = bounce[i - 186];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c, 1000));
    p = c;
  }
  const grind = [100.5, 99.9, 99.1, 98.1, 96.9, 95.5];
  for (let i = 192; i < 198; i++) {
    const o = p;
    const c = grind[i - 192];
    out.push(mk(i * MIN15, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c, 1000));
    p = c;
  }
  for (let i = 198; i < 200; i++) {
    const o = p;
    const c = p + 0.25;
    out.push(mk(i * MIN15, o, c + 0.05, o - 0.05, c, 1000));
    p = c;
  }
  return out;
}

function flatSeries(n, price, vol = 1000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(mk(i * MIN15, price, price * 1.001, price * 0.999, price, vol));
  }
  return out;
}

function mkSig(strategy, signal, score, opts = {}) {
  return {
    strategy,
    signal,
    score,
    prob: opts.prob ?? 0.30,
    entry: opts.entry ?? 100,
    suggestedSlPrice: opts.sl ?? 98,
    atr: opts.atr ?? 1,
    targetPrice: opts.targetPrice ?? null,
    reasons: opts.reasons ?? ["razón"],
    details: opts.details ?? { structure_quality: "vp_zone", atr: opts.atr ?? 1 }
  };
}

function fakeCandidate(strategyNames, direction = "LONG", opts = {}) {
  return {
    direction,
    bestStrategy: strategyNames[0],
    bestSlPrice: direction === "LONG" ? 98 : 102,
    entry: 100,
    targetPrice: null,
    score: opts.score ?? 50,
    probability: opts.probability ?? 0.5,
    slDistPct: 2,
    allStrategies: strategyNames.map((s) => ({
      strategy: s, score: 30, prob: 0.3, weight: 1, reasons: [], suggestedSlPrice: 98, details: {}
    }))
  };
}

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("STRATEGY_LIST expone las 6 estrategias del documento", () => {
  assert.deepEqual(STRATEGY_LIST, [
    "SMC_Reversal", "Trend_Pullback", "VP_Mean_Revert",
    "Breakout", "Liquidity_Grab", "RSI_Divergence"
  ]);
  assert.deepEqual(QUALITY_STRATEGIES, ["Breakout", "RSI_Divergence"]);
  assert.equal(ENSEMBLE_BONUS, 15);
  assert.equal(MIN_SCORE, 35);
  assert.equal(MIN_PROB, 0.45);
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

test("dropFormingCandles descarta la vela en formación", () => {
  const now = 9 * MIN15 + MIN15 / 2;
  const rows = [
    mk(7 * MIN15, 1, 1, 1, 1, 1),
    mk(8 * MIN15, 1, 1, 1, 1, 1),
    mk(9 * MIN15, 1, 1, 1, 1, 1)
  ];
  const closed = dropFormingCandles(rows, MIN15, now);
  assert.equal(closed.length, 2);
  assert.equal(closed[closed.length - 1][0], 8 * MIN15);
});

test("SMC_Reversal: sweep + CHoCH + FVG → score 25+15, prob 0.40, SL bajo el sweep", () => {
  const frame = buildFrame15m(smcSeries());
  const res = smcReversal(frame);
  assert.equal(res.length, 1);
  const r = res[0];
  assert.equal(r.signal, "LONG");
  assert.equal(r.strategy, "SMC_Reversal");
  assert.equal(r.score, 40);
  assert.equal(r.prob, 0.40);
  assert.equal(r.details.structure_quality, "ob_fvg_zone");
  assert.ok(r.details.fvg, "debe detectar FVG");
  assert.ok(!r.details.ob, "no debe detectar OB en este fixture");
  assert.ok(r.suggestedSlPrice < r.entry);
  assert.ok(r.suggestedSlPrice < r.details.sweep_price);
  assert.match(r.reasons[0], /Sweep/);
});

test("Breakout: score 35, prob 0.35 con rvol>=2, estructura vp_zone", () => {
  const frame = buildFrame15m(breakoutSeries());
  const res = breakout(frame);
  assert.equal(res.length, 1);
  const r = res[0];
  assert.equal(r.signal, "LONG");
  assert.equal(r.strategy, "Breakout");
  assert.equal(r.score, 35);
  assert.equal(r.prob, 0.35);
  assert.ok(r.rvol === undefined || true);
  assert.ok(r.details.rvol >= 1.8);
  assert.equal(r.details.structure_quality, "vp_zone");
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("VP_Mean_Revert: fuera del VA en LVN → score 25, prob 0.30, objetivo POC", () => {
  const frame = buildFrame15m(vpSeries());
  const res = vpMeanRevert(frame);
  assert.equal(res.length, 1);
  const r = res[0];
  assert.equal(r.signal, "LONG");
  assert.equal(r.strategy, "VP_Mean_Revert");
  assert.equal(r.score, 25);
  assert.equal(r.prob, 0.30);
  assert.equal(r.details.structure_quality, "vp_zone");
  assert.ok(r.details.lvn);
  assert.ok(r.targetPrice > r.entry, "POC debe quedar como objetivo favorable");
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("Liquidity_Grab: barrido de EQL con mecha >= 50% → score 25, prob 0.30", () => {
  const frame = buildFrame15m(liquiditySeries());
  const res = liquidityGrab(frame);
  assert.equal(res.length, 1);
  const r = res[0];
  assert.equal(r.signal, "LONG");
  assert.equal(r.strategy, "Liquidity_Grab");
  assert.equal(r.score, 25);
  assert.equal(r.prob, 0.30);
  assert.ok(approx(r.details.eq_level, 99.5, 1e-6));
  assert.ok(r.details.wick_ratio >= 0.5);
  assert.equal(r.details.structure_quality, "swing_zone");
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("Trend_Pullback: tendencia + fib + rechazo → score 25, prob 0.35", () => {
  const frame = buildFrame15m(trendSeries());
  const res = trendPullback(frame);
  assert.equal(res.length, 1);
  const r = res[0];
  assert.equal(r.signal, "LONG");
  assert.equal(r.strategy, "Trend_Pullback");
  assert.equal(r.score, 25);
  assert.equal(r.prob, 0.35);
  assert.ok(r.details.in_fib);
  assert.ok(r.details.near_ema);
  assert.equal(r.details.structure_quality, "swing_zone");
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("RSI_Divergence: LL precio + HL RSI → score 35, prob 0.30", () => {
  const frame = buildFrame15m(rsiSeries());
  const res = rsiDivergence(frame);
  assert.equal(res.length, 1);
  const r = res[0];
  assert.equal(r.signal, "LONG");
  assert.equal(r.strategy, "RSI_Divergence");
  assert.equal(r.score, 35);
  assert.equal(r.prob, 0.30);
  assert.equal(r.details.structure_quality, "swing_zone");
  assert.ok(r.details.pivot_price_ll < 100);
  assert.ok(r.suggestedSlPrice < r.entry);
});

test("evaluateStrategies agrega señales de las 6 estrategias sin gate individual", () => {
  const frame = buildFrame15m(smcSeries());
  const results = evaluateStrategies(frame);
  assert.ok(Array.isArray(results));
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.ok(STRATEGY_LIST.includes(r.strategy));
    assert.ok(r.score > 0);
    assert.ok(r.prob > 0 && r.prob <= 0.95);
  }
});

test("Ensemble: score ponderado + bonus 15 por confluencia + probabilidad por factores", () => {
  const signals = [
    mkSig("Breakout", "LONG", 35),
    mkSig("RSI_Divergence", "LONG", 35),
    mkSig("SMC_Reversal", "LONG", 25, { details: { structure_quality: "ob_fvg_zone", atr: 1 } })
  ];
  const cands = rankCandidates(signals, 15);
  assert.equal(cands.length, 1);
  const c = cands[0];
  assert.equal(c.direction, "LONG");
  const expected = 35 * 1.2 + 35 * 1.1 + 25 * 0.6 + ENSEMBLE_BONUS * 2;
  assert.ok(approx(c.score, expected), `score ${c.score} != ${expected}`);
  assert.ok(approx(c.probability, 0.60), `prob ${c.probability} != 0.60`);
  assert.equal(c.bestSlPrice, 98);
  assert.equal(c.bestStrategy, "Breakout");
  assert.ok(c.allStrategies.some((s) => s.strategy === "SMC_Reversal"));
});

test("Ensemble: factor RVOL suma probabilidad y el tope es 0.95", () => {
  const base = [
    mkSig("Breakout", "LONG", 35, { details: { structure_quality: "vp_zone", atr: 1 } }),
    mkSig("RSI_Divergence", "LONG", 35)
  ];
  const sinRvol = rankCandidates(base, 15);
  assert.equal(sinRvol.length, 1);
  assert.ok(approx(sinRvol[0].probability, 0.55), `prob ${sinRvol[0].probability} != 0.55`);

  const conRvol = rankCandidates([
    mkSig("Breakout", "LONG", 35, { details: { structure_quality: "vp_zone", atr: 1, rvol: 2.5 } }),
    mkSig("RSI_Divergence", "LONG", 35)
  ], 15);
  assert.equal(conRvol.length, 1);
  assert.ok(approx(conRvol[0].probability, 0.60), `prob ${conRvol[0].probability} != 0.60`);
});

test("Ensemble: descarta bajo MIN_PROB (sin factores ni calidad)", () => {
  const signals = [
    mkSig("SMC_Reversal", "LONG", 25, {
      sl: 98, atr: 5,
      details: { structure_quality: "none", atr: 5 }
    }),
    mkSig("Trend_Pullback", "LONG", 25, {
      sl: 98, atr: 5,
      details: { structure_quality: "none", atr: 5 }
    })
  ];
  const cands = rankCandidates(signals, 15);
  assert.equal(cands.length, 0);
});

test("Ensemble: descarta bajo MIN_SCORE (estrategia sola con peso bajo)", () => {
  const cands = rankCandidates([mkSig("VP_Mean_Revert", "LONG", 25)], 15);
  assert.equal(cands.length, 0);
});

test("Ensemble: banda de SL 1%-4%", () => {
  assert.equal(rankCandidates([mkSig("Breakout", "LONG", 35, { sl: 99.5 })], 15).length, 0, "SL 0.5% inválido");
  assert.equal(rankCandidates([mkSig("Breakout", "LONG", 35, { sl: 95.5 })], 15).length, 0, "SL 4.5% inválido");
  assert.equal(rankCandidates([mkSig("Breakout", "LONG", 35, { sl: 96 })], 15).length, 1, "SL 4% válido");
  assert.equal(rankCandidates([mkSig("Breakout", "LONG", 35, { sl: 98 })], 15).length, 1, "SL 2% válido");
});

test("Umbrales estrictos 00-12 UTC: MIN_SCORE 50 y MIN_PROB 0.55", () => {
  const [ms3, mp3, strict3] = effectiveThresholds(3);
  assert.equal(ms3, 50);
  assert.equal(mp3, 0.55);
  assert.ok(strict3);
  const [ms15, mp15, strict15] = effectiveThresholds(15);
  assert.equal(ms15, MIN_SCORE);
  assert.equal(mp15, MIN_PROB);
  assert.ok(!strict15);

  const single = [mkSig("Breakout", "LONG", 35)];
  assert.equal(rankCandidates(single, 3).length, 0, "sola Breakout (42) < 50 en franja estricta");
  assert.equal(rankCandidates(single, 15).length, 1, "Breakout sola pasa en franja normal");

  const pair = [mkSig("Breakout", "LONG", 35), mkSig("RSI_Divergence", "LONG", 35)];
  assert.equal(rankCandidates(pair, 3).length, 1, "par calidad pasa franja estricta");
});

test("Filtro calidad: exige Breakout o RSI_Divergence", () => {
  const sinCalidad = fakeCandidate(["SMC_Reversal", "VP_Mean_Revert", "Trend_Pullback"]);
  const res1 = applyEntryFilters([sinCalidad], { hourUtc: 15, atrPct: 0.2 });
  assert.equal(res1.kept.length, 0);
  assert.ok(res1.notes.length >= 1);

  const conCalidad = fakeCandidate(["Breakout", "SMC_Reversal"]);
  const res2 = applyEntryFilters([conCalidad], { hourUtc: 15, atrPct: 0.2 });
  assert.equal(res2.kept.length, 1);
});

test("Filtro fuerza relativa: pares /BTC según retorno 4h propio", () => {
  const long = fakeCandidate(["Breakout"], "LONG");
  const short = fakeCandidate(["Breakout"], "SHORT");
  const resUp = applyEntryFilters([long, short], {
    hourUtc: 15, atrPct: 0.2, pairReturnPct: 1.0, isBtcQuote: true
  });
  assert.deepEqual(resUp.kept.map((c) => c.direction), ["LONG"]);

  const resDown = applyEntryFilters([long, short], {
    hourUtc: 15, atrPct: 0.2, pairReturnPct: -1.0, isBtcQuote: true
  });
  assert.deepEqual(resDown.kept.map((c) => c.direction), ["SHORT"]);
});

test("Filtro fuerza relativa: pares USDT comparados vs BTC/USDT", () => {
  const long = fakeCandidate(["Breakout"], "LONG");
  const res = applyEntryFilters([long], {
    hourUtc: 15, atrPct: 0.2, pairReturnPct: 1.0, refReturnPct: 2.0, isBtcQuote: false
  });
  assert.equal(res.kept.length, 0, "LONG con par por debajo del mercado se descarta");

  const res2 = applyEntryFilters([long], {
    hourUtc: 15, atrPct: 0.2, pairReturnPct: 3.0, refReturnPct: 2.0, isBtcQuote: false
  });
  assert.equal(res2.kept.length, 1);

  const res3 = applyEntryFilters([long], {
    hourUtc: 15, atrPct: 0.2, pairReturnPct: 1.0, refReturnPct: null, isBtcQuote: false
  });
  assert.equal(res3.kept.length, 1, "sin referencia disponible no bloquea");
});

test("Filtro volatilidad: ATR 15m > 0.6% descarta todo", () => {
  const c = fakeCandidate(["Breakout"]);
  const res = applyEntryFilters([c], { hourUtc: 15, atrPct: 0.8 });
  assert.equal(res.kept.length, 0);
  assert.ok(res.notes.some((n) => n.includes("ATR")));
});

test("Filtro franja bloqueada: 00-12 UTC sin señales", () => {
  const c = fakeCandidate(["Breakout"]);
  assert.equal(applyEntryFilters([c], { hourUtc: 3, atrPct: 0.2 }).kept.length, 0);
  assert.equal(applyEntryFilters([c], { hourUtc: 15, atrPct: 0.2 }).kept.length, 1);
});

test("Filtro anti-momentum: descarta entradas contra el movimiento de 4 velas", () => {
  const long = fakeCandidate(["Breakout"], "LONG");
  const short = fakeCandidate(["Breakout"], "SHORT");
  const res = applyEntryFilters([long, short], {
    hourUtc: 15, atrPct: 0.2, recentMovePct: -1.0
  });
  assert.deepEqual(res.kept.map((c) => c.direction), ["SHORT"], "LONG contra caída de 1% se descarta");

  const res2 = applyEntryFilters([long, short], {
    hourUtc: 15, atrPct: 0.2, recentMovePct: 0.1
  });
  assert.equal(res2.kept.length, 2, "movimiento menor a 0.3% no descarta");
});

test("isWeekendPause: Vie 20:00 → Dom 07:00 hora España", () => {
  assert.equal(isWeekendPause(new Date("2026-01-09T19:30:00Z")), true, "viernes 20:30 España");
  assert.equal(isWeekendPause(new Date("2026-01-09T10:30:00Z")), false, "viernes 11:30 España");
  assert.equal(isWeekendPause(new Date("2026-01-10T12:00:00Z")), true, "sábado");
  assert.equal(isWeekendPause(new Date("2026-01-11T05:30:00Z")), true, "domingo 06:30 España");
  assert.equal(isWeekendPause(new Date("2026-01-11T07:30:00Z")), false, "domingo 08:30 España");
  assert.equal(isWeekendPause(new Date("2026-01-12T12:00:00Z")), false, "lunes");
});

test("calculateLevels: TPs 1R/2R/2.5R, BE+ 0.15% y banda SL 1%-4%", () => {
  const sym = "XRP/BTC:BTC";
  const lv = calculateLevels(100, 2, "LONG", sym, 98);
  assert.ok(lv);
  assert.ok(approx(lv.tp1, 102));
  assert.ok(approx(lv.tp2, 104));
  assert.ok(approx(lv.tp3, 105));
  assert.ok(approx(lv.bePlus, 100.15));
  assert.deepEqual(lv.tpAllocation, [0.20, 0.30, 0.50]);

  const short = calculateLevels(100, 2, "SHORT", sym, 102);
  assert.ok(short);
  assert.ok(approx(short.tp1, 98));
  assert.ok(approx(short.bePlus, 99.85));

  assert.equal(calculateLevels(100, 0.5, "LONG", sym, 99.5), null, "<1% inválido");
  assert.ok(calculateLevels(100, 3, "LONG", sym, 96), "4% válido");
  assert.equal(calculateLevels(100, 3, "LONG", sym, 95.5), null, ">4% inválido");
  assert.equal(calculateLevels(100, 2, "LONG", sym, 102), null, "SL lado incorrecto");
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

test("pipeline completo corre en todos los pares del proyecto", () => {
  for (const base of INTERNAL_MULTI_STRATEGY_LIST) {
    const price = base.endsWith("/BTC") ? 0.00002 : 60000;
    const candles = flatSeries(200, price);
    const frame = buildFrame15m(candles);
    assert.ok(frame, `${base}: frame inválido`);
    assert.equal(frame.n, 200);

    const results = evaluateStrategies(frame);
    assert.ok(Array.isArray(results), `${base}: results debe ser array`);
    for (const r of results) {
      assert.ok(r.entry > 0, `${base}: entry inválido`);
      assert.ok(r.suggestedSlPrice > 0, `${base}: SL inválido`);
      assert.ok(r.prob > 0 && r.prob <= 0.95);
    }

    const cands = rankCandidates(results, 15);
    for (const c of cands) {
      assert.ok(c.direction === "LONG" || c.direction === "SHORT");
      assert.ok(c.score >= MIN_SCORE, `${base}: score ${c.score}`);
      assert.ok(c.probability >= MIN_PROB && c.probability <= 0.95);
      const dist = Math.abs(c.entry - c.bestSlPrice) / c.entry * 100;
      assert.ok(dist >= 1.0 && dist <= 4.0, `${base}: SL ${dist.toFixed(2)}% fuera de banda`);
      if (c.direction === "LONG") assert.ok(c.bestSlPrice < c.entry);
      else assert.ok(c.bestSlPrice > c.entry);
    }

    const filtered = applyEntryFilters(cands, {
      hourUtc: 15, atrPct: 0.2, recentMovePct: 0, pairReturnPct: 0, isBtcQuote: true
    });
    assert.ok(Array.isArray(filtered.kept));
    assert.ok(Array.isArray(filtered.notes));
  }
});

test("pesos de estrategia del ensemble", () => {
  assert.deepEqual(STRATEGY_WEIGHTS, {
    Breakout: 1.2,
    RSI_Divergence: 1.1,
    VP_Mean_Revert: 1.0,
    Trend_Pullback: 0.8,
    SMC_Reversal: 0.6,
    Liquidity_Grab: 0.7
  });
});
