import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

const VALID_STATES = ["pending", "accepted", "rejected", "no_ouv"] as const;

const updateSchema = z.object({
  text: z.string().optional(),
  glosses: z.array(z.string()).optional(),
  glossRaw: z.string().optional(),
  state: z.enum(VALID_STATES).optional(),
  edited: z.boolean().optional(),
});

/**
 * PATCH /api/entries/:id
 * Update text/gloss/state for one entry. Marks `edited=true` automatically
 * when text or glossRaw differs from predTextRaw / predGlossRaw.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = Number.parseInt(params.id, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const payload = updateSchema.parse(await req.json());

  // Fetch current to determine `edited` flag accurately.
  const [current] = await db
    .select()
    .from(schema.entries)
    .where(eq(schema.entries.id, id));
  if (!current) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Single source of truth: when `glosses` is provided we recompute
  // `glossRaw` from it. When only `glossRaw` is sent, we derive the array.
  // When neither is provided, both stay unchanged.
  const newText = payload.text ?? current.text;
  let newGlosses: string[];
  let newGlossRaw: string;
  if (payload.glosses !== undefined) {
    newGlosses = payload.glosses.map((g) => g.trim().replace(/\.+$/, "")).filter(Boolean);
    newGlossRaw = joinGlosses(newGlosses);
  } else if (payload.glossRaw !== undefined) {
    newGlossRaw = payload.glossRaw;
    newGlosses = splitGlossString(newGlossRaw);
  } else {
    newGlossRaw = current.glossRaw;
    newGlosses = current.glosses;
  }

  const wasEdited =
    (current.predTextRaw !== null && newText !== current.predTextRaw) ||
    (current.predGlossRaw !== null && newGlossRaw !== current.predGlossRaw);

  const [updated] = await db
    .update(schema.entries)
    .set({
      text: newText,
      glossRaw: newGlossRaw,
      glosses: newGlosses,
      state: payload.state ?? current.state,
      edited: payload.edited ?? wasEdited,
      updatedAt: new Date(),
    })
    .where(eq(schema.entries.id, id))
    .returning();

  return NextResponse.json({ entry: updated });
}

/**
 * Split a period-separated gloss string into individual gloss elements.
 * "Curtir. Ceniza." -> ["Curtir", "Ceniza"]
 */
function splitGlossString(s: string): string[] {
  return s
    .split(/\.\s*|\s*\.\s*$/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Canonical form: each gloss followed by a period, separated by single spaces.
 * ["Curtir", "Ceniza"] -> "Curtir. Ceniza."
 * Empty array -> "".
 */
function joinGlosses(glosses: string[]): string {
  const cleaned = glosses.map((g) => g.trim().replace(/\.+$/, "")).filter(Boolean);
  if (cleaned.length === 0) return "";
  return cleaned.map((g) => g + ".").join(" ");
}
