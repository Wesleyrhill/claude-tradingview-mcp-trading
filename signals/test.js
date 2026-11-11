import test from "node:test";
import assert from "node:assert/strict";
import { ema, rsi, atr, indicators, evaluateEntry, evaluateExit, sizePosition, openPosition, backtest } from "./lib.js";

const CFG = { pullbackPct: 1.5, volMult: 1.0, maxExtPct: 12, rsiMax: 75, rsiExit: 80, atrMult: 1, minStopPct: 1.5, maxStopPct: 5, timeStopBars: 5 };

// A steady uptrend, 0.5 per bar, starting at 100.
function uptrend(n = 90) {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * 0.5;
    return { t: i * 3600, open: close - 0.3, high: close + 0.4, low: close - 0.6, close, volume: 1000 };
  });
}

// Uptrend followed by one bar that dips to the 20 EMA and closes green above it.
function withPullback() {
  const candles = uptrend();
  const e20 = ema(candles.map((c) => c.close), 20).at(-1);
  const t = candles.at(-1).t + 3600;
  candles.push({ t, open: e20 + 0.2, high: e20 + 1.4, low: e20 * 0.997, close: e20 + 1.2, volume: 2500 });
  return candles;
}

test("ema matches a hand calculation", () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2);
  assert.equal(out[3], 3);
  assert.equal(out[4], 4);
});

test("rsi is 100 with no losses and 50 when gains equal losses", () => {
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => i)).at(-1), 100);
  const zigzag = Array.from({ length: 31 }, (_, i) => (i % 2 ? 11 : 10));
  assert.ok(Math.abs(rsi(zigzag).at(-1) - 50) < 5);
});

test("atr equals the bar range when ranges are constant", () => {
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: i, open: 10, high: 11, low: 9, close: 10, volume: 1 }));
  assert.equal(atr(flat).at(-1), 2);
});

test("a plain uptrend bar with no pullback is not a signal", () => {
  const candles = uptrend();
  const e = evaluateEntry(candles, indicators(candles), CFG);
  assert.equal(e.ok, false);
  assert.equal(e.checks.find((c) => c.name.startsWith("Pulled back")).pass, false);
});

test("a pullback to the 20 EMA in an uptrend is a signal with a sane plan", () => {
  const candles = withPullback();
  const e = evaluateEntry(candles, indicators(candles), CFG);
  assert.equal(e.ok, true, JSON.stringify(e.checks.filter((c) => !c.pass)));
  const p = e.plan;
  assert.ok(p.stop < p.entry && p.entry < p.target1 && p.target1 < p.target2);
  assert.ok(p.stopPct >= CFG.minStopPct && p.stopPct <= CFG.maxStopPct);
  assert.ok(Math.abs((p.target1 - p.entry) / (p.entry - p.stop) - 2) < 1e-9);
});

test("weak volume blocks the signal", () => {
  const candles = withPullback();
  candles.at(-1).volume = 300;
  assert.equal(evaluateEntry(candles, indicators(candles), CFG).ok, false);
});

test("a downtrend never signals", () => {
  const candles = uptrend().map((c, i) => ({ ...c, open: 200 - i * 0.5 + 0.3, high: 200 - i * 0.5 + 0.6, low: 200 - i * 0.5 - 0.4, close: 200 - i * 0.5 }));
  assert.equal(evaluateEntry(candles, indicators(candles), CFG).ok, false);
});

test("position size risks the configured percent and respects the cap", () => {
  const plan = { entry: 100, stopPct: 3 };
  const s = sizePosition(plan, { sizeUsd: 1000, riskPct: 1.5, maxPositionPct: 100 });
  assert.ok(Math.abs(s.sizeUsd - 500) < 1e-9);
  assert.ok(Math.abs(s.riskUsd - 15) < 1e-9);
  const capped = sizePosition(plan, { sizeUsd: 1000, riskPct: 1.5, maxPositionPct: 35 });
  assert.equal(capped.sizeUsd, 350);
  assert.equal(capped.capped, true);
  assert.ok(Math.abs(capped.riskUsd - 10.5) < 1e-9);
});

function position() {
  const plan = { signalTime: 0, entry: 100, stop: 96, stopPct: 4, target1: 108, target2: 112, atr: 2 };
  return openPosition(plan, { qty: 1, sizeUsd: 100 });
}
const bar = (t, open, high, low, close) => ({ t, open, high, low, close, volume: 1 });
const noInd = (n) => ({ ema20: new Array(n).fill(null), rsi14: new Array(n).fill(null) });

test("stop hit closes the trade at -1R", () => {
  const candles = [bar(1, 100, 101, 95, 96)];
  const res = evaluateExit(position(), candles, noInd(1), CFG);
  assert.equal(res.closed, true);
  assert.equal(res.events[0].type, "STOP");
  assert.ok(Math.abs(res.position.realizedR + 1) < 1e-9);
});

test("a gap below the stop fills at the open, not the stop", () => {
  const res = evaluateExit(position(), [bar(1, 92, 93, 90, 91)], noInd(1), CFG);
  assert.equal(res.events[0].price, 92);
  assert.ok(Math.abs(res.position.realizedR + 2) < 1e-9);
});

test("target 1 sells half and moves the stop to entry; target 2 finishes at +2.5R", () => {
  const candles = [bar(1, 100, 109, 99, 108), bar(2, 108, 113, 107, 112)];
  const res = evaluateExit(position(), candles, noInd(2), CFG);
  assert.deepEqual(res.events.map((e) => e.type), ["HALF", "TARGET"]);
  assert.ok(Math.abs(res.position.realizedR - 2.5) < 1e-9);
  const half = evaluateExit(position(), candles.slice(0, 1), noInd(1), CFG);
  assert.equal(half.closed, false);
  assert.equal(half.position.stop, 100);
});

test("after target 1 a return to entry exits the rest at breakeven (+1R total)", () => {
  const candles = [bar(1, 100, 109, 99, 108), bar(2, 105, 106, 99.5, 100)];
  const res = evaluateExit(position(), candles, noInd(2), CFG);
  assert.equal(res.events.at(-1).type, "STOP_BREAKEVEN");
  assert.ok(Math.abs(res.position.realizedR - 1) < 1e-9);
});

test("no progress after timeStopBars triggers the time stop", () => {
  const candles = Array.from({ length: 5 }, (_, i) => bar(i + 1, 100, 100.5, 99, 100.1));
  const res = evaluateExit(position(), candles, noInd(5), CFG);
  assert.equal(res.closed, true);
  assert.match(res.events[0].note, /time stop/);
});

test("already-checked candles are not processed twice", () => {
  const candles = [bar(1, 100, 109, 99, 108)];
  const first = evaluateExit(position(), candles, noInd(1), CFG);
  const second = evaluateExit(first.position, candles, noInd(1), CFG);
  assert.equal(second.events.length, 0);
  assert.equal(second.position.barsHeld, 1);
});

test("backtest runs end to end and reports consistent totals", () => {
  const candles = withPullback();
  let last = candles.at(-1);
  for (let i = 0; i < 30; i++) {
    const close = last.close + 0.8;
    last = { t: last.t + 3600, open: last.close, high: close + 0.3, low: last.close - 0.2, close, volume: 1000 };
    candles.push(last);
  }
  const bt = backtest(candles, CFG);
  assert.ok(bt.n >= 1);
  assert.ok(Math.abs(bt.totalR - bt.trades.reduce((s, t) => s + t.r, 0)) < 1e-9);
});
