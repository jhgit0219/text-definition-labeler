import { loadEnvConfig } from "@next/env";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Ensure .env.local (and friends) are loaded BEFORE we read DATABASE_URL.
// In a `next dev` / `next start` runtime Next.js has already loaded these,
// so this call is a no-op. In standalone scripts (drizzle-kit, tsx scripts/*)
// it does the actual work — fixes ESM import hoisting where a top-level
// loadEnvConfig() call in the script runs AFTER `import "../lib/db"`.
loadEnvConfig(process.cwd());

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// `postgres` works in serverless and long-lived servers. For Vercel
// serverless functions, each cold start opens a connection but Neon's
// pgbouncer handles the pooling. For local dev, a single connection is fine.
const queryClient = postgres(process.env.DATABASE_URL, {
  prepare: false, // required for some serverless Postgres providers (e.g. Neon)
});

export const db = drizzle(queryClient, { schema });
export { schema };
