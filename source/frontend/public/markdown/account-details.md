---
title: Account Details
---

View this account's current status, associated lease, and cleanup history.

---

## Cleanup overview

Shows live progress of an active cleanup and results from past cleanups. Choose a row in **Recent cleanups** to view step details and resource summary.

Admins can choose **Skip cooldown** during the cooldown phase to end the cooldown early and continue to the remaining cleanup steps.

The cooldown also gives AWS Resource Explorer time to catch up with the resources Nuke deleted. If post-cleanup validation is set to **Warn** or **Quarantine**, skipping the cooldown can cause validation to report resources that were already deleted.

---

## Actions

**Start cleanup**: Restart cleanup for Quarantine or Clean Up accounts.

**Quarantine account**: Move an account to Quarantine for manual investigation.

**Eject account**: Remove an account from the sandbox pool (unavailable during cleanup).

_Note: Actions depend on the account's current status. Admins only._

For more information, see [Managing existing accounts](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/administrator-guide.html#manage-accounts).
