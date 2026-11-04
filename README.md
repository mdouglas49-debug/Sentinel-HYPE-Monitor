# Sentinel HYPE — GitHub Actions read-only alerts

This runs the *same* `tgcloud/lib/screen.js` screening logic as the Telegram Serverless `/scan` bot, but **GitHub Actions runs the scheduled scanner directly** and sends qualifying alerts through Telegram Bot API. It does not invoke Telegram Serverless. The Serverless bot continues to handle `/scan` independently.

## Set up ($0 option)

1. Create a **new public GitHub repository** for this code. Do not include credentials, `.env`, `.tgcloud`, or the original project folder. Public standard GitHub-hosted Actions are generally free, subject to GitHub policies and limits. A private repo running every five minutes can exceed its included minutes.
2. Upload the contents of this ZIP to the repo, retaining `.github/workflows/hype-scan.yml`.
3. Go to Settings → Secrets and variables → Actions → New repository secret. Add `TELEGRAM_BOT_TOKEN` (token of the bot you want to send the alerts) and `TELEGRAM_CHAT_ID` (your personal chat ID). Never put secrets in files, workflow YAML, commits, or chat.
4. Open the bot in Telegram and press Start if needed. On GitHub, Actions → Sentinel HYPE read-only scan → Run workflow to test a scan. A test run will send **no message** unless a signal qualifies.
5. Keep the laptop monitor running until you have observed successful scheduled workflow runs and confirmed delivery of a qualifying signal. Then stop the laptop monitor to avoid duplicate alerts from separate systems.

## Behavior and limitations

- Cron runs at minute 2,7,12,... UTC, shortly after 5-minute candle boundaries. GitHub scheduling can be delayed or dropped and is not guaranteed every five minutes. The workflow skips market data older than 10 minutes.
- 240 candles, EMA9/EMA21, RSI14, confirmed pivots, and 1.5 reward/risk are reused unchanged from your deployed Serverless scanner.
- Only `SIGNAL_PREVIEW_ONLY` sends an alert; `NO_SIGNAL` does not.
- GitHub Actions cache keys provide **best-effort duplicate protection** per candle, not an exactly-once guarantee. Cache eviction, retries, or other monitor instances can cause duplicates.
- Scheduled GitHub Actions on public repos can be automatically disabled after prolonged inactivity; check workflow status occasionally.
- No trading endpoints, orders, API keys for trading, or Trading Bridge changes.
- No historical backtest or profitability validation has been performed.

## Background paper-trade journal

Every scanner run now restores the last saved journal and advances independent hypothetical HYPE setups using completed one-minute candles, including runs with no new signal. It uses next-minute modeled fills, 1 HYPE per setup, 5 bps fee and 2 bps slippage per side, stop-first handling when both levels touch, and no funding charges. This is paper simulation, not exchange execution or account equity.

The next checkpoint carries up to 500 recent setups, including their closed results. Each snapshot is retained for 7 days and replaced by a fresh checkpoint on the next run. Restore errors or expired checkpoints stop the journal update rather than silently resetting it. Missing market history is labeled unverified and excluded from realized profit. Hyperliquid supplies only limited recent candle history, so long outages may leave trades unverified.

The private dashboard imports compatible background results on its next sync. Its private pause and custom-assumption controls affect the private journal; they do not change the scanner's default simulation or Telegram alerts. No new trading credentials are needed. The existing Telegram secrets, schedule, and notification deduplication are preserved.

Journal restore/update/upload happens after notification steps and is attempted even if notification delivery fails after a successful scan. A paper-journal failure is visible as a failed workflow; it does not undo an alert already sent. GitHub schedules can be delayed or skipped and are unsuitable for precise live execution.

Run `node test-paper-journal.mjs` to verify checkpoint recovery, modeled exits/P&L, duplicates, and missing-data handling. The engine and validation modules are generated from the private dashboard's TypeScript tracker; update both copies together when changing accounting rules.

Changes to the paper engine or scanner workflow on main also trigger a verification run. These runs use the same alert deduplication and paper-only behavior as scheduled runs.

## Controlled paper account and risk commands

The journal now carries a separate controlled paper account (`portfolio`), starting when this version is first run. Existing independent signal results remain intact. Default paper-only limits are one open position, $2 modeled entry-to-stop loss including estimated fees/slippage, and a $25 daily cutoff. Each position is still 1 HYPE; these are test settings, not funded-account rules.

Admission uses only information available before the modeled entry candle. A missing entry candle blocks late entry. Active positions with missing history block further entries. The daily measure is realized net P/L for the New York calendar day plus negative unrealized P/L on open positions; positive unrealized P/L is excluded. A cutoff locks new entries until the next New York day while existing brackets continue. Gaps, funding and real execution differences mean these limits are not guarantees.

The private dashboard can explicitly dispatch a `paper_control` JSON input to this workflow. This requires its saved fine-grained token to have **Actions: read and write** on **Sentinel-HYPE-Monitor** only. Imports still work with Actions read-only. No Contents write permission, trading key or broker connection is required. Control-only dispatches skip scanning/Telegram and update only paper records.

Commands carry a unique ID and requested timestamp, survive in the checkpoint, and ignore duplicates/stale requests. The dashboard shows QUEUED/UNKNOWN/FAILED until a saved checkpoint acknowledges the command as APPLIED. Retrying a command reuses its ID. GitHub concurrency queues can drop pending jobs, so an unacknowledged command must be retried; QUEUED is not proof of execution.

An emergency stop blocks controlled entries and models exits at the first full-minute open after the command, with fees/slippage. It can be delayed by GitHub or missing history. Repeated stop commands preserve the earliest stop time. Resume requires all stopped positions to be closed; there is no live exchange kill switch. Existing independent simulations and Telegram remain unaffected.

Run `node test-paper-risk.mjs` for position limits, stop risk, daily cutoff, missing data, emergency timing, idempotence, and resume checks. The workflow verifies both accounting and risk before running. It attempts journal maintenance even if the signal scan fails; only validated successful journal uploads are restored.
