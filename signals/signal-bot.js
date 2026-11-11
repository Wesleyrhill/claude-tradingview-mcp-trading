#!/usr/bin/env node
// Signal bot — watches stocks and crypto, pings you when there is a trade to place by hand.
// It never touches an exchange: no API keys, no orders. You execute at whatever broker you use.
//
//   node signals/signal-bot.js              run once (this is what cron calls)
//   node signals/signal-bot.js --dry-run    evaluate and print, send nothing, save nothing
//   node signals/signal-bot.js status       open positions + closed-trade tally
//   node signals/signal-bot.js skip BTC     you did NOT take that signal — stop tracking it
//   node signals/signal-bot.js close BTC 71234.5   you sold early at that price
//   node signals/signal-bot.js test-ping    send a test notification
//   node signals/signal-bot.js backtest     replay the rules over the available history

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indicators, evaluateEntry, evaluateExit, sizePosition, openPosition, backtest, feedProblem } from "./lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

for (const f of [path.join(HERE, ".env"), path.join(ROOT, ".env")]) {
  if (fs.existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch (e) {
      console.error(`Could not read ${f}: ${e.message}`);
    }
  }
}

const STATE_FILE = path.join(process.env.DATA_DIR || HERE, "signal-state.json");
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, "watchlist.json"), "utf8"));
if (process.env.ACCOUNT_SIZE_USD) CONFIG.account.sizeUsd = Number(process.env.ACCOUNT_SIZE_USD);

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const cmd = args.find((a) => !a.startsWith("--")) || "run";

// ─── State ───────────────────────────────────────────────────────────────────

