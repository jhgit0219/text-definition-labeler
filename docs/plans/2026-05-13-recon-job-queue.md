# Reconstruction Job Queue (Pattern B + Local Spool)

**Date:** 2026-05-13
**Status:** Plan, not yet implemented
**Repos affected:** `text-definition-labeler`, `claude-batch-runner`
**Skip:** `bisaya-reconstruction` (not git-tracked; service/ scripts already cover the data side)

## Goal

When an annotator clicks "Attempt with AI" in the labeler:

1. The labeler **enqueues** a job in Postgres and returns immediately.
2. A worker (`claude-batch-runner` in worker mode) **picks up** the job, spawns `claude -p`, writes the result back to Postgres.
3. The labeler **polls** the job's status; the recon panel renders queued / running / done / error states.
4. Auth flows through the Claude Code Max subscription — no Anthropic API key.

The queue is **persistent** (rows in Postgres). A **local spool** on the worker host catches results that finished but couldn't be written to Postgres during an outage, so a Postgres outage that lasts longer than the worker's lifetime doesn't cost duplicate Claude-Code compute.

## Why this architecture

| Concern | This design |
|---|---|
| 5 concurrent annotators | Postgres queue handles burst; worker serializes |
| Browser close mid-wait | Job state lives in Postgres; annotator sees correct state on return |
| Worker process restart | Zombie-cleanup on startup; jobs requeued, no re-click |
| Postgres outage | Worker holds `claude -p` mid-run; result spooled to disk on write failure; flushed when DB returns |
| Worker dies during outage | Spool survives on disk; next boot flushes pending writes before zombie cleanup |
| Multiple workers | Not yet — single-worker assumption simplifies recovery |

Not used: Redis (overkill at this scale), in-memory-only queue (loses jobs on restart).

## High-level architecture

```
┌──────────────────┐    POST /api/recon/N    ┌─────────────────┐
│  Labeler client  │ ───────────────────────▶│  Labeler Next.js │
└──────────────────┘  202 {job_id, status}   │                  │
        │                                    │  INSERT INTO     │
        │  poll: GET /api/recon/N            │   recon_jobs     │
        │                                    └────────┬─────────┘
        │                                             │
        │                                             ▼
        │                                    ┌─────────────────┐
        │                                    │   Postgres      │
        │                                    │                 │
        │                                    │ recon_jobs:     │
        │                                    │   pending → running → done
        │                                    │                 │
        │                                    └────────▲────────┘
        │                                             │
        │                                    ┌─────────────────┐
        │                                    │ claude-batch-   │
        │                                    │ runner worker   │
        │                                    │                 │
        │                                    │ loop:           │
        │                                    │   SELECT FOR    │
        │                                    │   UPDATE SKIP   │
        │                                    │   LOCKED        │
        │                                    │   spawn claude-p│
        │                                    │   UPDATE result │
        │                                    │   else: spool[] │
        │                                    └─────────────────┘
```

## Data model

### New table: `recon_jobs`

```sql
CREATE TABLE recon_jobs (
  id              serial PRIMARY KEY,
  entry_id        integer NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  text            text NOT NULL,
  gloss           text NOT NULL,
  entry_state     varchar(16) NOT NULL,         -- captured at enqueue time
  status          varchar(16) NOT NULL DEFAULT 'pending',
                                                -- pending | running | done | error
  result          jsonb,                        -- the rankings payload on success
  error_kind      varchar(64),
  error_message   text,
  worker_id       text,                         -- the worker that picked it up
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  -- Re-enqueue an entry only after the previous job for it has settled.
  -- An UNIQUE index over (entry_id) WHERE status IN ('pending','running')
  -- enforces "one active job per entry" without preventing historical rows.
);
CREATE UNIQUE INDEX recon_jobs_active_per_entry
  ON recon_jobs (entry_id)
  WHERE status IN ('pending', 'running');
CREATE INDEX recon_jobs_status_idx ON recon_jobs (status);
```

Drizzle schema entry mirrors this. Migration is additive only.

### Existing `reconstructions` table

Stays the same. When a worker finishes a job:
1. INSERT into `reconstructions` (text, gloss, model_id, prompt_version, rankings, computed_against_state, ...) — same path the iter-5 ingest uses
2. UPDATE the `recon_jobs` row: status='done', result=<rankings payload>, finished_at=now()
3. Both in a single transaction so a partial commit can't happen

## API surface (labeler)

### Modified: `POST /api/recon/[entry_id]`

Today this either returns 409 (cached) or fires the Python service synchronously. New behavior:

1. Look up entry → text, gloss, state.
2. Check `reconstructions` cache (existing logic). If a `done` row exists → return 409 `{message: "cached", reconstruction: {...}}`. (Same as today; no enqueue.)
3. Check `recon_jobs` for an active job (`pending` or `running`) for this entry:
   - If exists → return 202 `{job_id, status, position, message: "already queued"}`.
