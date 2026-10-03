# Email Design Filter (working name)

An app that connects to your Gmail (read-only) and turns the designed emails you receive —
newsletters, promotions, product updates — into a gallery you can browse and learn from.

## What it does

- **Gallery of your real emails.** Every designed email from your Gmail shows up as a card with a
  preview of how it actually looks.
- **A verdict on each design: Good, Okay or Bad**, with a score out of 100. Open a card to see the
  email at desktop and phone size, plus a **"How we judged this"** panel that says, in plain words,
  which rule decided the verdict and what the email did well or badly (with the measured value and
  the limit it was held to).
- **Filters.** Show only Good or only Bad designs, pick an email type or a font, search by brand,
  subject or words, and sort by newest, best or worst design.
- **Live updates.** New emails are fetched, analysed and added while the app is open; a "new
  designs" button appears at the top of the gallery when there is something new.
- Also: an inbox view, a sender list, insights and a daily summary ("Today").

Your Gmail is only ever read, never changed. Emails are shown on a separate, locked-down site so
nothing in them can run code or track you.

## Run it on your computer

First-time setup (installing, the database, the `.env.local` files and keys) is in
[`docs/SETUP.md`](docs/SETUP.md), part 1. After that, every time:

**Terminal 1** — the database and the app (web app, email viewer and key service):

```bash
pnpm db:up && pnpm dev
```

**Terminal 2** — the background jobs (fetching mail, analysing and rendering emails):

```bash
pnpm dev:jobs
```

Then open http://localhost:3000.

Locally, the app doesn't count usage against the free-tier limits, so testing never slows it
down. To test the usage limits themselves, add `EDF_METER_LOCAL=1` to `apps/web/.env.local` and
restart the app (details in [`docs/SETUP.md`](docs/SETUP.md), "Usage metering on your computer").

Checks before deploying: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

## Put it online

Follow [`docs/SETUP.md`](docs/SETUP.md), part 2. It uses free tiers only (Vercel, Neon, Inngest),
plus Claude (Opus 5) paid from prepaid credits with a hard monthly cap.

## How it's put together

Three small Vercel projects, so no single one holds everything:

| App         | Job                                                                        |
| ----------- | -------------------------------------------------------------------------- |
| `apps/web`  | The app you use: sign-in, gallery, inbox, filters, scores, background jobs |
| `apps/view` | Shows each email on a separate site, sandboxed and without scripts         |
| `apps/keys` | Unwraps the keys that protect your Gmail access, and nothing else          |

The shared code lives in `packages/` (database, Gmail, email parsing and classification, the
design score, rendering, the job pipeline, the free-tier budget, the HTML sanitizer, encryption
and safe fetching).

## Documents

| Document                                           | What it covers                                          |
| -------------------------------------------------- | ------------------------------------------------------- |
| [`docs/SETUP.md`](docs/SETUP.md)                   | Running it locally, and putting it online on free tiers |
| [`docs/FREE-TIER.md`](docs/FREE-TIER.md)           | What is built: the free-tier edition and its limits     |
| [`docs/DESIGN.md`](docs/DESIGN.md)                 | Full system design                                      |
| [`docs/DESIGN-SCORE.md`](docs/DESIGN-SCORE.md)     | How emails are scored and judged                        |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md)         | Database schema, security rules, retention              |
| [`docs/RESEARCH-NOTES.md`](docs/RESEARCH-NOTES.md) | Facts checked live, with sources                        |

Each package's `DECISIONS.md` records where the code interprets or deviates from the docs.

**Stack:** Next.js 16 · React 19 · TypeScript 6 · Node 24 · Tailwind 4 · Postgres 18 (Neon) ·
Inngest · Claude Opus 5 · headless Chromium.
