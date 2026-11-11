# Signal bot

Watches stocks and crypto and pings your phone when there is a trade to place.
It never connects to an exchange — no API keys, no orders. You place the trade
yourself at whatever broker you use, so it keeps working when a broker disappears.

It replaces the BitGet-executing `bot.js`. Same rulebook: buy the pullback to the
20 EMA inside an uptrend, long only, no leverage, fixed-fraction risk.

## What you get pinged

| Ping | Meaning |
| --- | --- |
| **BUY X** | A setup just closed. Gives size, entry, stop, both targets, and a "don't chase above" price. |
| **SELL HALF X** | Target 1 (2R) hit. Sell half, move the stop to your entry. |
| **SELL X** | Stop hit, target 2 (3R) hit, trend exit, RSI over 80, or time stop. |
| **Daily check-in** | Once a day: open positions and what is being watched. Silence then means "no trades", not "bot is dead". |

The bot assumes you took every BUY it sent, so it can send the matching SELLs.
If you didn't: `node signals/signal-bot.js skip BTC`. If you sold early:
`node signals/signal-bot.js close BTC 71234.5`.

## Setup

1. **Pick a ping channel** and add it to `.env` in the repo root:
   - **ntfy** (free, no account): install the ntfy app, subscribe to a long random
     topic name, and set `NTFY_TOPIC=that-name`. Anyone who knows the topic can read
     it, so make it unguessable.
   - **Telegram**: set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
2. `node signals/signal-bot.js test-ping` — your phone should buzz.
3. Set your real account size: `ACCOUNT_SIZE_USD=...` in `.env` (default 1000).
4. `./signals/install-cron.sh` — runs it every hour at :05 on this Mac.

The Mac has to be awake for a run to happen (launchd catches up once on wake).
To run it in the cloud instead, point the Railway cron service at
`node signals/signal-bot.js` with `cronSchedule: "5 * * * *"`, set the same env
vars, and set `DATA_DIR=/data` so positions survive between runs.

## Commands

```
node signals/signal-bot.js              # one run (what cron calls)
node signals/signal-bot.js --dry-run    # evaluate and print; sends and saves nothing
node signals/signal-bot.js status
node signals/signal-bot.js backtest     # replay the live rules over available history
node --test signals/test.js
```

## Changing what it watches

Edit `watchlist.json`. Crypto uses Kraken pairs (`feed`), stocks use Yahoo tickers.
`tv` is the TradingView symbol each ping links to. Crypto is judged on closed 4H
candles; stocks on closed daily candles, so stock BUYs arrive after the close and
are for the next open.

## TradingView

`tradingview/pullback-20ema.pine` draws the same setups on your chart: Pine Editor →
paste → Add to chart. It also exposes an alert condition if you want TradingView's
own alerts as a second source.

## Read this before using real money

`backtest` currently shows the rules **losing** over the available history
(crypto 4H, ~120 days: net negative on BTC and ETH; stocks, 2 years: mixed).
It models no fees or slippage, which would make it worse. Treat pings as paper
trades until the tally from `status` says otherwise. Nothing here is financial advice.