4. Otherwise INSERT a new `recon_jobs` row with status='pending'.
   - On the UNIQUE-violation race (someone else just enqueued), fall back to the existing row.
5. Return 202 `{job_id, status: "pending", position: N, enqueued_at}` where N is the row's place in the queue (computed via `SELECT COUNT(*) FROM recon_jobs WHERE status IN ('pending', 'running') AND id <= self`).

### New: `GET /api/recon/[entry_id]/job`

Returns the **current** active job for an entry, or null. Used by the recon panel to poll while a job is running.

```ts
{
  job: {
    id: number,
    status: "pending" | "running" | "done" | "error",
    position: number | null,           // null once status != "pending"
    enqueued_at: string,
    started_at: string | null,
    finished_at: string | null,
    error_message: string | null,
  } | null
}
```

Once status flips to `done`, the panel switches to fetching the actual rankings from `GET /api/recon/[entry_id]` (cache hit).

### Modified: `GET /api/recon/[entry_id]`

Return shape extended:

```ts
{
  entry: { ... },
  reconstruction: { ... } | null,
  picks: [...],
  entryNotes: string | null,
  spreadsheetProtos: { ... } | null,
  activeJob: { id, status, position } | null,    // NEW — non-null when a job is in flight
}
```

The recon panel can render the queue state without a second round-trip.

## Worker

New `claude-batch-runner` subcommand: `python -m claude_batch_runner worker`.

```yaml
# examples/bisaya_reconstruct/worker.yaml
name: bisaya-reconstruct-worker
prompt_path: prompt.md
database_url: env(LABELER_DATABASE_URL)   # or reuse the wrapper's --db flag
worker_id: env(HOSTNAME)                  # for log clarity
spool_dir: ./spool
claude:
  skip_permissions: true
  allowed_tools: [Bash]
  output_format: json
  timeout_seconds: 900
runner:
  poll_interval_seconds: 5
  rate_limit_backoff_seconds: 900
```

### Lifecycle

```
┌─────────────────────────────────────────┐
│ Boot                                    │
│  1. Connect to Postgres                 │
│  2. Flush spool (if any files exist):   │
│       for each spool/job_*.json:        │
│         UPDATE recon_jobs SET status='done', result=...
│         delete file on success          │
│  3. Zombie cleanup:                     │
│       UPDATE recon_jobs                 │
│       SET status='pending', started_at=NULL, worker_id=NULL
│       WHERE status='running'            │
│  4. Enter poll loop                     │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Poll loop                               │
│  every poll_interval_seconds:           │
│   BEGIN;                                │
│   SELECT * FROM recon_jobs              │
│     WHERE status='pending'              │
│     ORDER BY id ASC                     │
│     FOR UPDATE SKIP LOCKED              │
│     LIMIT 1;                            │
│   if none: COMMIT; sleep; continue;     │
│   UPDATE … SET status='running',        │
│           started_at=now(),             │
│           worker_id=$me;                │
│   COMMIT;                               │
│                                         │
│   render prompt(text, gloss) → prompt   │
│   result = run_claude(prompt)           │
│   if RateLimitError:                    │
│     UPDATE … SET status='pending';      │
│     sleep(backoff); continue;           │
│   if ClaudeCLIError:                    │
│     UPDATE … SET status='error', ...;   │
│     continue;                           │
│                                         │
│   try:                                  │
│     BEGIN;                              │
│     INSERT INTO reconstructions(...);   │
│     UPDATE recon_jobs SET status='done',│
│            result=…, finished_at=now(); │
│     COMMIT;                             │
│   except OperationalError:              │
│     spool[job.id] = result;             │
│     write spool/job_<id>.json;          │
│                                         │
│   periodically retry spool flush.       │
└─────────────────────────────────────────┘
```

### Spool semantics

- One file per pending write: `spool/job_<id>.json` containing `{job_id, result, finished_at}`.
- File written atomically (write to `.tmp`, then rename).
- On flush, each file is read, the Postgres write is attempted, the file deleted on success.
- A background coroutine retries flush every 30 s while spool is non-empty.
- On boot, flush runs BEFORE zombie cleanup so a spooled `running` job ends up as `done`, not requeued.

### Single-worker assumption

This design assumes ONE worker process across all servers. If you ever run two:

- The `FOR UPDATE SKIP LOCKED` guarantees no two workers pick the same row.
- BUT the zombie-cleanup query on boot indiscriminately resets all `running` rows — that would steal in-flight work from a live sibling worker.

To support multi-worker safely, zombie-cleanup needs to filter on stale heartbeat:

```sql
UPDATE recon_jobs
SET status='pending', started_at=NULL, worker_id=NULL
WHERE status='running'
  AND (worker_id = $me OR heartbeat < now() - interval '5 minutes');
```

