import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db, schema } from "../lib/db";
import { gte } from "drizzle-orm";

async function main() {
  const rows = await db
    .select({
      id: schema.reconstructions.id,
      text: schema.reconstructions.text,
      gloss: schema.reconstructions.gloss,
      computedAgainstState: schema.reconstructions.computedAgainstState,
      computedAt: schema.reconstructions.computedAt,
    })
    .from(schema.reconstructions)
    .where(gte(schema.reconstructions.id, 45))
    .orderBy(schema.reconstructions.id);
  for (const r of rows) {
    console.log(
      `id=${r.id} text=${JSON.stringify(r.text)} gloss=${JSON.stringify(r.gloss)} state=${r.computedAgainstState}`,
    );
  }
  process.exit(0);
}
main();
