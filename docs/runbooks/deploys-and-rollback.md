# Runbook: suspected bad deploy

**Symptoms:** a new error type appears at a specific time; the start lines up with a deploy.

1. Line it up. Get recent deploys and compare each deploy time with the first occurrence of the new errors. Correlation in time is a lead, not proof: confirm the failing code path belongs to the deployed service.
2. Read the change description and diff. Look for contract changes: renamed fields, new required fields, changed message formats between a producer and its consumers.
3. Check consumers. A producer deploy can break a different function or service that reads its messages.
4. Roll back the deploy if it is the likely cause. Rolling back is cheap; diagnosing in production is not.
5. Redrive anything that landed in a dead-letter queue after the rollback.
