# Runbook: third-party dependency failing (pharmacy, labs, payments, messaging)

**Symptoms:** errors of type `dependency` or `timeout` from one integration; retries (`*.retrying`) rising; work piling up in queues or dead-letter queues.

1. Scope it. Which partner? Is it every request or a subset (one partner of two, one region, one product)? Compare error counts before and after the start time.
2. Check whether it's us. Was there a deploy to the calling service near the start? A config or credential change? If our requests changed, the partner may be rejecting them.
3. Check the partner's status page and open a ticket with the request IDs and timestamps of a few failures.
4. Contain. If one partner of several is down, route around it if routing exists. Pause retries that amplify load. Let the dead-letter queue hold messages; do not purge it.
5. Recover. Redrive the dead-letter queue once the partner is healthy, and confirm the backlog drains.
6. Tell patient support which patients were affected (by hashed ID) and what they will see.
