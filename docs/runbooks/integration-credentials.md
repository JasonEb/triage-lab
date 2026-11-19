# Runbook: integration credentials expired or revoked

**Symptoms:** `auth` errors (HTTP 401/403) from one integration, starting abruptly at one moment, often on the hour or at midnight UTC; other calls to the same partner that don't need that credential keep working.

1. Confirm the error is an authentication rejection, not a 5xx.
2. Find the credential (SSM Parameter Store / Secrets Manager) and check its expiry and last rotation.
3. Rotate or renew the credential, then confirm the next calls succeed.
4. Retry the failed work (dead-letter queue redrive).
5. Follow-up: add an expiry alarm so this is caught before it expires.
