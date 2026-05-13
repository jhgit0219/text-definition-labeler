# Text Definition Labeler

Web-based review + correction tool for OCR-extracted text/definition pairs from Tomás de San Jerónimo's 1729 Bisaya manuscript. Sibling to the inference pipeline in `../OCR-Cursive-Scanner/` (text/gloss prediction) and `../bisaya-reconstruction/` (PMP/PAn cognate reconstruction). The scanner produces predictions; this app lets a small team review them, edit text + gloss, accept/reject/no-OUV them, attach PMP cognate picks per accepted entry, and export the validated set as xlsx for analysis.

## Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- PostgreSQL via [Drizzle ORM](https://orm.drizzle.team) — works against Neon, Supabase, Railway, or any standard Postgres
- NextAuth (Credentials provider) — single shared admin login from env vars
- ExcelJS for xlsx generation streamed as browser downloads

## Setup

```bash
npm install
cp .env.example .env.local
# fill in DATABASE_URL, NEXTAUTH_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD
npm run db:push       # creates the entries table
npm run dev           # http://localhost:3000
```

Generate `NEXTAUTH_SECRET` once via `openssl rand -base64 32` (any tool that emits random base64 works).

## Page images

The review UI shows the source page render with the current entry's bbox highlighted. In dev, drop the rendered PNGs into `public/pages/` as `p023.png`, `p024.png`, etc. — the `/api/page-image/[page]` route serves them directly.

In production, set `PAGE_IMAGES_BASE_URL` to a Vercel Blob / S3 / Cloudflare R2 URL that serves `p{NNN}.png` filenames. The route redirects there instead of bundling the images into the deployment.

## Data shape

```sql
entries (
  id, page, entry_idx,
  text,             -- current accepted/edited Bisaya headword
  gloss_raw,        -- current accepted/edited gloss (period-separated string)
  glosses,          -- TEXT[] — gloss split into array elements
  state,            -- 'pending' | 'accepted' | 'rejected' | 'no_ouv'
  edited,           -- true if user changed text or gloss vs the model's prediction
  is_multi_region,
  pred_text_raw, pred_gloss_raw,
  snapped_from,     -- pre-dict-snap prediction, if any
  bbox_regions,     -- JSONB: [{page, bbox: [x,y,w,h]}, …]
  source,           -- 'qwen_v2' | 'gemini' | 'spreadsheet_v1' | ...
  notes,            -- annotator commentary (per entry)
  spreadsheet_protos, -- JSONB: {pan, pmp, pcph, pb, status, notes} from schwa spreadsheet, nullable
  created_at, updated_at
)

reconstructions (        -- AI ranking cache, keyed by text + gloss
  id, text, gloss,
  model_id, prompt_version, schema_version,
  rankings,              -- JSONB: ranked candidate list (RankedResult shape)
  status, error_msg, computed_at,
  UNIQUE (text, gloss, model_id, prompt_version)
)

entry_reconstruction_picks (  -- annotator's selected cognate(s) per entry
  id, entry_id (FK), reconstruction_id (FK, nullable for manual picks),
  pidno, proto_form, is_primary,
  source,                -- 'ai' | 'manual'
  created_at,
  UNIQUE (entry_id, pidno)
)

acd_reconstructions (    -- full ACD corpus, ~12K rows
  pidno (PK), proto_code, form, form_plain, gloss_text, set_num, first_letter
)

acd_reflexes (           -- daughter-language reflexes, ~107K rows
  id (PK), pidno (FK), subgroup_code, language_name, form, form_plain,
  gloss_text, position
)
```

Use the `glosses` array column for Postgres queries like:

```sql
SELECT text, glosses FROM entries WHERE 'Curtir' = ANY(glosses);
```

After running migrations, also create the GIN index manually for fast array search:

```sql
CREATE INDEX entries_glosses_gin ON entries USING GIN (glosses);
```

## Auth model

Single admin login. Username + password are env vars (server-only — never exposed to the browser). NextAuth signs an HttpOnly JWT cookie and `middleware.ts` blocks every route except `/login` and `/api/auth/*` for unauthenticated requests.

To upgrade later to per-user auth: replace `lib/auth.ts`'s Credentials `authorize()` with a database lookup against a `users` table holding bcrypt-hashed passwords. The rest of the app doesn't change.

## API surface

