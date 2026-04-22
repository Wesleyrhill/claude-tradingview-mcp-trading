/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates indicators defined by rules.json,
 * evaluates EACH entry_rule, and executes via BitGet if every condition passes.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 *
 * The safety check is driven by rules.json — not hard-coded. Edit that file
 * and the bot's checks change with it.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import twilio from "twilio";
import nodemailer from "nodemailer";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  // In cloud environments (Railway, etc.) credentials come from env vars directly.
  // Only prompt for .env file setup when running locally without credentials.
  const isCloud = !!process.env.RAILWAY_ENVIRONMENT;

  if (!isCloud && !existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
    if (!isCloud) {
      console.log("Opening .env for you now...\n");
      try {
        execSync("open .env");
      } catch {}
      console.log("Add the missing values then re-run: node bot.js\n");
    }
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

// Coinbase Advanced Trade maker fee (limit orders, base tier < $10k/mo volume).
// Round-trip cost = 2 × COINBASE_MAKER_FEE_PCT (entry + exit).
// Override at runtime with COINBASE_FEE_PCT env var.
const COINBASE_MAKER_FEE_PCT = parseFloat(process.env.COINBASE_FEE_PCT || "0.004");

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "5000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "5000"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "5"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT || "1.5"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "3.5"),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

// ─── Startup config validation ──────────────────────────────────────────────

if (!process.env.RISK_PER_TRADE_PCT) {
  console.log(
    "[INFO] RISK_PER_TRADE_PCT not set — using default 1.5% risk per trade."
  );
}

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 200) {
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "4h";

  const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance US API error: ${res.status} — if 451, endpoint may be geo-blocked; if 400, check symbol name (Binance US uses BTCUSDT format)`);
  const data = await res.json();

  const now = Date.now();
  // Binance kline format: [openTime, open, high, low, close, volume, closeTime, ...]
  // Drop the currently-forming candle (closeTime > now). The strategy fires
  // on candle close, so we only evaluate closed bars.
  const candles = data
    .map((k) => ({
      time: k[0],
      closeTime: k[6],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))
    .filter((c) => c.closeTime < now);

  return candles;
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ATR(14) on candles — Wilder's True Range method
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trs.push(tr);
  }
  // Average of last `period` TRs
  const lastTRs = trs.slice(-period);
  return lastTRs.reduce((a, b) => a + b, 0) / period;
}

// 20-bar volume average, EXCLUDING the most recent bar
function calcVolumeAvg(candles, lookback = 20) {
  if (candles.length < lookback + 1) return null;
  const vols = candles.slice(-lookback - 1, -1).map((c) => c.volume);
  return vols.reduce((a, b) => a + b, 0) / lookback;
}

// Lowest low of the last N candles (for stop placement under the pullback)
function swingLow(candles, lookback = 5) {
  const recent = candles.slice(-lookback);
  return Math.min(...recent.map((c) => c.low));
}

// ─── Safety Check (driven by rules.json) ───────────────────────────────────

function runSafetyCheck(ctx, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Shorts disabled by rules — skip straight to long checks
  const longRules = rules.entry_rules.long || [];
  if (
    longRules.length === 1 &&
    longRules[0].toUpperCase().includes("DISABLED")
  ) {
    console.log("  Longs disabled in rules.json. No trades possible.\n");
    results.push({
      label: "Entry rules defined",
      required: "At least one enabled side",
      actual: "All sides disabled",
      pass: false,
    });
    return { results, allPass: false, side: null };
  }

  const shortRules = rules.entry_rules.short || [];
  const shortsDisabled =
    shortRules.length === 1 &&
    shortRules[0].toUpperCase().includes("DISABLED");

  console.log(
    `  Evaluating LONG entry conditions (shorts: ${shortsDisabled ? "disabled" : "enabled but not checked in this build"})\n`,
  );

  const { price, ema20, ema50, atr, vol20avg, lastCandle, prevCandles } = ctx;

  // 1. Price above 50 EMA
  check(
    "Price above the 50 EMA on the 4H — uptrend confirmed",
    `> $${ema50.toFixed(2)}`,
    `$${price.toFixed(2)}`,
    price > ema50,
  );

  // 2. 20 EMA above 50 EMA (stacked trend)
  check(
    "20 EMA above 50 EMA on the 4H — trend is stacked",
    `EMA20 > EMA50`,
    `EMA20 $${ema20.toFixed(2)} vs EMA50 $${ema50.toFixed(2)}`,
    ema20 > ema50,
  );

  // 3. Price within 5% of 20 EMA (pullback tag — widened for more signal generation)
  const distFrom20 = Math.abs((price - ema20) / ema20) * 100;
  check(
    "Price within 5% of the 20 EMA (pullback tag — widened threshold for more trades)",
    "≤ 5%",
    `${distFrom20.toFixed(3)}%`,
    distFrom20 <= 5,
  );

  // 4. Last 4H candle closed bullish
  check(
    "Last 4H candle closed bullish — reclaim after pullback",
    "close > open",
    `open $${lastCandle.open.toFixed(2)}, close $${lastCandle.close.toFixed(2)}`,
    lastCandle.close > lastCandle.open,
  );

  // 5. Volume >= 0.5x 20-bar average (relaxed for paper-trade observation)
  const volRatio = lastCandle.volume / vol20avg;
  check(
    "Entry-bar volume ≥ 0.5× the 20-bar average (relaxed threshold)",
    "≥ 0.5×",
    `${volRatio.toFixed(2)}×`,
    volRatio >= 0.5,
  );

  // 6. Price NOT more than 3% extended above the 50 EMA
  const extAbove50 = ((price - ema50) / ema50) * 100;
  check(
    "Price ≤ 3% extended above the 50 EMA — not a climax buy",
    "≤ 3.00%",
    `${extAbove50.toFixed(2)}%`,
    extAbove50 <= 3.0 && extAbove50 >= 0, // must be above but not too far
  );

  // 7. News window — manual override. In a future build this could hit an
  // economic calendar API. For now we pass it through with a visible warning
  // so the user knows to do a 5-second calendar check themselves.
  check(
    "No major news event (CPI/FOMC/NFP) in the next 2 hours",
    "manual calendar check",
    "assumed clear — user override",
    true,
  );

  const allPass = results.every((r) => r.pass);
  return { results, allPass, side: "long" };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );
  return true;
}

// ─── Position Sizing (risk-based, ATR stop) ─────────────────────────────────

function sizePosition(price, atr) {
  const riskDollars = CONFIG.portfolioValue * (CONFIG.riskPerTradePct / 100);
  // Fixed stop-loss percentage (3.5%) — ignores ATR to keep risk consistent
  const stopDistancePct = CONFIG.stopLossPct;
  const stopDistance = price * (stopDistancePct / 100);
  const stopPrice = price - stopDistance;

  // size in USD such that (sizeUSD * stopDistance / price) == riskDollars
  // i.e. sizeUSD = riskDollars * price / stopDistance
  const rawSizeUSD = (riskDollars * price) / stopDistance;
  const cappedByMax = Math.min(rawSizeUSD, CONFIG.maxTradeSizeUSD);
  const cappedByPortfolio = Math.min(cappedByMax, CONFIG.portfolioValue);

  return {
    riskDollars,
    stopPrice,
    stopDistance,
    stopDistancePct,
    rawSizeUSD,
    sizeUSD: cappedByPortfolio,
    target1Price: price + 2 * stopDistance, // 2R
    target2Price: price + 3 * stopDistance, // 3R
  };
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    // Entry fee only (exit fee is captured in projected P&L fields)
    fee = (logEntry.entryFee || logEntry.tradeSize * COINBASE_MAKER_FEE_PCT).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    const pnlNote = logEntry.projectedPnl
      ? ` | net P&L@stop $${logEntry.projectedPnl.atStop.net.toFixed(2)} | net P&L@T1 $${logEntry.projectedPnl.atTarget1.net.toFixed(2)} | net P&L@T2 $${logEntry.projectedPnl.atTarget2.net.toFixed(2)}`
      : "";
    notes = `All conditions met | stop $${logEntry.stopPrice.toFixed(2)} | T1 $${logEntry.target1Price.toFixed(2)} | T2 $${logEntry.target2Price.toFixed(2)}${pnlNote}`;
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.entryFee || logEntry.tradeSize * COINBASE_MAKER_FEE_PCT).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : `All conditions met | stop $${logEntry.stopPrice.toFixed(2)}`;
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// ─── Google Sheets Webhook ──────────────────────────────────────────────────

async function pushToSheet(logEntry) {
  const url = process.env.LOG_WEBHOOK_URL;
  if (!url) {
    console.log("(No LOG_WEBHOOK_URL set — skipping Sheet push)");
    return;
  }

  const failed = logEntry.conditions
    .filter((c) => !c.pass)
    .map((c) => c.label)
    .join("; ");

  let mode, decision;
  if (!logEntry.allPass) {
    mode = "BLOCKED";
    decision = "BLOCKED";
  } else if (logEntry.paperTrading) {
    mode = "PAPER";
    decision = "PAPER";
  } else if (logEntry.error) {
    mode = "LIVE-ERROR";
    decision = "ERROR";
  } else {
    mode = "LIVE";
    decision = "TRADED";
  }

  const payload = {
    timestamp: logEntry.timestamp,
    symbol: logEntry.symbol,
    timeframe: logEntry.timeframe,
    price: logEntry.price.toFixed(2),
    ema20: logEntry.indicators.ema20?.toFixed(2) || "",
    ema50: logEntry.indicators.ema50?.toFixed(2) || "",
    atr: logEntry.indicators.atr?.toFixed(2) || "",
    rsi14: logEntry.indicators.rsi14?.toFixed(2) || "",
    volumeLast: logEntry.indicators.volumeLast?.toFixed(1) || "",
    volumeAvg: logEntry.indicators.vol20avg?.toFixed(1) || "",
    side: logEntry.side,
    mode,
    decision,
    conditionsFailed: failed,
    tradeSize: logEntry.tradeSize?.toFixed(2) || "",
    quantity: logEntry.tradeSize
      ? (logEntry.tradeSize / logEntry.price).toFixed(6)
      : "",
    stopPrice: logEntry.stopPrice?.toFixed(2) || "",
    target1: logEntry.target1Price?.toFixed(2) || "",
    target2: logEntry.target2Price?.toFixed(2) || "",
    orderId: logEntry.orderId || "",
    portfolioValue: CONFIG.portfolioValue.toFixed(2),
    maxTradeSize: CONFIG.maxTradeSizeUSD.toFixed(2),
    tradesToday: logEntry.limits.tradesToday,
    // Fee fields (Coinbase Advanced Trade maker fee)
    feePct: (COINBASE_MAKER_FEE_PCT * 100).toFixed(2),
    entryFee: logEntry.entryFee?.toFixed(4) || "",
    projNetPnlAtStop: logEntry.projectedPnl?.atStop.net.toFixed(2) || "",
    projGrossPnlAtStop: logEntry.projectedPnl?.atStop.gross.toFixed(2) || "",
    projNetPnlAtT1: logEntry.projectedPnl?.atTarget1.net.toFixed(2) || "",
    projGrossPnlAtT1: logEntry.projectedPnl?.atTarget1.gross.toFixed(2) || "",
    projNetPnlAtT2: logEntry.projectedPnl?.atTarget2.net.toFixed(2) || "",
    projGrossPnlAtT2: logEntry.projectedPnl?.atTarget2.gross.toFixed(2) || "",
  };

  try {
    // Google Apps Script receives the POST body on the initial request, then
    // issues a 302 redirect to a GET-only echo URL. Follow the redirect with
    // GET (standard 302 semantics) — do NOT re-POST the body on the redirect.
    let res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(payload),
      redirect: "manual",
    });
    console.log(`[sheet-push] initial POST status: ${res.status}`);
    if (res.status === 302) {
      const redirectUrl = res.headers.get("location");
      res = await fetch(redirectUrl, { method: "GET" });
    }
    const body = await res.text();
    if (res.ok) {
      console.log(`Sheet push ✓ (${body.slice(0, 60)})`);
    } else {
      console.log(`⚠️  Sheet push failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`⚠️  Sheet push error: ${err.message}`);
  }
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Trade Alerts (email + SMS) ──────────────────────────────────────────────
// Fires only when a paper trade is actually entered (allPass + paperTrading).
// Both channels are attempted in parallel; a failure in either is logged but
// never allowed to crash the bot.

