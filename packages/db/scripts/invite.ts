/**
 * `pnpm --filter @edf/db invite <email> [owner|friend]` — add an address to the invite list,
 * as the owner role (FREE-TIER.md §11 step 9: "Add yourself to beta_allowlist").
 */
import pg from "pg";

const [email, role = "friend"] = process.argv.slice(2);
const ownerUrl = process.env.DATABASE_URL_OWNER;
if (!ownerUrl || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["owner", "friend"].includes(role)) {
  console.error("Usage: DATABASE_URL_OWNER=… invite <email> [owner|friend]");
  process.exit(1);
}
const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
await client.query(
  `INSERT INTO beta_allowlist (email, role, invited_by) VALUES ($1, $2, 'cli')
   ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role`,
  [email, role],
);
await client.end();
console.log(`Invited ${email} as ${role}.`);
