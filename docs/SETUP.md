# Setup guide

Two parts:
1. **Run it on your computer** (about 10 minutes), using sample emails and no Google account.
2. **Put it online for free** (about 1–2 hours, once), following `FREE-TIER.md` §11.

Everything here is free except Claude (Opus 5), which you pay for with your own prepaid Anthropic credits and a hard monthly cap.

---

## 1. Run it on your computer

**You need:** Node.js 24, pnpm 11 (`corepack enable`), Docker, and Google Chrome at `/usr/bin/google-chrome` (or set `CHROME_PATH`).

```bash
pnpm install
pnpm db:up                                   # Postgres 18 on port 5433, set up like Neon
cp .env.example .env.local                   # then fill in APP_RW_PASSWORD (see below)
pnpm db:migrate                              # creates the tables, roles and security rules
pnpm exec tsx packages/crypto/scripts/gen-keys.ts --dev   # prints development keys (see below)
```

In the root `.env.local`, choose one password for the app's database user (24+ random letters and digits, so it can sit inside the URL as is) and write it **twice**: as `APP_RW_PASSWORD`, and in place of `<APP_RW_PASSWORD>` inside `DATABASE_URL` (the file does not fill one into the other). `pnpm db:migrate` sets that password on your local database.

Put the printed keys into three files. Never commit them; they are ignored by git.
- **`apps/web/.env.local`** — `DATABASE_URL` (the `app_rw` user and the password above), `BETTER_AUTH_URL=http://localhost:3000`, `APP_ORIGIN=http://localhost:3000`, `VIEW_ORIGIN=http://localhost:3001`, `EDF_DEV_LOGIN=1`, `RENDERER=local`, plus every key under "edf-app" and "local development".
- **`apps/view/.env.local`** — `IMG_PUBKEYS`, `APP_ORIGIN`, `VIEW_ORIGIN`, `APP_VIEW_SOURCE_AUD` (= `DEV_OIDC_AUD`) and the "local development" block.
- **`apps/keys/.env.local`** — `TOKEN_KEKS`, `TOKEN_KEK_ACTIVE`, `APP_ORIGIN`, `APP_OIDC_SUB` (= `DEV_APP_SUB`), `KEYS_AUD` (= `DEV_OIDC_AUD`), `OIDC_ISSUER` (= `DEV_OIDC_ISSUER`) and the "local development" block.

Then load sample data and start the three services:

```bash
pnpm --filter @edf/web seed-demo             # a demo account with realistic sample mail
pnpm --filter @edf/web import-fixtures --render   # real analysis of fixtures/emails, rendered in Chrome
pnpm --filter @edf/web dev                   # the app      → http://localhost:3000
pnpm --filter @edf/view dev                  # email viewer → http://localhost:3001
pnpm --filter @edf/keys dev                  # key service  → http://localhost:3002
```

Sign in at http://localhost:3000/sign-in with the **development sign-in** form: `demo@edf.local` / `demo-password-123`. (That form exists only when `EDF_DEV_LOGIN=1` and never in production.)

**Usage metering on your computer.** The free-tier "governor" slows the app down (polling, renders, images) as Vercel, Neon or Inngest usage nears its free limits. Your laptop's usage isn't any of those, so locally the app doesn't record it: no Vercel CPU, invocations, memory or Fast Origin Transfer and no edf-view traffic rows (only on Vercel), no Neon transfer or awake minutes (only on Vercel, or when `DATABASE_URL` points at Neon), and no Inngest executions while the Inngest Dev Server is used (`INNGEST_DEV=1`). So testing, browser automation and scripts never throttle your local app. Everything else is still recorded locally (Claude spend, Gmail units, Sandbox VMs, edf-keys counts, imports), and each edf-view report still lands in the audit log (`action = 'view.stats'`). To test the governor itself, add `EDF_METER_LOCAL=1` to `apps/web/.env.local` and restart the app (`pnpm --filter @edf/web dev`; the Inngest jobs run inside it): usage is then metered exactly as in production. Remove it afterwards; the fake usage stays in the local `usage_ledger` until you delete it (`packages/budget/DECISIONS.md`, "Local development"). On Vercel everything is always metered, and so is any production build whose database isn't on your computer: a local `pnpm --filter @edf/web build` + `start` against the Docker database (`localhost`) is still unmetered, but pointed at a Neon database it is metered like production. There is no switch to turn metering off in production.

**Checks:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (the database tests need `pnpm db:up`).

---

## 2. Put it online for free

Follow `docs/FREE-TIER.md` §11 exactly; this is the same list with the concrete commands.

