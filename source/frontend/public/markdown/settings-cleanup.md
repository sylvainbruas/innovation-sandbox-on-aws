---
title: Cleanup
---

Each group of settings has its own **Save** button, so you can update one group at a time. Admins can edit settings; managers can only view them. Tabs with never-saved settings show a badge with the count, so you can find and complete initial setup.

### [Cleanup](/settings#cleanup-section)

Controls for the account cleanup process: the number of successful and failed attempts, the wait time between attempts, the account cooldown period, how long cleanup reports are retained, and post-cleanup validation behavior.

**On validation failure** determines what happens when post-cleanup validation still finds resources in the account:

- **Silent** (default): skips the validation step. Accounts return to Available without an additional resource check.
- **Warn**: logs a warning and surfaces the remaining resources on the cleanup report, but still returns the account to the pool.
- **Quarantine**: moves the account aside for manual review.

Validation is experimental. Because it relies on AWS Resource Explorer, whose index can lag behind deletions, set the account cooldown to at least 168 hours (7 days) before choosing **Warn** or **Quarantine**. The cooldown runs before validation, giving the index time to catch up and avoiding false reports of remaining resources.

For more information, see [Account Cleaner components](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/architecture-details.html#account-cleaner-component) and [Resolving cleanup failures](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/troubleshooting.html#resolving-cleanup-failures) in the implementation guide.
