# Text Definition Labeler

Web-based review + correction tool for OCR-extracted text/definition pairs. Sibling to the inference pipeline in `../OCR-Cursive-Scanner/`. The scanner produces predictions; this app lets a small team review them, mark accept/reject/no-OUV, edit text + gloss, and export the validated set as xlsx for analysis.

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
  source, created_at, updated_at
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
| POST | `/api/export` | download xlsx of all accepted entries |
| POST | `/api/export/page/:page` | download xlsx of one page's accepted entries |

Both export endpoints stream xlsx directly as `Content-Disposition: attachment` — nothing written to server disk.

## Importing existing JSON state

The OCR scanner produces `output/page_NNN_inference/results.json` and `review.json` files locally. To migrate an existing review session into this DB-backed app, write a one-shot import script (TODO: `scripts/import-from-json.ts`) that reads those files and inserts rows. Then point this app at the same Postgres and the data shows up in the UI.

## Deploy to Vercel

1. Push this repo to GitHub
2. Connect to Vercel
3. Set env vars in project settings: `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `PAGE_IMAGES_BASE_URL`
4. Deploy
5. Inference itself stays local — it needs a GPU. Run inference on your machine, then write results into the Postgres that Vercel reads.