function loadState() {
  const blank = { positions: {}, history: [], lastSignal: {}, lastSeen: {}, entriesByDay: {}, lastDigest: "", lastErrorPing: "" };
  if (!fs.existsSync(STATE_FILE)) return blank;
  return { ...blank, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
}

function saveState(state) {
  if (DRY) return;
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ─── Market data (public endpoints, no keys) ─────────────────────────────────

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (signal-bot)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

const KRAKEN_MINUTES = { "1h": 60, "4h": 240, "1d": 1440 };
// Oldest the newest closed candle may be (measured from its open). Intraday: two intervals plus
// slack. Daily: five days, which covers a long weekend.
const MAX_AGE_SEC = { "1h": 2.5 * 3600, "4h": 8.5 * 3600, "1d": 5 * 86400 };

async function fetchKraken(feed, timeframe) {
  const mins = KRAKEN_MINUTES[timeframe];
  if (!mins) throw new Error(`Unsupported crypto timeframe ${timeframe}`);
  const data = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${feed}&interval=${mins}`);
  if (data.error?.length) throw new Error(`Kraken: ${data.error.join(", ")}`);
  const key = Object.keys(data.result).find((k) => k !== "last");
  const now = Date.now() / 1000;
  return data.result[key]
    .map((r) => ({ t: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6] }))
    .filter((c) => c.t + mins * 60 <= now); // drop the candle that is still forming
}

async function fetchYahoo(feed, timeframe) {
  if (timeframe !== "1d") throw new Error(`Unsupported stock timeframe ${timeframe}`);
  const data = await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(feed)}?interval=1d&range=2y`,
  );
  const r = data.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo: ${data.chart?.error?.description || "no data"} (${feed})`);
  const q = r.indicators.quote[0];
  const session = r.meta.currentTradingPeriod?.regular;
  const now = Date.now() / 1000;
  const out = [];
  let droppedForming = false;
  for (let i = 0; i < r.timestamp.length; i++) {
    const t = r.timestamp[i];
    // Today's bar is still forming until the regular session ends.
    if (session && t >= session.start && now < session.end) {
      droppedForming = true;
      continue;
    }
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some((v) => v == null)) continue;
    out.push({ t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  }
  // Yahoo sometimes serves a response without the most recent finished session. Outside market
  // hours the newest bar must be the session of the last regular trade, or the data is behind.
  const lastTrade = r.meta.regularMarketTime;
  if (!droppedForming && lastTrade && out.length && out[out.length - 1].t < lastTrade - 12 * 3600) {
    throw new Error(`Yahoo: latest daily bar for ${feed} is missing`);
  }
  return out;
}

function fetchCandles(asset, cls) {
  if (cls.source === "kraken") return fetchKraken(asset.feed, cls.timeframe);
  if (cls.source === "yahoo") return fetchYahoo(asset.feed, cls.timeframe);
  throw new Error(`Unknown source ${cls.source}`);
}

// ─── Notifications ───────────────────────────────────────────────────────────

async function ping({ title, body, priority = 3, tags = [], click }) {
  console.log(`\n── ${title}\n${body}`);
  if (DRY) return [];
  const sent = [];
  const errors = [];

  if (process.env.NTFY_TOPIC) {
    try {
      const res = await fetch(process.env.NTFY_SERVER || "https://ntfy.sh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title, message: body, priority, tags, click }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
      sent.push("ntfy");
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `${title}\n\n${body}${click ? `\n\n${click}` : ""}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
      sent.push("telegram");
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) console.error(`Ping errors: ${errors.join("; ")}`);
  if (!sent.length) console.error("No ping delivered — set NTFY_TOPIC or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env");
  return sent;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const px = (n) => {
  const d = n >= 1000 ? 0 : n >= 10 ? 2 : 4;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
const qty = (n) => (n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toFixed(6));
const usd = (n) => `$${n.toFixed(2)}`;
const tvLink = (asset) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(asset.tv)}`;
const localDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: CONFIG.digest.timeZone });
const localHour = (d = new Date()) =>
  Number(d.toLocaleString("en-US", { timeZone: CONFIG.digest.timeZone, hour: "numeric", hour12: false })) % 24;

function buyPing(asset, cls, plan, size) {
  const when = cls.source === "yahoo" ? "at the next market open" : "now";
  return {
    title: `BUY ${asset.symbol} - ${usd(size.sizeUsd)}`,
    priority: 4,
    tags: ["green_circle"],
    click: tvLink(asset),
    body: [
      `Buy ${qty(size.qty)} ${asset.symbol} (${usd(size.sizeUsd)}) ${when}, near ${px(plan.entry)}.`,
      `Skip it if price is already above ${px(plan.chaseLimit)}.`,
      ``,
      `Stop-loss: ${px(plan.stop)} (-${plan.stopPct.toFixed(1)}%) - set it when you buy.`,
      `Target 1: ${px(plan.target1)} - sell half, move stop to entry.`,
      `Target 2: ${px(plan.target2)} - sell the rest.`,
      `Risk if stopped: ${usd(size.riskUsd)}${size.capped ? " (size capped by max position)" : ""}.`,
      ``,
      `Setup: pullback to the 20 EMA in an uptrend (${cls.timeframe}).`,
      `Didn't take it? Run: signal-bot.js skip ${asset.symbol}`,
    ].join("\n"),
  };
}

