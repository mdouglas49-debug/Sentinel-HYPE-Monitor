# Sentinel HYPE — GitHub Actions read-only alerts

This runs the *same* `tgcloud/lib/screen.js` screening logic as the Telegram Serverless `/scan` bot, but **GitHub Actions runs the scheduled scanner directly** and sends qualifying alerts through Telegram Bot API. It does not invoke Telegram Serverless. The Serverless bot continues to handle `/scan` independently.

## Set up ($0 option)

1. Create a **new public GitHub repository** for this code. Do not include credentials, `.env`, `.tgcloud`, or the original project folder. Public standard GitHub-hosted Actions are generally free, subject to GitHub policies and limits. A private repo running every five minutes can exceed its included minutes.
2. Upload the contents of this ZIP to the repo, retaining `.github/workflows/hype-scan.yml`.
3. Go to Settings → Secrets and variables → Actions → New repository secret. Add `TELEGRAM_BOT_TOKEN` (token of the bot you want to send the alerts) and `TELEGRAM_CHAT_ID` (your personal chat ID). Never put secrets in files, workflow YAML, commits, or chat.
4. Open the bot in Telegram and press Start if needed. On GitHub, Actions → Sentinel HYPE read-only scan → Run workflow to test a scan. A test run will send **no message** unless a signal qualifies.
5. Keep the laptop monitor running until you have observed successful scheduled workflow runs and confirmed delivery of a qualifying signal. Then stop the laptop monitor to avoid duplicate alerts from separate systems.

## Scheduled paper monitoring

The workflow declares both `workflow_dispatch` and `schedule` with cron `2-59/5 * * * *` (UTC minutes 2, 7, 12, ..., 57). The intended mode is recurring **read-only alerts and paper simulation**, never live execution. The schedule becomes eligible only when this workflow is on the repository's default branch and GitHub Actions/the workflow are enabled. A review branch does not activate the schedule.

Each invocation scans the latest completed HYPE 5m candle. A qualifying `SIGNAL_PREVIEW_ONLY` creates `latest-signal.json`, runs `simulate.mjs`, and uploads `simulated-order.json` as `sentinel-paper-<run_id>` for 30 days. A missing expected artifact fails the upload step. No qualifying signal means no simulation artifact and no Telegram alert; a successful run alone does not prove notification delivery.

The existing per-candle cache check then suppresses previously sent Telegram alerts. Runs are serialized with `sentinel-hype-scan` and `cancel-in-progress: false`. Simulation and artifact upload occur before this notification check, so a repeated candle can produce another paper artifact even when its Telegram alert is suppressed. Consumers must deduplicate paper records by `signal_id`; the simulator's local-file duplicate check does not persist across fresh runners.

### Validation and activation

1. Review and statically validate the workflow before merging. Keep `contents: read`, the existing concurrency group, and the existing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` secret references. No trading credentials are needed.
2. Merge to the default branch only when ready to activate recurring monitoring. Check Actions is enabled, the workflow is enabled, and the two existing repository secrets are configured; never print their values.
3. A manual Run workflow uses the same alert/paper path and may send a qualifying Telegram alert. It does not validate the scheduler. Confirm subsequent runs show event `schedule`, inspect scan logs, and inspect any qualifying paper artifact.
4. Keep only one independent notification monitor active once delivery is verified. The laptop and Serverless `/scan` do not share this workflow's notification cache.

### Remaining limitations

GitHub Actions scheduling is best effort, not a reliable every-candle service: delayed/dropped runs and concurrency replacement of pending runs can skip candles. The scanner evaluates only the latest completed candle; it does not backfill missed candles. Public-repository schedules may be disabled after 60 days without repository activity. See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Paper simulation validates and records a hypothetical entry/stop/target only. It does not submit orders, model actual fills/slippage/fees, track exits, or calculate realized P&L. Artifact retention is not a durable paper-trade ledger. Notification cache protection remains best effort: cache eviction or failure after Telegram delivery but before cache save can allow duplicates. A successful no-signal run does not exercise simulation/upload/delivery, and missing secrets fail the scan before screening.

## Behavior and limitations

- Cron runs at minute 2,7,12,... UTC, shortly after 5-minute candle boundaries. GitHub scheduling can be delayed or dropped and is not guaranteed every five minutes. The workflow skips market data older than 10 minutes.
- 240 candles, EMA9/EMA21, RSI14, confirmed pivots, and 1.5 reward/risk are reused unchanged from your deployed Serverless scanner.
- Only `SIGNAL_PREVIEW_ONLY` sends an alert; `NO_SIGNAL` does not.
- GitHub Actions cache keys provide **best-effort duplicate protection** per candle, not an exactly-once guarantee. Cache eviction, retries, or other monitor instances can cause duplicates.
- Scheduled GitHub Actions on public repos can be automatically disabled after prolonged inactivity; check workflow status occasionally.
- No trading endpoints, orders, API keys for trading, or Trading Bridge changes.
- No historical backtest or profitability validation has been performed.
