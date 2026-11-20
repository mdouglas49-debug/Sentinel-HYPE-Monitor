# Sentinel AI - Full Market pilot

Paper-only, Python 3.11+ using the official `alpaca-py` SDK. No trading/order endpoint or paid dependency is used. Existing HYPE files, secrets, workflows and schedules are unchanged. This is an isolated pilot implementation; market access and timing are not established by fixture tests.

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
python -m pip install -r stocks/requirements.txt
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
- IEX and SIP monitoring use separate same-minute volume histories (ten prior sessions, at least five observations per clock minute) and at least 1.5x volume. A candle must finish after 09:30, cross from at/below the trigger to a close above it, and be completed by the feed cutoff. Each feed gets at most one confirmation per watchlist/symbol, with at most one Telegram alert across both feeds; first confirmation is frozen. IEX is one venue and cannot represent consolidated volume.
- Default test window is 09:30–10:30 Eastern. Monitoring continues to 10:47 to collect delayed consolidated bars and compare BOTH/IEX_ONLY/SIP_ONLY/NEITHER. Incomplete bar/baseline evidence produces UNVERIFIED, not a claim of no alerts. Comparisons retain both bar timestamps, allowing lag inspection.
- Paper entry is the confirming close, not an actual fill. Only subsequent completed one-minute bars can exit. Gaps through stops use the worse opening price; target fills use the target; both touches within a bar count stop first. Missing minutes remain UNVERIFIED. Terminal outcomes freeze, and still-open setups become OPEN_AT_WINDOW_END. Fees, slippage, liquidity and real fills are excluded; there is no profitability claim.
- SQLite stores events and independent channel delivery claims before side effects. Confirmed receipts deduplicate across restarts. A timeout/crash/failure leaves UNKNOWN; no automatic resend occurs. This favors missing an ambiguous alert over duplicates and does not promise exactly-once transport. Preserve stocks-state/journal.sqlite and its WAL; deleting it loses deduplication. Run only one scanner instance with this state. The dashboard additionally rejects content changes for the same ID and conditionally persists separate immutable R2 objects, outside the HYPE journal.

## Scheduling still pending

No 09:15 scheduler or sustained live monitor has been activated. Keep the readiness gate until Alpaca access, official membership, full-universe cold/warm timing, delivery and IEX/SIP observations pass. An ordinary GitHub cron is not a precise minute scheduler. Do not count the existing ChatGPT readiness/wrap-up tasks as evidence of a running scanner. Start the monitor on an always-on no-cost runner only after confirming its lifecycle and preserved private SQLite state; do not add paid hosting.

Alpaca references: https://docs.alpaca.markets/us/docs/about-market-data-api and https://docs.alpaca.markets/us/reference/stockbars . Test the actual account's entitlements; documentation does not verify account access.

## Official SDK

`alpaca-py==0.45.0` is pinned in requirements.txt. The scanner uses its REST client for stock bars, news and the paper calendar. A restricted adapter rejects every non-GET request, alternate host and unlisted route; no trading client is instantiated. Manual pagination and explicit feed/cutoff parameters remain intact. Each HTTP attempt, including SDK rate-limit retries, contributes to the benchmark request count. Requests use a 25-second timeout, inherited proxies and CA trust, and sanitized errors. Installing the SDK does not establish credential or feed access.

## Authenticated Sites delivery — November 17, 2026

The scanner uses the existing owner-private Site's service credential returned by Sites `get_site`. Send it only in `OAI-Sites-Authorization: Bearer ...` to the fixed Sentinel origin's `/api/stocks`. Browser sign-in cookies and visitor identity headers are not copied or forged. Site access remains owner-only.

`SENTINEL_SITES_TOKEN` and `SENTINEL_DASHBOARD_URL` may be supplied by the environment. As a workspace-local alternative, `stocks/sites_access.py` reads credential JSON on hidden stdin and atomically saves `stocks-state/.env.sites` with mode 0600 inside a 0700 directory. The scanner loads these two environment names automatically when they are otherwise absent. This file is ignored by Git; credentials are never committed or passed in command arguments. The reader rejects symlinks, non-regular files, incorrect ownership and permissions that expose values to others. Existing environment values take precedence. The client refuses redirects, other origins, and methods other than GET/POST, and sanitizes error output.

