# Sentinel Telegram approvals — staging (PAPER ONLY)

This development branch contains a local Node 24 webhook service, not a deployed integration. **No trading endpoints or API keys are used.** The existing main branch and GitHub workflow are unchanged.

## What it does
- Accepts a qualifying HYPE 5m signal at POST /proposal with header `x-sentinel-proposal-secret`.
- Checks signal freshness, protective stop, target, and minimum 1.5 reward/risk.
- Sends Telegram YES (PAPER) / NO buttons; approval expires in 90 seconds.
- Receives Telegram callbacks at POST /telegram, authenticating Telegram's webhook secret, allowed user ID, and chat ID.
- Records one-time decisions locally; a YES only records APPROVED_PAPER.
- Deduplicates proposals by candle, side, and prices.

## Not yet operational
This service has **not** been deployed, wired to the scanner, or tested end-to-end. Existing Telegram bot uses a separate serverless webhook. Telegram supports one active webhook per bot: do **not** call setWebhook for this service or replace the existing webhook until the callback logic is integrated with the existing Telegram Serverless handler or a planned migration is performed. The service binds to localhost, not a public address.

Local JSON state is for single-process development only. It is not safe for multiple replicas, process crashes during network delivery, or production order authorization. A durable transactional database and webhook update idempotency are required before production. The code also needs tests and a deployment review.

## Environment variables (never commit values)
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID
- TELEGRAM_ALLOWED_USER_ID
- TELEGRAM_WEBHOOK_SECRET (20+ characters)
- SENTINEL_PROPOSAL_SECRET (32+ characters)
- SENTINEL_APPROVAL_STORE (optional local file)
- PORT (optional, default 8080)

## Future execution requirements
Before any live trading, verify My Funded Perpetuals' official API authentication, sandbox account IDs and copy-trading semantics, execution order schema, position and stop placement, balance/equity endpoints, firm rules, and daily loss accounting. Implement idempotent execution with price deviation checks, maximum age, per-account size/drawdown limits, trading hours, and kill switch. Keep execution OFF until explicitly enabled after tests.
