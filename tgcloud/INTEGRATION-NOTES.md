# Telegram Serverless integration checkpoint

Source: user's uploaded `message.js` (October 28, 2026), copied to `tgcloud/functions/message.js` in this staging branch.

## Confirmed existing behavior
- The Serverless message function accepts private chat messages.
- `/start` and `/help` reply with read-only instructions.
- `/scan` retrieves completed HYPE 5m candles from Hyperliquid and replies with a preview.
- It uses `sdk` exports `api` and `fetch`, and `../lib/screen.js`.
- No callback-query handler, persistent approval storage, or trade execution exists in the uploaded file.

## Safe integration plan
1. Confirm the installed Telegram Serverless SDK's supported callback-query entrypoint, answerCallbackQuery and message-edit methods; don't assume a message function receives callback updates.
2. Add a separate callback handler only using documented SDK entrypoints, or route callbacks to an authenticated HTTPS receiver after a deliberate webhook migration. **Telegram permits only one active webhook per bot.**
3. Use a durable atomic proposal store and single-use callback tokens. Existing local JSON server is a development prototype only.
4. Connect qualifying GitHub scanner signals to the proposal service using authenticated requests; don't expose bot credentials or proposal secrets.
5. Test YES/NO on a paper proposal, duplicate clicks, expiration, unauthorized actors, restart/retry, and lost Telegram responses.
6. Confirm official My Funded Perpetuals sandbox API contract and copy-trading behavior before any broker integration.
7. Require a separately reviewed live enablement process. Do not place live orders by default.

## Status
This branch is NOT deployed. The existing /scan bot is untouched. The YES/NO code is prototype-only, not yet integrated with Telegram Serverless.
