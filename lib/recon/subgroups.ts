/**
 * Canonical display order for the five major Austronesian branches
 * the ACD tags reflexes with. Roughly west-to-east / parent-to-daughter:
 * Formosan (oldest, Taiwan) → Western MP (Philippines, Indonesia,
 * mainland SE Asia) → Central MP (eastern Indonesia) → SHWNG (Halmahera,
 * West New Guinea) → Oceanic.
 */
export const SUBGROUP_ORDER = [
  "Formosan",
  "WMP",
  "CMP",
  "SHWNG",
  "OC",
] as const;

export const SUBGROUP_LABELS: Record<string, string> = {
  Formosan: "Formosan",
  WMP: "Western Malayo-Polynesian",
  CMP: "Central Malayo-Polynesian",
  SHWNG: "S. Halmahera–W. New Guinea",
  OC: "Oceanic",
};

/**
 * Bucket reflexes by `subgroupCode`, returning groups in the canonical
 * order with unknown / blank codes as a final "Other" bucket. Order of
 * reflexes within a group is preserved (callers feed the list in the
 * order they want, typically by ACD position).
 */
export function groupBySubgroup<T extends { subgroupCode?: string | null }>(
  reflexes: T[],
): Array<{ code: string; label: string; reflexes: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const r of reflexes) {
    const code = (r.subgroupCode || "").trim() || "Other";
    if (!buckets.has(code)) buckets.set(code, []);
    buckets.get(code)!.push(r);
  }
  const result: Array<{ code: string; label: string; reflexes: T[] }> = [];
  for (const code of SUBGROUP_ORDER) {
    const rs = buckets.get(code);
    if (rs && rs.length > 0) {
      result.push({ code, label: SUBGROUP_LABELS[code] ?? code, reflexes: rs });
    }
  }
  // Any extra codes the ACD invented (rare) get appended in insertion order.
  for (const [code, rs] of buckets) {
    if (SUBGROUP_ORDER.includes(code as (typeof SUBGROUP_ORDER)[number])) {
      continue;
    }
    if (rs.length > 0) {
      result.push({ code, label: SUBGROUP_LABELS[code] ?? code, reflexes: rs });
    }
  }
  return result;
}
