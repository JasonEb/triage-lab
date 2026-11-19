# Runbook: DynamoDB throttling

**Symptoms:** `ProvisionedThroughputExceededException` / throttled writes, retries, rising latency, some writes failing after retries.

1. Is it the table or one partition? If throttling is concentrated on one partition key, it is a hot partition: total capacity may be fine.
2. What changed in the write pattern? A batch job, backfill, or a new feature writing many items with the same key at once.
3. Mitigate: slow the batch down, add jitter, or spread writes (write sharding on the key). Switching to on-demand capacity helps total throughput but not a single hot key beyond per-partition limits.
4. Recover: make sure failed writes are retried (dead-letter queue redrive) and that no orders were silently dropped.
