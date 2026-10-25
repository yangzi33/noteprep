# Daily refresh: rollout

Technical notes for switching the daily export allowance on and off. Design: see the plan under `docs/superpowers/plans/2026-10-25-daily-refresh-plan.md`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `DAILY_REFRESH_ENABLED` | `0` | `1` enables the daily allowance |
| `DAILY_REFRESH_LIMIT` | `5` | Exports per UTC day (integer, 1 to 1000) |

- Set both in the web scopes only (Vercel: Production and Preview as needed). The worker does not read them.
- Vercel applies variable changes to new deployments only. Redeploy after every change.
- Set both explicitly in each hosted environment; `.env.example` lists them as placeholders.

## Operator top-up

`POST /api/admin/refresh-allowance` gives every free account the full daily limit again for the current UTC day (D-113). For each daily bucket of today it raises `limit_count` to `used + reserved + DAILY_REFRESH_LIMIT` and never lowers it; it never edits `used` or `reserved`, so the lifetime sum and the drift views stay consistent. Accounts with no bucket today already have the full limit, and trial and paid buckets are never touched.

- Off by default. Set `ADMIN_REFRESH_ENABLED=1` and `ADMIN_REFRESH_TOKEN` (a random string of at least 32 characters) in the Vercel server environment only, never in a `NEXT_PUBLIC_*` variable and never in the repository. With the flag on and no valid token, the app fails at startup.
- Keep `ADMIN_REFRESH_ENABLED=0` unless the call is about to be made. Vercel applies variable changes to new deployments only, so enabling and disabling each need a redeploy. While off, the route answers 404 with an empty body for every method, and never reads the token.
- It works only while `DAILY_REFRESH_ENABLED=1`.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" https://<host>/api/admin/refresh-allowance
```

| Response | Meaning |
|---|---|
| `200 {"accounts": N}` | N daily buckets were topped up (0 when nothing needed it) |
| `401` | missing or wrong token |
| `404` | the route is disabled |
| `405` | any method except POST |
| `409` | the daily refresh is off |
| `429` | another authenticated call already ran in the same UTC minute (the guard is a fixed one-minute window, so two calls on either side of a minute boundary are both allowed) |

The request carries no parameters; the day, the limit and the accounts come from the server. The log holds one line with a request id and the account count. Rotate the token by changing it and redeploying; remove it when finished and set the flag back to `0`.

## Migrations

Two migrations add the daily bucket kind:

1. `prisma/migrations/20261025100000_bucket_kind_daily` adds an enum value. It is IRREVERSIBLE (Postgres cannot drop an enum value).
2. `prisma/migrations/20261025100100_daily_bucket_shape` changes the bucket shape for daily rows.

Apply them with the `Database migrations` workflow (status first, then deploy), staging first, then production. The repository owner runs and approves this step. Apply the migrations before deploying a web build with `DAILY_REFRESH_ENABLED=1`.

## Behaviour

- Enabled: an account uses its daily bucket first (the count returns at 00:00 UTC); the lifetime allowance is used only when the daily bucket is not available.
- Disabled (`DAILY_REFRESH_ENABLED=0`): only the lifetime allowance of 3 applies. It counts every export made while the perk was on, so an account that exported while the perk was on may already have used some or all of it.
- Exports already reserved against a daily bucket settle normally after the setting is turned off.

## Rollback

Set `DAILY_REFRESH_ENABLED=0` in the web scopes and redeploy. No migration needs to be reverted; the enum value stays.

Notify affected users before switching the setting off: the daily count stops applying after the redeploy.

## Checks

- CI runs `tests/e2e/daily-refresh-daily.spec.ts` against a pinned server with the perk on (project `chromium-daily`, port 3103); the other servers pin `DAILY_REFRESH_ENABLED=0`.
- Not covered by CI: a hosted rehearsal on staging with real Vercel variables and a midnight UTC rollover.