| Method | Path | What |
|---|---|---|
| GET | `/api/pages` | list pages with state counts |
| GET | `/api/entries?page=N` | list entries on a page |
| PATCH | `/api/entries/:id` | update text / gloss / state |
| GET | `/api/page-image/:page` | serve / redirect to page render |
| POST | `/api/export[?picks_only=1]` | download xlsx of all accepted entries with their picks |
| POST | `/api/export/page/:page[?picks_only=1]` | download xlsx of one page's accepted entries |
| GET | `/api/recon/:entry_id` | reconstruction cache lookup; includes entry, picks, spreadsheet protos |
| POST | `/api/recon/:entry_id[?force=1]` | "Attempt with AI" (gated by feature flag); `force=1` replaces existing |
| PUT | `/api/recon/:entry_id/picks` | replace pick set + notes transactionally |
| POST | `/api/recon/:entry_id/picks/append` | append a single manual pick (from /dictionary) |
| GET | `/api/acd/prefixes` | histogram of 2-letter prefixes in the corpus |
| GET | `/api/acd/prefix/:prefix[?layers=PMP,PAN]` | rows for a prefix |
| GET | `/api/acd/reconstruction/:pidno` | one row + all its reflexes |
| GET | `/api/acd/search?q=…[&layers=…]` | corpus-wide search across form / gloss / proto-code |

Both export endpoints stream xlsx directly as `Content-Disposition: attachment` — nothing written to server disk. Export columns include `Primary proto`, `Alt protos`, `Notes`, `Pidnos` joined per entry.

## Reconstruction workflow

The right-side 4th panel of `/review` shows ranked PMP cognate candidates for each accepted entry. Candidates come from a cache (`reconstructions` table) populated by:

1. **Seed prefill** — the sibling `bisaya-reconstruction` repo computed 44 reconstructions offline (Claude conversation agents) and migrated them into Postgres via `bisaya-reconstruction/service/scripts/migrate_sqlite_to_postgres.py`.
2. **Schwa spreadsheet import** — `bisaya-reconstruction/service/scripts/import_spreadsheet.py` pushed 568 accepted text-gloss pairs (with their multi-layer proto-form metadata) into `entries`.
3. **ACD corpus import** — `bisaya-reconstruction/service/scripts/import_acd_to_postgres.py` loaded the full 12K-reconstruction / 107K-reflex corpus into `acd_reconstructions` + `acd_reflexes` so the dictionary browse view works without a Python service running.

Annotators can:

- Check AI-ranked candidates and mark a primary via the candidate list.
- Click "Browse the full ACD →" to open a drawer over /review and pick any reconstruction from the corpus (manual picks, marked with `source='manual'`).
- Add freeform notes per entry.
- Save all picks + notes transactionally.

"Attempt with AI" enqueues a job in the `recon_jobs` Postgres table. A separate worker (`claude-batch-runner` in worker mode, see `docs/operations/run-recon-worker.md`) polls the table, runs `claude -p`, and writes rankings back. The panel polls the job until it lands.

## Importing existing JSON state

The OCR scanner produces `output/page_NNN_inference/results.json` and `review.json` files locally. To migrate an existing review session into this DB-backed app, write a one-shot import script (TODO: `scripts/import-from-json.ts`) that reads those files and inserts rows. Then point this app at the same Postgres and the data shows up in the UI.

## Deploy to Vercel

1. Push this repo to GitHub
2. Connect to Vercel
3. Set env vars in project settings:
   - `DATABASE_URL` — Postgres connection string (Neon / Supabase / Vercel Postgres)
   - `NEXTAUTH_SECRET` — `openssl rand -base64 32`
   - `NEXTAUTH_URL` — production URL (leave unset on Vercel; it auto-fills)
   - `ADMIN_USERNAME` + `ADMIN_PASSWORD` — shared login
   - `PAGE_IMAGES_BASE_URL` — Vercel Blob / S3 / R2 base URL for page PNGs
4. Run `npm run db:migrate` once locally (Vercel doesn't auto-migrate). The migrations under `drizzle/` are additive + idempotent — re-runs are safe.
5. (Optional) Seed reconstructions: import the schwa spreadsheet and ACD corpus via the scripts in `../bisaya-reconstruction/service/scripts/`. See that repo's README.
6. Deploy. The dictionary browse + cached AI reconstructions work without a worker; new "Attempt with AI" jobs just sit in `recon_jobs` until a worker runs.
7. Inference itself stays local — it needs a GPU. Run inference on your machine, then write results into the Postgres that Vercel reads.