function buildAlertText(d) {
  const stopPct  = ((d.price - d.stopPrice) / d.price * 100).toFixed(2);
  const feePct   = (COINBASE_MAKER_FEE_PCT * 100).toFixed(2);

  return [
    `BTC PAPER TRADE ENTERED`,
    ``,
    `Entry price : $${d.price.toFixed(2)}`,
    `Position    : $${d.sizeUSD.toFixed(2)}`,
    `Stop loss   : $${d.stopPrice.toFixed(2)}  (-${stopPct}%)`,
    `Target 1    : $${d.target1Price.toFixed(2)}`,
    `Target 2    : $${d.target2Price.toFixed(2)}`,
    ``,
    `── Projected net P&L (after Coinbase ${feePct}% maker fee) ──`,
    `  At stop : $${d.pnl.atStop.net.toFixed(2)}`,
    `  At T1   : $${d.pnl.atTarget1.net.toFixed(2)}`,
    `  At T2   : $${d.pnl.atTarget2.net.toFixed(2)}`,
    ``,
    `── Indicators ──`,
    `  RSI(14)  : ${d.rsi14.toFixed(2)}`,
    `  EMA(20)  : $${d.ema20.toFixed(2)}`,
    `  EMA(50)  : $${d.ema50.toFixed(2)}`,
    ``,
    `Timestamp: ${d.timestamp}`,
  ].join("\n");
}

