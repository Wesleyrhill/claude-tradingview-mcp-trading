// Pure strategy logic — no network, no disk. Everything here is unit-tested in test.js.
//
// Strategy: pullback to the 20 EMA inside a confirmed uptrend (long only, no leverage).
// A candle is { t, open, high, low, close, volume } with t in unix seconds (candle open time).

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder RSI, returned as a series aligned with `closes`.
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// Wilder ATR, returned as a series aligned with `candles`.
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = (i) =>
    Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr(i);
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr(i)) / period;
    out[i] = prev;
  }
  return out;
}

export function indicators(candles) {
  const closes = candles.map((c) => c.close);
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    rsi14: rsi(closes, 14),
    atr14: atr(candles, 14),
  };
}

export const MIN_BARS = 60;

// Evaluate the entry setup on the candle at index `i` (default: the last one).
// Returns { ok, checks: [{name, pass, detail}], plan? }.
export function evaluateEntry(candles, ind, cfg, i = candles.length - 1) {
  if (i < MIN_BARS - 1) {
    return { ok: false, checks: [{ name: "Enough history", pass: false, detail: `${i + 1} bars` }] };
  }
  const c = candles[i];
  const e20 = ind.ema20[i];
  const e50 = ind.ema50[i];
  const r = ind.rsi14[i];
  const a = ind.atr14[i];

  let volSum = 0;
  for (let j = i - 20; j < i; j++) volSum += candles[j].volume;
  const volAvg = volSum / 20;
  const volRatio = volAvg > 0 ? c.volume / volAvg : null;
  const extPct = ((c.close - e50) / e50) * 100;
  const pct = (n) => `${n.toFixed(2)}%`;

  const checks = [
    { name: "Price above the 50 EMA", pass: c.close > e50, detail: pct(extPct) + " vs 50 EMA" },
    { name: "20 EMA above the 50 EMA", pass: e20 > e50, detail: pct(((e20 - e50) / e50) * 100) },
    {
      name: `Pulled back to the 20 EMA (low within ${cfg.pullbackPct}%)`,
      pass: c.low <= e20 * (1 + cfg.pullbackPct / 100) && c.close >= e20,
      detail: `low ${pct(((c.low - e20) / e20) * 100)} from 20 EMA`,
    },
    { name: "Candle closed bullish", pass: c.close > c.open, detail: "" },
    {
      name: `Volume at least ${cfg.volMult}x average`,
      // Some feeds report no volume (indices); don't block on missing data.
      pass: volRatio === null || volRatio >= cfg.volMult,
      detail: volRatio === null ? "no volume data" : `${volRatio.toFixed(2)}x`,
    },
    { name: `Not extended (under ${cfg.maxExtPct}% above 50 EMA)`, pass: extPct <= cfg.maxExtPct, detail: pct(extPct) },
    { name: `RSI under ${cfg.rsiMax}`, pass: r < cfg.rsiMax, detail: r.toFixed(1) },
  ];
  const ok = checks.every((k) => k.pass);
  if (!ok) return { ok, checks };

  // Stop: 1 ATR below the pullback's swing low, clamped to a sane band.
  let swing = Infinity;
  for (let j = i - 4; j <= i; j++) swing = Math.min(swing, candles[j].low);
  const entry = c.close;
  let stopPct = ((entry - (swing - cfg.atrMult * a)) / entry) * 100;
  stopPct = Math.min(Math.max(stopPct, cfg.minStopPct), cfg.maxStopPct);
  const stop = entry * (1 - stopPct / 100);
  const risk = entry - stop;

  return {
    ok,
    checks,
    plan: {
      signalTime: c.t,
      entry,
      stop,
      stopPct,
      target1: entry + 2 * risk,
      target2: entry + 3 * risk,
      chaseLimit: entry + 0.3 * risk,
      atr: a,
    },
  };
}

