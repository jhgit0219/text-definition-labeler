# Running the recon worker

The labeler enqueues reconstruction jobs in `recon_jobs`. A separate
worker process (in the `claude-batch-runner` repo) polls that table,
spawns `claude -p`, and writes the result back.

## Prerequisites

- `claude` CLI on `PATH` and logged into your Max subscription.
- `DATABASE_URL` pointing at the same Postgres the labeler uses.
- (Recommended) `WORKER_DATABASE_URL` pointing at the **direct, unpooled**
  Postgres URL. The labeler typically uses a pooled URL (Neon's `-pooler`
  hostname, Supabase pgbouncer) which silently drops LISTEN/NOTIFY. The
  worker falls back to polling without it, just slower to wake.
- The `claude-batch-runner` package installed editable:

  ```powershell
  pip install -e D:\Projects\Portfolio\Tools\claude-batch-runner
  ```

## Run

```powershell
$env:DATABASE_URL = "<your prod URL>"  # if not already set
python -m claude_batch_runner worker `
  --config D:\Projects\Portfolio\Tools\claude-batch-runner\examples\bisaya_reconstruct\config.yaml `
  --spool-dir D:\Projects\Portfolio\Tools\claude-batch-runner\spool `
  --poll-interval 5 `
  --verbose
```

Add `--once` to process a single job and exit (useful when smoke-testing
end-to-end after clicking "Attempt with AI" in the labeler).

## Boot sequence

1. Flush any spooled results from a prior outage into Postgres.
2. Reset orphaned `running` rows from a dead worker back to `pending`.
3. Enter the poll loop.

## Recovery semantics

- **Worker dies mid-job:** the `running` row is requeued on next boot
  (single-worker assumption — never run two workers against the same DB
  without first changing the zombie-cleanup query).
- **Postgres dies after Claude finishes:** the result is written to
  `spool/job_<id>.json` atomically; the next successful boot flushes it.
- **Rate limited:** the job is released back to `pending` and the worker
  sleeps `runner.rate_limit_backoff_seconds` (config default: 900s).

## Health checks

```sql
-- pending backlog
SELECT count(*) FROM recon_jobs WHERE status = 'pending';

-- jobs running longer than 30 min (suspicious)
SELECT id, entry_id, started_at
FROM recon_jobs
WHERE status = 'running' AND started_at < now() - interval '30 min';

-- recent errors
SELECT id, entry_id, error_kind, error_message, finished_at
FROM recon_jobs
WHERE status = 'error'
ORDER BY finished_at DESC
LIMIT 20;
```
