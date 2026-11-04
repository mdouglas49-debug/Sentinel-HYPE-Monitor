# Telegram approval bridge: paper simulations only

This implementation is based on current `main`, retaining the journal, controlled
paper account, scanner strategy, timers, and notification behavior. It selectively
completes the Serverless code from `sentinel-approval-staging`; it does not merge
that older branch over current production. It contains no broker executor.

## Behavior

When GitHub's `PAPER_APPROVALS_ENABLED` variable is unset or `false`, the existing
scanner creates automatic simulations and sends the existing text alerts.

When it is `true`, qualifying fresh HYPE 5m signals produce owner-only Telegram
YES / NO proposals. Each proposal expires after 90 seconds. YES writes one durable
`APPROVED_PAPER` decision and the unchanged simulation JSON in the same conditional
database update. The JSON `timestamp` is the accepted YES time, so a modeled entry
cannot precede approval. NO and expired decisions never enter the export queue.
The buttons are bound to the stored Telegram message ID, private chat and owner.

On the next scanner run, authenticated Serverless management access exports one
pending approved order. The workflow saves `sentinel-paper-<run_id>` containing
one `simulated-order.json`, then saves the existing background journal checkpoint.
Only successful uploads of both artifacts acknowledge the decision. Failed uploads,
lost acknowledgments and restarts replay the identical signal ID and timestamp;
both the journal and Site importer deduplicate that ID. The existing Site import
trust rules and JSON fields remain unchanged. Historical entries remain intact.

The dashboard journal retains its existing independent-setup accounting. The
controlled paper account additionally applies its existing position, modeled risk,
daily loss and emergency-stop rules; approval does not override those controls.
The scanner's five-minute cadence and GitHub queueing mean dashboard readback can
lag an accepted YES. The dashboard imports while open and catches up on reopening.
Missing candle history remains unverified rather than inventing fills or profit.

## Credentials and configuration

| Setting | Location | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Existing GitHub Actions secret | Existing scanner/read-only notification path; unchanged. |
| `TELEGRAM_CHAT_ID` | Existing GitHub Actions secret and deployment environment | The existing private owner chat; also the allowed Telegram user ID. |
| `TGCLOUD_TOKEN` | GitHub Actions secret and secure deployment environment | Separate app-scoped Telegram Serverless CLI credential (`app<id>:<secret>`). The Bot API token cannot deploy or access Serverless state. |
| `TGCLOUD_APP_NAME` | Optional environment/repository variable | Expected public `app<id>`; if omitted, derived from the app credential. A mismatch is rejected. |
| `PAPER_APPROVALS_ENABLED` | GitHub Actions repository variable | `false` until deployment and verification complete; `true` enables the approval gate. |

The deployment environment must allow `cloud.telegram.org`, with `TGCLOUD_TOKEN`
bound only to that destination. Obtain the CLI credential through the existing
bot's BotFather Serverless / CLI Access controls and enter it through secure secret
configuration, never source, workflow inputs, callback data, command arguments or
chat. The runner verifies the configured owner and `SentinelHypeAI_bot` identity
before reading or sending approvals. No GitHub token or bot token is stored in the
Serverless database, and no runtime SDK environment/secret API is assumed.

## Deployment sequence

1. Keep GitHub approval mode false. Fetch/pull the full existing Serverless project
   using `@tgcloud/cli@0.2.0` into a separate working directory. Its authenticated
   management API uses the app CLI credential. Preserve the fetched revision,
   every unrelated deployed module and any existing schema declarations.
2. Merge only the required schema additions into the fetched project's existing
   `schema` module, retaining the current live handlers and every unrelated module.
   Push that schema-only revision with the supported CLI revision check
   (`npx --yes @tgcloud/cli@0.2.0 push`). The CLI deploy manifest is the full module
   set: omitting modules can delete them. Do not push this partial checkout blindly
   over the live project.
3. Inspect `npx --yes @tgcloud/cli@0.2.0 migrate --dry-run`, then apply only the
   additive tables/columns with its `migrate` command. `push` does not apply pending
   database changes. The new owner/message/outbox columns are nullable so old
   staging rows remain preserved and unexportable; a new owner configuration table
   is added. Keep the original handlers active until these additions are applied.
4. Overlay the runtime approval modules: `handlers/message`,
   `handlers/callback_query`, `lib/paper-approval`, and `endpoints/paper_bridge`.
   Compare the current message handler and preserve any additional commands before
   deployment. Keep `lib/screen` unchanged. Deploy this complete project with the
   supported CLI revision check. Retain the existing Telegram Serverless webhook;
   do not replace it with the old Node prototype, call Bot API `setWebhook`, or
   consume updates through `getUpdates`. Check the platform webhook is in sync.
5. From a secure environment containing the owner chat ID and CLI app credential,
   set `PAPER_APPROVALS_ENABLED=true` for these local commands and run:

   ```sh
   node paper-approvals.mjs configure
   node paper-approvals.mjs status
   ```

   This checks the target bot before writing owner configuration. Verify the bot
   identity, owner, enabled state and that existing `/start`, `/help`, and `/scan`
   work. `/paper-test` sends inert test buttons that cannot queue a trade.
6. Add the CLI credential as the repository Actions secret, then enable the
   repository variable only after the deployed callback handler and database are
   verified. Ordinary scanner runs will propose new signals and drain accepted
   paper orders. Existing manual dashboard risk-control runs do not import a new
   approval while applying the control command.
7. Verify an actual owner click: YES produces one persisted simulation and journal
   row; replay/restart does not duplicate it; NO and an expired proposal produce
   no new row. A real qualifying fresh signal is required for a production paper
   proposal. Do not fabricate a market signal or a user's production callback.

Before enabling the GitHub gate, an unavailable/disabled bridge simply remains
unused. After enabling it, a bridge failure never falls back to an automatic trade.
It is visible as a failed workflow; existing positions still receive journal
maintenance. For an operational pause, disable the bot bridge configuration while
keeping GitHub approval mode true. Setting GitHub mode false resumes the legacy
automatic simulation path, so it is a rollback of the gate, not a trading pause.

## Verification

All tests run with fake Telegram APIs and real local SQLite state; they do not send
messages, dispatch workflows or execute any broker operation.

```sh
node test-telegram-cloud.mjs
node test-telegram-approval.mjs
node test-paper-approvals.mjs
node test-paper-approval-pipeline.mjs
node test-paper-journal.mjs
node test-paper-risk.mjs
```

The transport follows the official CLI 0.2.0 management/run contract, supplies the
full pinned local module graph, bounds responses and timeouts, fixes the destination,
and rejects public Mini App calls to the management bridge. Tests cover owner/chat
and message binding, atomic competing YES/NO, frozen timestamps, expiry, lost send
responses and send leases, unknown/rejected acknowledgments, restart persistence,
original simulation JSON, journal/risk replay, and upload-before-acknowledgment.

Production activation remains pending until the separate Serverless credential,
deployed-source comparison, schema migration and real Telegram button readback
are available. The existing dashboard repair and 18 confirmed unique imports are
not changed by preparing this bridge.