function exitPing(asset, pos, ev) {
  const head = {
    STOP: [`SELL ${asset.symbol} - stop hit`, `Sell all ${asset.symbol} - the stop at ${px(pos.initialStop)} was hit.`],
    STOP_BREAKEVEN: [`SELL ${asset.symbol} - breakeven stop`, `Sell the remaining ${asset.symbol} - price came back to your entry ${px(pos.entry)}.`],
    HALF: [`SELL HALF ${asset.symbol} - target 1`, `Sell half your ${asset.symbol} near ${px(ev.price)}, then move the stop up to your entry ${px(pos.entry)}.`],
    TARGET: [`SELL ${asset.symbol} - target 2`, `Sell the rest of your ${asset.symbol} near ${px(ev.price)}.`],
    EXIT: [`SELL ${asset.symbol} - exit`, `Sell your ${asset.symbol} near ${px(ev.price)}.`],
  }[ev.type];
  const lines = [head[1], ev.note];
  if (ev.type !== "HALF") lines.push(`Result for this trade: ${pos.realizedR >= 0 ? "+" : ""}${pos.realizedR.toFixed(2)}R.`);
  return {
    title: head[0],
    priority: ev.type === "HALF" ? 4 : 5,
    tags: [ev.type === "STOP" ? "red_circle" : "large_orange_diamond"],
    click: tvLink(asset),
    body: lines.join("\n"),
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function run() {
  const state = loadState();
  const today = localDay();
  const errors = [];
  const watching = [];

  for (const asset of CONFIG.assets) {
    const cls = CONFIG.classes[asset.class];
    let candles;
    try {
      candles = await fetchCandles(asset, cls);
      if (candles.length < 60) throw new Error(`only ${candles.length} candles for ${asset.symbol}`);
      const problem = feedProblem({
        lastT: candles[candles.length - 1].t,
        seenT: state.lastSeen[asset.symbol],
        now: Date.now() / 1000,
        maxAgeSec: MAX_AGE_SEC[cls.timeframe],
      });
      if (problem) throw new Error(problem);
      state.lastSeen[asset.symbol] = candles[candles.length - 1].t;
    } catch (e) {
      errors.push(`${asset.symbol}: ${e.message}`);
      continue;
    }
    const ind = indicators(candles);
    const last = candles[candles.length - 1];

    const pos = state.positions[asset.symbol];
    if (pos) {
      const res = evaluateExit(pos, candles, ind, cls);
      for (const ev of res.events) await ping(exitPing(asset, res.position, ev));
      if (res.closed) {
        state.history.push({ symbol: asset.symbol, entryTime: pos.entryTime, exitTime: last.t, entry: pos.entry, r: res.position.realizedR, sizeUsd: pos.sizeUsd });
        delete state.positions[asset.symbol];
      } else {
        state.positions[asset.symbol] = res.position;
      }
      saveState(state);
      watching.push(`${asset.symbol} ${px(last.close)} (holding)`);
      continue;
    }

    const e = evaluateEntry(candles, ind, cls);
    const failed = e.checks.filter((k) => !k.pass).length;
    watching.push(`${asset.symbol} ${px(last.close)} (${e.ok ? "SETUP" : `${e.checks.length - failed}/${e.checks.length}`})`);
    if (!e.ok || state.lastSignal[asset.symbol] === last.t) continue;

    // A signal is only actionable while its candle is the newest one; never ping stale setups.
    state.lastSignal[asset.symbol] = last.t;
    const open = Object.keys(state.positions).length;
    const entriesToday = state.entriesByDay[today] || 0;
    if (open >= CONFIG.account.maxOpenPositions || entriesToday >= CONFIG.account.maxNewEntriesPerDay) {
      console.log(`${asset.symbol}: setup valid but skipped (${open} open, ${entriesToday} entries today).`);
      saveState(state);
      continue;
    }
    const size = sizePosition(e.plan, CONFIG.account);
    await ping(buyPing(asset, cls, e.plan, size));
    state.positions[asset.symbol] = openPosition(e.plan, size);
    state.entriesByDay = { [today]: entriesToday + 1 };
    saveState(state);
  }

  // Tell the user when the bot is blind, at most once a day.
  if (errors.length) {
    console.error(`Data errors:\n  ${errors.join("\n  ")}`);
    if (errors.length === CONFIG.assets.length && state.lastErrorPing !== today) {
      await ping({ title: "Signal bot: no market data", priority: 4, tags: ["warning"], body: `Every data fetch failed this run, so nothing is being watched.\n${errors.slice(0, 3).join("\n")}` });
      state.lastErrorPing = today;
    }
  }

  // Once-a-day heartbeat so silence means "no trades", not "bot is dead".
  if (CONFIG.digest.enabled && state.lastDigest !== today && localHour() >= CONFIG.digest.localHour) {
    const held = Object.entries(state.positions).map(([s, p]) => `${s}: stop ${px(p.stop)}, target ${px(p.tookHalf ? p.target2 : p.target1)}`);
    const totalR = state.history.reduce((s, h) => s + h.r, 0);
    await ping({
      title: "Signal bot: daily check-in",
      priority: 2,
      tags: ["satellite"],
      body: [
        held.length ? `Open positions:\n${held.join("\n")}` : "No open positions.",
        ``,
        `Watching (rules passed):\n${watching.join("\n")}`,
        ``,
        `Closed trades: ${state.history.length}, total ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R.`,
        errors.length ? `\n${errors.length} data error(s) this run.` : "",
      ].join("\n").trim(),
    });
    state.lastDigest = today;
  }
  saveState(state);
  console.log(`\n${new Date().toISOString()} run complete — ${watching.join(" · ")}`);
}

function status() {
  const state = loadState();
  const open = Object.entries(state.positions);
  console.log(open.length ? "Open positions:" : "No open positions.");
  for (const [s, p] of open) {
    console.log(`  ${s}: ${qty(p.qty)} @ ${px(p.entry)} · stop ${px(p.stop)} · T1 ${px(p.target1)} · T2 ${px(p.target2)}${p.tookHalf ? " · half sold" : ""}`);
  }
  const totalR = state.history.reduce((s, h) => s + h.r, 0);
  const wins = state.history.filter((h) => h.r > 0).length;
  console.log(`Closed trades: ${state.history.length} (${wins} winners), total ${totalR.toFixed(2)}R.`);
}

function manualClose(symbol, price, taken) {
  const state = loadState();
  const sym = (symbol || "").toUpperCase();
  const pos = state.positions[sym];
  if (!pos) return console.error(`No open position in "${sym}". Open: ${Object.keys(state.positions).join(", ") || "none"}`);
  if (taken) {
    if (!Number.isFinite(price)) return console.error("Usage: signal-bot.js close SYMBOL PRICE");
    const frac = pos.tookHalf ? 0.5 : 1;
    const r = pos.realizedR + (frac * (price - pos.entry)) / (pos.entry - pos.initialStop);
    state.history.push({ symbol: sym, entryTime: pos.entryTime, exitTime: Math.floor(Date.now() / 1000), entry: pos.entry, r, sizeUsd: pos.sizeUsd, manual: true });
    console.log(`Closed ${sym} at ${px(price)}: ${r.toFixed(2)}R.`);
  } else {
    console.log(`Dropped ${sym} — it won't be tracked or counted.`);
  }
  delete state.positions[sym];
  saveState(state);
}

async function runBacktest() {
  console.log("Replaying the live rules over available history (no fees or slippage modelled):\n");
  let allR = 0;
  let allN = 0;
  for (const asset of CONFIG.assets) {
    const cls = CONFIG.classes[asset.class];
    try {
      const candles = await fetchCandles(asset, cls);
      const bt = backtest(candles, cls);
      const days = Math.round((candles[candles.length - 1].t - candles[0].t) / 86400);
      allR += bt.totalR;
      allN += bt.n;
      console.log(`  ${asset.symbol.padEnd(5)} ${cls.timeframe.padEnd(3)} ${String(days).padStart(4)}d  trades ${String(bt.n).padStart(3)}  wins ${String(bt.wins).padStart(3)}  total ${bt.totalR.toFixed(2).padStart(7)}R  maxDD ${bt.maxDrawdownR.toFixed(2)}R`);
    } catch (e) {
      console.log(`  ${asset.symbol.padEnd(5)} failed: ${e.message}`);
    }
  }
  console.log(`\n  All: ${allN} trades, ${allR.toFixed(2)}R. 1R = ${CONFIG.account.riskPct}% of the account.`);
}

const commands = {
  run,
  status,
  backtest: runBacktest,
  skip: () => manualClose(args.filter((a) => !a.startsWith("--"))[1], NaN, false),
  close: () => {
    const [, sym, price] = args.filter((a) => !a.startsWith("--"));
    manualClose(sym, Number(price), true);
  },
  "test-ping": async () => {
    const sent = await ping({ title: "Signal bot: test ping", body: "If you can read this on your phone, pings work.", tags: ["white_check_mark"] });
    if (!DRY && !sent.length) process.exitCode = 1;
  },
};

if (!commands[cmd]) {
  console.error(`Unknown command "${cmd}". Try: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
try {
  await commands[cmd]();
} catch (e) {
  console.error(`Fatal: ${e.stack || e.message}`);
  process.exit(1);
}
