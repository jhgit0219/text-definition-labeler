import { z } from "zod";

/**
 * Canonical TypeScript shape of the rankings payload exchanged between
 * the Python reconstruction service, the Postgres `reconstructions.rankings`
 * column, and the labeler UI. Mirrors the Pydantic models in
 * `bisaya-reconstruction/service/app/schemas/rankings.py`.
 *
 * `schema_version` lets the shape evolve without breaking already-stored
 * rows: bump the constant when the contract changes, and read paths can
 * branch on the version to migrate older payloads on the fly.
 */

export const SAMPLE_REFLEX = z.object({
  language: z.string(),
  form: z.string(),
  gloss_text: z.string(),
});

export const RANKING = z.object({
  rank: z.number().int(),
  confidence: z.number().nullable(),
  rationale: z.string(),
  is_match: z.boolean(),
  pidno: z.number().int(),
  proto_code: z.string(),
  proto_form: z.string(),
  proto_form_plain: z.string(),
  gloss_text: z.string(),
  set_num: z.number().int(),
  sample_reflexes: z.array(SAMPLE_REFLEX),
});

/**
 * Agent metadata emitted alongside the rankings array. `summary` is the
 * user-facing top-of-panel note — the AI's overall stance on the rankings
 * (e.g. "no PMP/PAn cognate found; candidates are semantic neighbors").
 * The other fields are audit data: hypotheses considered, tool-call count,
 * whether the agent escalated mid-run.
 *
 * All fields default to soft-optional in the zod schema so older
 * reconstruction rows (stored before agent_meta was wired through) parse
 * cleanly. New runs MUST emit `summary` per the prompt contract.
 */
export const AGENT_META = z.object({
  summary: z.string().optional(),
  hypotheses: z.array(z.string()).optional(),
  tool_calls: z.number().int().optional(),
  escalated: z.boolean().optional(),
});

export const RANKINGS_PAYLOAD = z.object({
  schema_version: z.number().int(),
  rankings: z.array(RANKING),
  model_id: z.string(),
  prompt_template_version: z.string(),
  agent_meta: AGENT_META.optional(),
});

export const CURRENT_SCHEMA_VERSION = 1;

export type SampleReflex = z.infer<typeof SAMPLE_REFLEX>;
export type Ranking = z.infer<typeof RANKING>;
export type AgentMeta = z.infer<typeof AGENT_META>;
export type RankingsPayload = z.infer<typeof RANKINGS_PAYLOAD>;
