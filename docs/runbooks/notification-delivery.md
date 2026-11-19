# Runbook: patients not receiving messages (SMS / email)

**Symptoms:** patient reports of missing texts or emails. Often there are **no errors**: the provider accepts messages and then fails to deliver them.

1. Compare "accepted" with "delivered". Delivery confirmations arrive via provider webhooks. If acceptances continue but confirmations stop, delivery is failing downstream of us.
2. Split by provider and channel. Is it SMS only? One provider only?
3. Check the provider's status page and our account (suspended number, carrier filtering, spending limit).
4. Mitigate: fail over to a backup provider or channel (email) for critical messages such as appointment confirmations.
5. Follow-up: alert on the ratio of delivered to accepted, not only on errors. Silent failures never page.
