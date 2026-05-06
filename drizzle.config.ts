import type { Config } from "drizzle-kit";
import { loadEnvConfig } from "@next/env";

// drizzle-kit runs as a standalone CLI and doesn't auto-load .env.local the
// way `next dev` does. Use Next.js's own loader so we read the same files
// (.env, .env.local, .env.development.local, ...) in the same priority order.
loadEnvConfig(process.cwd());

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (set it in .env.local)");
}

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
} satisfies Config;
