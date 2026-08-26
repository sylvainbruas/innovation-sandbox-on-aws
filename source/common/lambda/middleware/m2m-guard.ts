// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { isSyntheticM2mEmail } from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";

/**
 * Refuses lease creation when the resolved assignee is an M2M identity. A lease
 * grants AWS Console SSO access via IAM Identity Center, which has no
 * representation for M2M synthetic identities, so the grant is impossible.
 *
 * The caller resolves who the assignee is (self vs. on-behalf-of) and passes
 * that email here; this guard only judges the email. Throws 400.
 *
 * Wired into `postLeaseHandler` only. Approve/deny/freeze/terminate/unfreeze
 * stay open to M2M Admin/Manager callers — they operate on human-assignee
 * leases.
 */
export function rejectIfAssigneeIsM2m(assigneeEmail: string): void {
  if (isSyntheticM2mEmail(assigneeEmail)) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            message: `Cannot assign a lease to ${assigneeEmail}: M2M clients cannot be assignees. A lease grants AWS Console SSO access via IAM Identity Center, which has no representation for M2M identities.`,
          },
        ],
      },
    });
  }
}
