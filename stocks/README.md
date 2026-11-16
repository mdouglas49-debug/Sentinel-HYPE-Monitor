# Sentinel AI - Full Market pilot

Paper-only, standard-library Python 3.11+. No trading/order endpoint or paid dependency is used. Existing HYPE files, secrets, workflows and schedules are unchanged. This is an isolated pilot implementation; market access and timing are not established by fixture tests.

## Current verification (November 16, 2026)

- Community constituent sources downloaded: 503 S&P securities + 101 Nasdaq-100 securities, 86 overlaps, 518 unique. Download timestamps and SHA-256 hashes are recorded per run. These sources are not an official membership attestation; index count is not market-data coverage.
- No Alpaca keys were available in this runtime. An actual request to data.alpaca.markets was denied by the environment proxy (CONNECT 403). No live timestamp, consolidated entitlement, cold/warm scan duration, coverage percentage, or live IEX/SIP comparison is claimed.
- Existing Telegram runtime binding returned HTTP 404 for sendMessage and getMe. No delivery confirmation was obtained. UNKNOWN delivery rows intentionally block automatic replay. Verify the bot binding before an operator-authorized new test ID.
- The readiness check remains November 17 at 08:45 America/New_York; weekly wrap-up remains Fridays around 17:00 starting November 20. Those are reporting tasks, not a deployed scanner scheduler.

## Configuration

Environment settings: add APCA_API_KEY_ID and APCA_API_SECRET_KEY as secrets for a free Alpaca paper account. Allow data.alpaca.markets and paper-api.alpaca.markets. Preserve existing Telegram/Hyperliquid grants. Universe downloads use already-allowed raw.githubusercontent.com. Allow sentinel-hype-dashboard.chirpyfrog6.chatgpt.site for service writes/readback.

The private dashboard service caller uses SENTINEL_DASHBOARD_URL with that exact HTTPS origin and SENTINEL_SITES_TOKEN obtained from Sites get_site. Pass credentials through environment/session memory, not source, URLs, logs, prompts or chat. Existing TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are reused. A configured secret is not evidence that the credential works. No paid plan should be activated to resolve a 401/403/422; report the entitlement failure.

## Commands

From the repository root:

```sh
python -m unittest discover -s stocks -p 'test_*.py'
python stocks/scanner.py preflight
python stocks/scanner.py universe
python stocks/scanner.py benchmark --session 2026-11-17 --cache stocks-state/cold
python stocks/scanner.py benchmark --session 2026-11-17 --cache stocks-state/cold
python stocks/scanner.py scan --session 2026-11-17
python stocks/scanner.py publish --file stocks-state/watchlist.json
python stocks/scanner.py watch --file stocks-state/watchlist.json --send
```

Run benchmarks after 09:15 Eastern on a verified trading day. First benchmark uses an empty cache; second reuses it. They do not publish, and return actual wall-clock seconds, request counts, per-symbol exclusions, latest bar timestamps and distinct requested/observed/eligible counts. `scan` freezes the first watchlist for that session in SQLite; repeats reuse it, so they are not benchmark runs. `publish` explicitly sends the same canonical event to the two channels. `test-delivery` creates a SYNTHETIC TEST with no market candidates; `--send` is an explicit external action.

Historical SIP requests use an explicit cutoff no later than 15 minutes plus a five-second safety margin behind current time, floored to a minute. A 09:15:00 invocation can therefore show 08:59 as its cutoff. Only bars whose entire minute ends by the displayed cutoff participate. An 08:59 bar describes 08:59–09:00 and requires a 09:00 cutoff. No real-time SIP subscription is requested. The preflight tests historical SIP and recent IEX independently and prints actual last-bar timestamps, never an inferred freshness claim.

## Pilot rules and journal

- Universe is the deduplicated union of the two named CSV sources; counts outside conservative bounds fail closed. Symbol class punctuation is normalized to Alpaca's dot notation. Missing/inactive/renamed symbols remain in requested coverage and appear in exclusions; they are not silently removed.
- Up to 20 prior trading sessions are pulled from Alpaca's calendar. Premarket volume is compared with cumulative volume between 04:00 and the same cutoff on prior days, requiring at least five usable histories. No fabricated zero is substituted for an absent history. A cold full-universe pull may be slow; completed historical results are cached on disk. Clear that cache after corporate-action corrections.
- Candidate thresholds are positive gap versus split-adjusted previous regular daily close, at least 1.5x same-time volume and at most 2% below the premarket high plus $0.01 trigger. Equal-weight percentile ranks combine gap, volume and proximity. Maximum five candidates; no forced minimum. Paper stop uses the larger of 0.5% trigger or recent observed premarket lows; target is 2R. These are pilot assumptions, not a validated strategy.
- News is optional. Alpaca's timestamped headline, symbol association, publisher and HTTPS article link are retained when available before brief creation. This verifies a news reference, not that news caused the price move. Absence/failure is labeled unverified.
- IEX and SIP monitoring use separate same-minute volume histories (ten prior sessions, at least five observations per clock minute) and at least 1.5x volume. A candle must finish after 09:30, cross from at/below the trigger to a close above it, and be completed by the feed cutoff. Each feed gets at most one confirmation per watchlist/symbol; first confirmation is frozen. IEX is one venue and cannot represent consolidated volume.
- Default test window is 09:30–10:30 Eastern. Monitoring continues to 10:47 to collect delayed consolidated bars and compare BOTH/IEX_ONLY/SIP_ONLY/NEITHER. Incomplete bar/baseline evidence produces UNVERIFIED, not a claim of no alerts. Comparisons retain both bar timestamps, allowing lag inspection.
- Paper entry is the confirming close, not an actual fill. Only subsequent completed one-minute bars can exit. Gaps through stops use the worse opening price; target fills use the target; both touches within a bar count stop first. Missing minutes remain UNVERIFIED. Terminal outcomes freeze, and still-open setups become OPEN_AT_WINDOW_END. Fees, slippage, liquidity and real fills are excluded; there is no profitability claim.
- SQLite stores events and independent channel delivery claims before side effects. Confirmed receipts deduplicate across restarts. A timeout/crash/failure leaves UNKNOWN; no automatic resend occurs. This favors missing an ambiguous alert over duplicates and does not promise exactly-once transport. Preserve stocks-state/journal.sqlite and its WAL; deleting it loses deduplication. Run only one scanner instance with this state. The dashboard additionally rejects content changes for the same ID and conditionally persists separate immutable R2 objects, outside the HYPE journal.

## Scheduling still pending

No 09:15 scheduler or sustained live monitor has been activated. Keep the readiness gate until Alpaca access, official membership, full-universe cold/warm timing, delivery and IEX/SIP observations pass. An ordinary GitHub cron is not a precise minute scheduler. Do not count the existing ChatGPT readiness/wrap-up tasks as evidence of a running scanner. Start the monitor on an always-on no-cost runner only after confirming its lifecycle and preserved private SQLite state; do not add paid hosting.

Alpaca references: https://docs.alpaca.markets/us/docs/about-market-data-api and https://docs.alpaca.markets/us/reference/stockbars . Test the actual account's entitlements; documentation does not verify account access.
