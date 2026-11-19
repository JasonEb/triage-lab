# Runbook: database connection pool exhaustion

**Symptoms:** `timeout` errors acquiring a connection (`DB_POOL_TIMEOUT`), rising pool waits, latency climbing for every request that touches the database.

1. Check load first. Compare request volume now with the hour before. A spike (marketing email, batch job, retry storm) is the most common cause.
2. Check hold time. Did a deploy add a slow query or hold a transaction open across a network call?
3. Look for retry amplification: async retries (EventBridge, SQS redelivery) re-send failed work and add load while the pool is saturated.
4. Mitigate: shed or rate-limit the source of load; temporarily raise the pool size only if the database has headroom (check max_connections and CPU); consider RDS Proxy.
5. Recover: after load drops, make sure failed bookings are retried or that affected patients are contacted.