Plus the worker would need to UPDATE a `heartbeat` column every minute while a job is in flight. Out of scope for v1 — single worker.

## Recon panel UI

States the panel must render:

```
NO ENTRY                        "Pick an entry from the list."
NOT ACCEPTED                    "Reconstruction appears after the entry is accepted."
CACHE HIT (existing)            full candidate card list
                                + spreadsheet reference
                                + manual picks
                                + Save / Notes / Browse ACD
CACHE MISS, NO JOB              "No reconstruction yet"
                                + [Attempt with AI]  (gated by feature flag)
                                + Browse ACD link
QUEUED (status=pending)         "Queued · position N · est ~M min"
                                + "We'll save the result when it lands"
                                + Browse ACD link still works
RUNNING (status=running)        "Running… (started Xs ago, est ~Y min)"
                                + animated progress
                                + Browse ACD link
ERROR (status=error)            error message
                                + Retry button (re-enqueues)
                                + Back to entry (clears error state)
```

Polling:

- When the panel mounts on a cache-miss with an active job, start a `setInterval` polling `GET /api/recon/[entry_id]/job` every 3 s.
- On status transition to `done`: full refetch of `GET /api/recon/[entry_id]` to load the rankings; switch to cache-hit view.
- On unmount: clear interval.

## Step-by-step build order

Sized so each step independently builds + tests.

### 1. Schema migration (labeler)
- Drizzle: add `reconJobs` table to `lib/db/schema.ts`.
- `npm run db:generate` → migration file.
- `npm run db:migrate` → applies cleanly to current DB (additive only).

### 2. Labeler API (POST/GET) — server-side queue ops only
- `POST /api/recon/[entry_id]`: enqueue logic; return 202 + job_id.
- `GET /api/recon/[entry_id]/job`: poll endpoint.
- `GET /api/recon/[entry_id]`: include `activeJob` in response.
- Tests: enqueue twice for the same entry → same job_id (UNIQUE index race-safe).

### 3. claude-batch-runner worker mode
- New `worker.py` subcommand: `python -m claude_batch_runner worker --config worker.yaml`.
- Pulls config, connects to Postgres via env `DATABASE_URL`.
- Implements: boot flush spool, boot zombie cleanup, poll loop, claim row, run claude, write result + spool fallback.
- Test: run worker against a manually-inserted `pending` row, observe it picks up and processes.

### 4. Recon panel UI
- Update `ReconstructionPanel.tsx` with the queued / running / error states.
- Add polling hook.
- Smoke: with worker running, click "Attempt with AI" → panel shows pending → running → done within a few minutes.

### 5. End-to-end test on Babuy (known cache hit)
- Force re-run via the iter-2 `?force=1` path (or temporarily delete the cached row) to trigger a fresh enqueue.
- Verify: row in `recon_jobs` flips status correctly, panel polls correctly, final result identical to existing cache.

### 6. Failure-mode rehearsal
- Kill the worker mid-`claude -p` → restart → verify zombie row gets requeued and reprocessed.
- Stop Postgres mid-run → verify `claude -p` finishes → worker spools → restart Postgres → verify flush completes the write.
- Both via the local Postgres / a docker-compose stub.

### 7. Operational doc
- `docs/operations/run-recon-worker.md`: how to start the worker, where the spool lives, what logs look like, how to drain the queue manually if needed.

## Files touched (estimate)

```
text-definition-labeler/
  lib/db/schema.ts                                   (+30)
  drizzle/0004_recon_jobs.sql                        (new)
  app/api/recon/[entry_id]/route.ts                  (~+80)
  app/api/recon/[entry_id]/job/route.ts              (new, ~60)
  lib/recon/fetch-recon.ts                           (~+30)
  components/recon/ReconstructionPanel.tsx           (~+120)
  docs/operations/run-recon-worker.md                (new)

claude-batch-runner/
  src/claude_batch_runner/worker.py                  (new, ~200)
  src/claude_batch_runner/spool.py                   (new, ~60)
  src/claude_batch_runner/cli.py                     (~+20 to add subcommand)
  examples/bisaya_reconstruct/worker.yaml            (new)
  examples/bisaya_reconstruct/README.md              (~+30 worker section)
  README.md                                          (~+15 worker docs)
```

Total: ~650 lines of code + 1 migration + 2 docs.

## Out of scope (defer)

- Multi-worker support (would need heartbeat + lease-based zombie cleanup; YAGNI at current scale)
- Cancellation (annotator clicks "cancel" → kill the running `claude -p`; not needed for v1)
- Priority queues (every job is equal priority right now)
- Job history UI (admin view of all past jobs with timing/errors; nice-to-have, separate iteration)
- Cost telemetry (track Max-quota consumption; useful but not blocking)

## Open questions

None blocking. All implementation choices in this doc are firm.
