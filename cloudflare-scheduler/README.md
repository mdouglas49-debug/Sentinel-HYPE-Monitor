# Sentinel HYPE cloud timer

This Worker requests the existing main-branch `hype-scan.yml` workflow every five minutes using Cloudflare Cron rather than GitHub's native schedule. Signal rules, Telegram sending, duplicate protection and paper artifacts remain in the existing workflow. GitHub runner queueing can still delay execution; a successful dispatch is not proof that the scan ran.

The timer ships DISABLED. No secrets are committed. Activation and two successful scheduled scans must be verified before removing the old GitHub cron.

## One-time Cloudflare setup

Use the Workers Free plan; do not enable a paid plan or paid resources. Create a Worker from this GitHub repository with root directory `cloudflare-scheduler`, no build command, and deploy command `npm run deploy` (or `npx wrangler deploy`). The Worker name must be `sentinel-hype-timer`.

Create a separate fine-grained GitHub token for owner `mdouglas49-debug`, only repository `Sentinel-HYPE-Monitor`, repository permission **Actions: Read and write**, with an expiration. This permission is necessary to request workflow dispatches; do not alter the dashboard's existing read-only token. Store it in the Worker's encrypted secret named `GITHUB_DISPATCH_TOKEN`. Never paste it into chat, source, logs, screenshots, or public variables.

After the secret is configured, set `SCHEDULER_ENABLED` to `true` and deploy that change. The cron is `1-59/5 * * * *` UTC (minutes 1,6,11,...56), shortly after each five-minute candle closes. When using Git-based deployment, keep the flag in wrangler.jsonc synchronized; a subsequent deploy can overwrite dashboard variable changes.

In Cloudflare's scheduled invocation logs, verify two successive `dispatch_accepted` or `already_requested` events, then check the corresponding GitHub workflow runs actually started and completed within the expected time. Monitor errors and token expiration. Only after that verification should the original GitHub `schedule` block be removed; retain `workflow_dispatch`.

No trading orders are placed. The public Worker URL is informational and cannot trigger a scan. Pause by setting the enable flag to `false` or removing the Cron Trigger. Run local checks with `node test.mjs`.