1. **GitHub** — create a *private* repo on your personal account and push this code. Create a fine-grained token with only **Issues: write** on that repo (for alerts).
2. **Neon** (neon.com, no card) — project `edf-prod`, Postgres 18, region `aws-us-east-1`, compute fixed at 0.25 CU. From your computer, run the migrations with the **owner** connection string:
   ```bash
   DATABASE_URL_OWNER='<owner connection string, unpooled>' APP_RW_PASSWORD='<new long random password>' pnpm db:migrate
   DATABASE_URL_OWNER='…' pnpm --filter @edf/db invite you@gmail.com owner
   ```
   The app itself only ever gets the **pooled `app_rw`** connection string (it can't bypass the security rules).

   **Later migrations** (after an update): run `DATABASE_URL_OWNER='<owner connection string, unpooled>' pnpm db:migrate` **without** `APP_RW_PASSWORD`. The `app_rw` password then stays as it is. The password in your root `.env.local` is only ever used for the local database named in that same file (a `localhost` address), never for Neon; pass `APP_RW_PASSWORD='…'` on the command line only when you really mean to change the Neon password (and then update `DATABASE_URL` in Vercel to match).
3. **Google Cloud** (no billing account on any project):
   - `edf-login`: OAuth consent screen *External*, **publish to "In production"**, scopes `openid email profile`; a *Web* client with redirect `https://<app>.vercel.app/api/auth/callback/google`.
   - `edf-connector`: enable the **Gmail API**; consent screen with your home and privacy page URLs, authorised domain `<app>.vercel.app` (verify it in Search Console), scope `gmail.readonly` only, **publish to "In production"**; a *Web* client with redirect `https://<app>.vercel.app/api/mailboxes/google/callback`.
   - Never leave the connector in "Testing": Gmail access would silently expire every 7 days.
4. **Anthropic** — buy $10 of credits, then open Billing and **confirm auto-reload is OFF**. Create workspace `edf-prod` with a **$5/month** limit, and create the API key *inside* that workspace.
5. **Inngest** (no card) — create the app, connect the Vercel integration for the production `edf-app` project only. Standard deployment protection (step 6) answers 401 on every Vercel address except the production domain, and by default Inngest calls the per-deployment address, so without the two settings below it can never reach the app (no ticks, imports, renders or AI):
   - in `edf-<name>` on Vercel: Settings → Deployment Protection → **Protection Bypass for Automation** → create a secret, and paste it into the Inngest Vercel integration's settings (the deployment protection key field);
   - add the production variable `INNGEST_SERVE_ORIGIN=https://<app>.vercel.app` (exactly the same value as `APP_ORIGIN`), so Inngest always calls the public production domain. The app refuses to start in production without it.

   After the first deploy, check that the app shows as synced in the Inngest dashboard.
6. **Vercel Hobby** (no card) — Team Settings → Data Preferences → **opt out of AI training**. Create three projects from the repo:
   | Project | Root directory | Notes |
   |---|---|---|
   | `edf-<name>` | `apps/web` | Next.js |
   | `edf-<name>-view` | `apps/view` | build command `node build.mjs` (commit `apps/view/api/*.js` too, see FREE-TIER §15 notes) |
   | `edf-<name>-keys` | `apps/keys` | one function |
   For all three: Node 24.x, region `iad1`, **OIDC Team issuer mode** on, Standard deployment protection, environment variables of the **Secret** type with "Separate Production Secret Values" on. **Never add a Vercel API token.**

   In `edf-<name>`, open Settings → Environment Variables and make sure **"Automatically expose System Environment Variables"** is ticked (it is for new projects; if you change it, redeploy). Vercel then tells the app it runs on Vercel (`VERCEL=1`). The app counts its own Vercel usage either way, so the free-tier limits can't be overrun unnoticed, but it **refuses to start** without that variable and says so in the function logs (`VERCEL is not set: … turn on "Automatically expose System Environment Variables" and redeploy`).

   **Firewall** (each project → Firewall → Custom rules; Hobby allows 3 custom rules per project, only one of them a rate-limit rule; details in `FREE-TIER.md` §8.4):
   - `edf-<name>`: a rate-limit rule on all paths except `/api/inngest`, `/api/cron/*`, `/api/view-source`, `/api/view-stats` and `/api/keys-audit`, 120 requests/min per IP with a persistent block; plus two Deny rules for scanner paths (`/wp-*`, `/.env`, `*.php`, `/xmlrpc`).
   - `edf-<name>-view`:
     1. a rate-limit rule with **no path condition** (all requests), 2,000 requests per 60 s per IP, action Deny. Why this number: every gallery card loads its email plus up to 6 of its images (cards use the viewer's "card" mode; browsers ignore lazy image loading inside the script-free viewer frame, so without it every image would load), so a page of 30 cards is at most 30 × 7 = 210 requests, and skimming a page every 30 s is about 420 a minute; opening a design loads all of its images (about 21 requests). 2,000 leaves room for several people on one home network. Revisits come from the browser cache and cost nothing. Arithmetic in `FREE-TIER.md` §8.4;
     2. a custom rule: **Deny** when the request path starts with `/api/`;
     3. optional: a custom rule to **Deny** paths that contain `%2e`, `%2E`, `%2f`, `%2F`, `%5c`, `%5C` or `//`.
   - `edf-<name>-keys`:
     1. a rate-limit rule with **no path condition** (all requests), about 30 requests/min per IP, action Deny (the project serves only `/unwrap`; a rule on `/unwrap` alone would not see direct `/api/unwrap` calls);
     2. a custom rule: **Deny** when the request path starts with `/api/`.
7. **Keys and the render snapshot** — run `pnpm exec tsx packages/crypto/scripts/gen-keys.ts` (without `--dev`) and paste each value into the project the script names. The master key (`TOKEN_KEKS`) goes **only** into `edf-<name>-keys`.

   Then build the Sandbox snapshot the emails are rendered in (without it the app never renders an email and design scores stay on the static checks). First do the day-1 check in `FREE-TIER.md` §11 step 7 (how the snapshot storage limit is counted). Then, from the repo root (needs the Vercel CLI: `pnpm add -g vercel`, signed in with `vercel login`):
   ```bash
   (cd apps/web && vercel link && vercel env pull .env.vercel --environment=development)   # link to edf-<name>; saves a short-lived VERCEL_OIDC_TOKEN (ignored by git)
   pnpm --filter @edf/render build                                                        # builds packages/render/dist/render.js
   (set -a; . apps/web/.env.vercel; set +a; pnpm --filter @edf/render render-vm:snapshot)  # can take up to 30 minutes
   ```
   The last line printed is `SANDBOX_SNAPSHOT_ID=…`: keep it for step 8. The script also runs the font smoke test and the network-blocked probe (it stops with an error if either fails) and the Chromium sandbox check: make sure it printed `chromium-sandbox:on`. Delete `apps/web/.env.vercel` afterwards. Each deploy also rebuilds `render.js` (the `edf-<name>` build does it before `next build`), and the app writes that copy into every render VM, so app and VM code stay in step.
8. **Environment variables** (production) — see the table in `FREE-TIER.md` §11 step 8. `SANDBOX_SNAPSHOT_ID` (edf-app) is the value from step 7, and `INNGEST_SERVE_ORIGIN` (edf-app) is from step 5. For the machine-to-machine checks use:
   - `OIDC_ISSUER=https://oidc.vercel.com/<team-slug>` (all projects),
   - audiences `VIEW_SOURCE_AUD`, `VIEW_STATS_AUD`, `KEYS_AUDIT_AUD` (edf-app), `APP_VIEW_SOURCE_AUD` (edf-view) and `KEYS_AUD` (edf-keys) all set to `https://vercel.com/<team-slug>` (the function token's default audience),
   - subjects `owner:<team>:project:<project-name>:environment:production` for `VIEW_OIDC_SUB`, `KEYS_OIDC_SUB` (edf-app) and `APP_OIDC_SUB` (edf-keys).
9. **Deploy.** **Order: `edf-<name>-view` first, then `edf-<name>-keys`, then `edf-<name>`.** The viewer checks the shape of the app's view tokens itself, so an app that starts minting a new kind (like the gallery's `card` previews) before the viewer knows it gets `403` on every preview — "Preview unavailable" on every card — until the viewer is deployed (FREE-TIER.md §9.3). First, on each new `edf-<name>-view` preview deploy, open `/v/test/test` on the preview URL. A `404` means the function isn't seeing the original `/v/...` path, and every real link would fail. On a preview a `503` is the **expected** answer: previews have no viewer settings, which hides the path check. (If you did give the preview settings, a real `/v` link still answers `403`, because the app only accepts the production viewer; that also means the path was seen.) A preview can never show an email, so finish the check on production: right after promoting, `/v/test/test` on the production viewer must answer `400` (the function saw the path and rejected the made-up link), and once Gmail is connected, open a real `/v` link from the app and confirm the email shows. Then open `/api/v` and confirm the firewall blocks it (no line in the function logs). Do the same for `edf-<name>-keys`: on its preview deploy, open the preview URL (signed in to Vercel), and in the browser console run `fetch('/unwrap', {method: 'POST'}).then(r => r.status)`. It must print `401` (the function saw `/unwrap` and refused the missing token); `404` means the function isn't seeing the original `/unwrap` path, and every real unwrap would fail (`503` means the preview has no key settings, which hides the path check: then run it on the production URL right after promoting, before connecting a mailbox). Then run the same with `/api/unwrap` and confirm the firewall blocks it (no line in the function logs). Repeat this on each new `edf-<name>-keys` preview deploy. Then sign in with Google, connect Gmail and watch the import. The app refuses to start if its database role could bypass the security rules, if a Vercel API token is present, or if development switches are on.
10. **Week 1** — do the checks in `FREE-TIER.md` §13 (Sandbox snapshot storage first), then invite your friend from Settings → Invites.
