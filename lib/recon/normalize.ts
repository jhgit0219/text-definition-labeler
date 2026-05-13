/**
 * Text/gloss canonicalization. The Python counterpart lives at
 * `bisaya-reconstruction/service/app/core/normalize.py` and MUST produce
 * the same outputs — the cache key on the reconstructions table relies on
 * byte-identical normalization between the two sides.
 *
 * Parity fixtures: `lib/recon/__tests__/normalize.fixture.json` (same set
 * the Python tests use).
 */
export function normalizeText(s: string | null | undefined): string {
  if (s == null) return "";
  return s.trim();
}

export function normalizeGloss(s: string | null | undefined): string {
  if (s == null) return "";
  return s.trim().replace(/\s+/g, " ");
}