// Position size from fixed fractional risk. Returns { sizeUsd, qty, riskUsd, capped }.
export function sizePosition(plan, account) {
  const riskUsd = (account.sizeUsd * account.riskPct) / 100;
  const uncapped = riskUsd / (plan.stopPct / 100);
  const cap = (account.sizeUsd * account.maxPositionPct) / 100;
  const sizeUsd = Math.min(uncapped, cap);
  return {
    sizeUsd,
    qty: sizeUsd / plan.entry,
    riskUsd: sizeUsd * (plan.stopPct / 100),
    capped: uncapped > cap,
  };
}

export function openPosition(plan, size) {
  return {
    entryTime: plan.signalTime,
    lastChecked: plan.signalTime,
    entry: plan.entry,
    initialStop: plan.stop,
    stop: plan.stop,
    target1: plan.target1,
    target2: plan.target2,
    atr: plan.atr,
    qty: size.qty,
    sizeUsd: size.sizeUsd,
    tookHalf: false,
    barsHeld: 0,
    maxHigh: plan.entry,
    realizedR: 0,
  };
}

// Walk the candles that closed after position.lastChecked and report what should be done.
// Within one candle the stop is checked first (the pessimistic assumption).
// Returns { events: [{type, price, t, note}], position, closed }.
export function evaluateExit(position, candles, ind, cfg) {
  const p = { ...position };
  const events = [];
  const R = p.entry - p.initialStop;
  const close = (type, price, t, note) => {
    const frac = p.tookHalf ? 0.5 : 1;
    p.realizedR += (frac * (price - p.entry)) / R;
    events.push({ type, price, t, note });
    return { events, position: p, closed: true };
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.t <= p.lastChecked) continue;
    p.lastChecked = c.t;
    p.barsHeld += 1;
    p.maxHigh = Math.max(p.maxHigh, c.high);

    if (c.low <= p.stop) {
      const price = Math.min(c.open, p.stop); // a gap down fills at the open, not the stop
      return close(p.tookHalf ? "STOP_BREAKEVEN" : "STOP", price, c.t, "Stop was hit.");
    }
    if (!p.tookHalf && c.high >= p.target1) {
      p.tookHalf = true;
      p.realizedR += (0.5 * (p.target1 - p.entry)) / R;
      p.stop = p.entry;
      events.push({ type: "HALF", price: p.target1, t: c.t, note: "First target (2R) reached." });
    }
    if (p.tookHalf && c.high >= p.target2) {
      return close("TARGET", p.target2, c.t, "Final target (3R) reached.");
    }
    if (ind.rsi14[i] !== null && ind.rsi14[i] > cfg.rsiExit) {
      return close("EXIT", c.close, c.t, `RSI ${ind.rsi14[i].toFixed(0)} — overbought, take the profit.`);
    }
    if (p.tookHalf && ind.ema20[i] !== null && c.close < ind.ema20[i]) {
      return close("EXIT", c.close, c.t, "Closed back below the 20 EMA — trend exit for the runner.");
    }
    if (!p.tookHalf && p.barsHeld >= cfg.timeStopBars && p.maxHigh < p.entry + 0.8 * p.atr) {
      return close("EXIT", c.close, c.t, `No progress after ${cfg.timeStopBars} bars — time stop.`);
    }
  }
  return { events, position: p, closed: false };
}

// Replay the rules over history. Used by `backtest` so the numbers come from the same code as live.
export function backtest(candles, cfg) {
  const ind = indicators(candles);
  const trades = [];
  let pos = null;
  for (let i = MIN_BARS - 1; i < candles.length; i++) {
    if (pos) {
      const res = evaluateExit(pos, candles.slice(0, i + 1), ind, cfg);
      pos = res.position;
      if (res.closed) {
        trades.push({ entryTime: pos.entryTime, exitTime: candles[i].t, r: pos.realizedR });
        pos = null;
      }
      continue;
    }
    const e = evaluateEntry(candles, ind, cfg, i);
    if (e.ok) pos = openPosition(e.plan, { qty: 1, sizeUsd: e.plan.entry });
  }
  const wins = trades.filter((t) => t.r > 0).length;
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const t of trades) {
    eq += t.r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return { trades, n: trades.length, wins, totalR, maxDrawdownR: maxDd, stillOpen: Boolean(pos) };
}