This local configuration applies to this checkout and task. It does not register a secret in the reusable Cloud environment's vault, and a fresh checkout must obtain supported service access again or receive the environment secret. No tool for writing that Cloud configuration is available in this task. Do not copy this credential into a public repository, schedule prompt, deployment archive or browser bundle.

Verify the actual authenticated path with:

```sh
python stocks/scanner.py verify-dashboard --session 2026-11-17 --test-id sites-auth-v1
```

This first requires anonymous access to be rejected and authenticated GET to succeed. It then writes one clearly labeled PAPER_ONLY/SYNTHETIC event, verifies its receipt SHA-256 and persisted readback, and replays the same ID to confirm server-side deduplication. It never sends Telegram messages or uses market prices. A network failure before the write creates no delivery claim. An ambiguous POST remains UNKNOWN and is not automatically resent.

Current verification: the Sites service credential was configured locally and permission/ignore checks passed. All 18 stock tests pass, including credential loading, fixed-host/header-only auth, redirect refusal, anonymous rejection, write/readback and duplicate handling with mocked HTTP. The actual hosted verification was attempted but blocked before any write: the running environment denies `sentinel-hype-dashboard.chirpyfrog6.chatgpt.site` with CONNECT 403. Add this exact hostname to the active environment's allowed domains before claiming production delivery. No endpoint or dashboard privacy change is required.

## Hosted Alpaca preflight — November 20, 2026

The existing `stocks-tests.yml` now runs a separate **Alpaca paper authentication** job after its unit tests on same-repository pull requests or explicit workflow dispatches. The existing HYPE workflow is unchanged. This is a configuration/access check, not a recurring scanner schedule.

Supply `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` as repository **Actions secrets** at https://github.com/mdouglas49-debug/Sentinel-HYPE-Monitor/settings/secrets/actions . Use paper-account keys. Values are passed only to the preflight step, never source, user chat, command arguments or the report. Forked PRs do not receive this job. No changes to local Windows Python or this chat's Cloud configuration are required for the hosted check.

The job reads the paper calendar and seven days of sample AAPL/MSFT minute bars from SIP and IEX separately. SIP ends at least 16 minutes behind the check time; incomplete minutes are excluded. Missing keys, failed feeds, absent sample bars or a failed calendar prevent success. A successful report explicitly establishes two-symbol authenticated data access, not full-universe coverage, scan timing, live freshness or channel delivery. No order route or trading client is used. No Telegram or dashboard message is sent.

The job writes `stocks-state/alpaca-preflight.json`, a GitHub job summary and a seven-day workflow artifact. Its result is BLOCKED with exact missing secret names when credentials are absent. After secrets are added, the existing failed job can be rerun without installing anything on the user's computer. The script and five new tests bring the local scanner suite to 23 passing tests.

## Verified Alpaca access and hosted benchmark

On November 20, the GitHub authentication check succeeded with the repository's paper credentials: paper calendar, SIP and IEX all verified with three HTTP attempts. At 10:51:58 Eastern, the latest returned bars opened at 10:34 for delayed SIP and 10:50 for IEX (completed through 10:35 and 10:51 respectively). This establishes sample data access, not full-universe readiness.

After authentication passes, the pilot PR's workflow runs `stocks/benchmark.py`. A fresh temporary history cache measures a cold full-universe scan and then a warm scan of the same constituents and cutoff. The report includes download time, actual elapsed seconds, all HTTP attempts including calendar calls, observed premarket coverage, eligibility/exclusion counts and bar timestamps. It exports no watchlist contents, prices or private alerts. This retrospective test does not send Telegram/dashboard messages or activate the 09:15 schedule. Reports are retained as seven-day GitHub artifacts.