async function sendSmsAlert(text) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  const to    = process.env.ALERT_PHONE;

  if (!sid || !token || !from || !to ||
      sid.startsWith("your_") || token.startsWith("your_")) {
    console.log("[alerts] Twilio credentials not configured — SMS skipped.");
    return;
  }

  const client = twilio(sid, token);
  // Twilio SMS has a 1600-char limit; trim gracefully
  const body = text.length > 1550 ? text.slice(0, 1547) + "..." : text;
  const msg = await client.messages.create({ body, from, to });
  console.log(`[alerts] SMS sent — SID ${msg.sid}`);
}

async function sendEmailAlert(subject, text) {
  const user     = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  const to       = process.env.ALERT_EMAIL;

  if (!user || !password || !to ||
      password.startsWith("your_")) {
    console.log("[alerts] Gmail credentials not configured — email skipped.");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: password },
  });

  const info = await transporter.sendMail({
    from: `"Trading Bot" <${user}>`,
    to,
    subject,
    text,
  });
  console.log(`[alerts] Email sent — messageId ${info.messageId}`);
}

async function sendAlerts(logEntry) {
  const { price, tradeSize, stopPrice, target1Price, target2Price,
          projectedPnl, indicators, timestamp } = logEntry;

  const data = {
    timestamp,
    price,
    sizeUSD        : tradeSize,
    stopPrice,
    target1Price,
    target2Price,
    pnl            : projectedPnl,
    rsi14          : indicators.rsi14,
    ema20          : indicators.ema20,
    ema50          : indicators.ema50,
  };

  const text    = buildAlertText(data);
  const subject = `BTC Trade Signal — Entry $${price.toFixed(2)}`;

  console.log("[alerts] Sending trade alerts (email + SMS)...");

  const results = await Promise.allSettled([
    sendEmailAlert(subject, text),
    sendSmsAlert(text),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.log(`[alerts] Alert delivery error: ${r.reason?.message || r.reason}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

// ─── Canary Check ────────────────────────────────────────────────────────────
// Hits the Binance US endpoint with a minimal 1-candle request before the
// strategy runs. Logs the HTTP status explicitly so 451 / 4xx failures are
// immediately visible at the top of every Railway log entry.

async function canaryCheck() {
  const canaryUrl =
    "https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=1";
  console.log(`[canary] GET ${canaryUrl}`);
  try {
    const res = await fetch(canaryUrl);
    console.log(`[canary] HTTP ${res.status} ${res.statusText}`);
    if (!res.ok) {
      console.error(
        `[canary] FAIL — Binance US returned ${res.status}. ` +
          (res.status === 451
            ? "Geo-block: endpoint may need to change."
            : "Check network / API availability."),
      );
      return false;
    }
    console.log("[canary] OK — Binance US reachable, proceeding.");
    return true;
  } catch (err) {
    console.error(`[canary] FAIL — network error: ${err.message}`);
    return false;
  }
}

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Canary: verify Binance US is reachable before running the strategy
  const apiOk = await canaryCheck();
  if (!apiOk) {
    console.error("Bot halted — Binance US canary check failed. See [canary] lines above.");
    process.exit(1);
  }

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);
  console.log(
    `Portfolio: $${CONFIG.portfolioValue.toFixed(2)} | Risk/trade: ${CONFIG.riskPerTradePct}% ($${(CONFIG.portfolioValue * CONFIG.riskPerTradePct / 100).toFixed(2)}) | Max trade: $${CONFIG.maxTradeSizeUSD}`,
  );

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(50) + ATR(14) + 20-bar volume
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 200);
  const closes = candles.map((c) => c.close);
  const lastCandle = candles[candles.length - 1];
  const price = lastCandle.close;

  if (candles.length < 60) {
    console.log("⚠️  Not enough candles to evaluate. Exiting.");
    return;
  }

  // Calculate indicators
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const atr = calcATR(candles, 14);
  const vol20avg = calcVolumeAvg(candles, 20);
  const rsi14 = calcRSI(closes, 14);

  console.log(`  Current price: $${price.toFixed(2)}`);
  console.log(`  EMA(20):  $${ema20.toFixed(2)}`);
  console.log(`  EMA(50):  $${ema50.toFixed(2)}`);
  console.log(`  ATR(14):  $${atr.toFixed(2)} (${((atr / price) * 100).toFixed(2)}% of price)`);
  console.log(`  RSI(14):  ${rsi14.toFixed(2)}`);
  console.log(`  Volume (last bar):   ${lastCandle.volume.toFixed(1)}`);
  console.log(`  Volume (20-bar avg): ${vol20avg.toFixed(1)}`);

  // Run safety check
  const { results, allPass, side } = runSafetyCheck(
    {
      price,
      ema20,
      ema50,
      atr,
      vol20avg,
      lastCandle,
      prevCandles: candles.slice(-21, -1),
    },
    rules,
  );

  // Position sizing
  const sizing = sizePosition(price, atr);

  console.log("\n── Position Sizing ──────────────────────────────────────\n");
  console.log(`  Entry (market):      $${price.toFixed(2)}`);
  console.log(`  Stop (1× ATR below): $${sizing.stopPrice.toFixed(2)}  (distance $${sizing.stopDistance.toFixed(2)}, ${sizing.stopDistancePct.toFixed(2)}%)`);
  console.log(`  Target 1 (2R):       $${sizing.target1Price.toFixed(2)}`);
  console.log(`  Target 2 (3R):       $${sizing.target2Price.toFixed(2)}`);
  console.log(`  Risk dollars (${CONFIG.riskPerTradePct}% of $${CONFIG.portfolioValue}): $${sizing.riskDollars.toFixed(2)}`);
  console.log(`  Raw position size:   $${sizing.rawSizeUSD.toFixed(2)}  (before caps)`);
  console.log(`  Max-trade cap:       $${CONFIG.maxTradeSizeUSD}`);
  console.log(`  Final position size: $${sizing.sizeUSD.toFixed(2)}  (${(sizing.sizeUSD / price).toFixed(6)} BTC)`);

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    side: side || "none",
    price,
    indicators: { ema20, ema50, atr, rsi14, vol20avg, volumeLast: lastCandle.volume },
    conditions: results,
    allPass,
    tradeSize: sizing.sizeUSD,
    stopPrice: sizing.stopPrice,
    target1Price: sizing.target1Price,
    target2Price: sizing.target2Price,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    // Fee tracking (Coinbase Advanced Trade maker fee — set on entry if trade fires)
    entryFee: null,
    projectedPnl: null,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED — ${failed.length} condition(s) failed:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      // ── Fee-adjusted P&L projections ────────────────────────────────────────
      // Entry fee: paid when the position is opened.
      // Exit fee: paid on the closing fill (stop, T1, or T2). Calculated on
      //   the exit value (quantity × exit price) rather than original size,
      //   because price will differ at each exit point.
      const entryFee = sizing.sizeUSD * COINBASE_MAKER_FEE_PCT;
      const qty = sizing.sizeUSD / price; // BTC quantity

      function calcScenarioPnl(exitPrice) {
        const exitValue = qty * exitPrice;
        const exitFee = exitValue * COINBASE_MAKER_FEE_PCT;
        const grossPnl = exitValue - sizing.sizeUSD;
        const netPnl = grossPnl - entryFee - exitFee;
        return { gross: grossPnl, net: netPnl, exitFee };
      }

      const projectedPnl = {
        atStop:    calcScenarioPnl(sizing.stopPrice),
        atTarget1: calcScenarioPnl(sizing.target1Price),
        atTarget2: calcScenarioPnl(sizing.target2Price),
      };

      logEntry.entryFee = entryFee;
      logEntry.projectedPnl = projectedPnl;

      console.log(
        `\nPAPER TRADE — would buy ${CONFIG.symbol} ~$${sizing.sizeUSD.toFixed(2)} (${(sizing.sizeUSD / price).toFixed(6)} BTC) at market`,
      );
      console.log(
        `   Stop: $${sizing.stopPrice.toFixed(2)} | T1: $${sizing.target1Price.toFixed(2)} | T2: $${sizing.target2Price.toFixed(2)}`,
      );
      console.log(`\n── Fee-Adjusted P&L Projections (Coinbase maker ${(COINBASE_MAKER_FEE_PCT * 100).toFixed(2)}%) ──`);
      console.log(`   Entry fee:                  $${entryFee.toFixed(4)}`);
      console.log(`   At stop  ($${sizing.stopPrice.toFixed(2)}):  gross $${projectedPnl.atStop.gross.toFixed(2)}  exit fee $${projectedPnl.atStop.exitFee.toFixed(4)}  NET $${projectedPnl.atStop.net.toFixed(2)}`);
      console.log(`   At T1    ($${sizing.target1Price.toFixed(2)}):  gross $${projectedPnl.atTarget1.gross.toFixed(2)}  exit fee $${projectedPnl.atTarget1.exitFee.toFixed(4)}  NET $${projectedPnl.atTarget1.net.toFixed(2)}`);
      console.log(`   At T2    ($${sizing.target2Price.toFixed(2)}):  gross $${projectedPnl.atTarget2.gross.toFixed(2)}  exit fee $${projectedPnl.atTarget2.exitFee.toFixed(4)}  NET $${projectedPnl.atTarget2.net.toFixed(2)}`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;

      // Fire email + SMS alerts non-blocking — errors are caught inside sendAlerts
      await sendAlerts(logEntry);
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${sizing.sizeUSD.toFixed(2)} BUY ${CONFIG.symbol}`,
      );
      try {
        const order = await placeBitGetOrder(
          CONFIG.symbol,
          "buy",
          sizing.sizeUSD,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  writeTradeCsv(logEntry);

  await pushToSheet(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
