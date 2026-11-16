# Dashboard compatibility verification

PR #4 keeps the complete independent simulation journal on `paper-state` and uploads a separate dashboard snapshot. The snapshot contains no more than 500 recent independent setups and no more than 900,000 JSON bytes. Controlled-account state is preserved; an oversized controlled account fails export rather than silently dropping its risk or control records. Persistence happens before export and approval acknowledgement still requires successful artifact uploads.

## Verified locally

- All eight scanner suites passed (state, dashboard export, journal, risk, Telegram cloud, Telegram approval, approvals, full approval pipeline).
- Durable restore handles journals above 1 MiB and keeps 502 independent records across restart; duplicate replay does not add a record.
- The unchanged private dashboard importer accepts both the 500-record compatibility ZIP and a byte-trimmed ZIP generated from a larger complete journal.
- The actual private Worker importer passed both ZIPs, including persisted backfill, restart/replay, duplicate protection, controlled-portfolio state and user/credential isolation. External APIs were mocked and R2 was local.
- All six existing dashboard suites passed during the initial compatibility investigation.

The optional cross-repository contract test reads private source in place without copying it into this repository:

```sh
SENTINEL_DASHBOARD_CHECKOUT=/absolute/path/to/dashboard node test-dashboard-contract.mjs
```

It requires the dashboard's TypeScript dependency. Dashboard source tested: `0d4ddb26519bbd5c09b7541cdded5caf1e949f20` (Site version 19).

## Hosted UI verification and limits

The deployed dashboard URL loaded in shared Chrome, required sign-in, and its Continue with ChatGPT button opened the OpenAI login page. The browser has no authenticated owner session. Secure form inspection was unavailable, so no credentials were entered. Authenticated rendering, production sync, and reload persistence remain unverified pending owner sign-in. Production data, Site access, and deployed source were unchanged.

The current dashboard computes its existing metrics from imported records. It does not automatically expose the new trade-count/loss/breakeven/drawdown fields. Complete-history metrics remain in the durable journal's summary; compatibility snapshot summary describes only exported setups. This PR does not deploy new dashboard metric cards or claim a full-history dashboard readout.
