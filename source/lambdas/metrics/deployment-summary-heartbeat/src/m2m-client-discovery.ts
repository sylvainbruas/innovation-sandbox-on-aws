// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  IAMClient,
  paginateListRoles,
  paginateListRoleTags,
  Role,
} from "@aws-sdk/client-iam";

import { collect } from "@amzn/innovation-sandbox-commons/data/utils.js";
import {
  buildM2mRolePrefix,
  M2M_ISB_ID_TAG_KEY,
  M2M_ROLE_NAME_INFIX,
  M2M_STACK_TYPE_TAG_KEY,
  M2M_STACK_TYPE_TAG_VALUE,
} from "@amzn/innovation-sandbox-commons/utils/m2m-role-arn.js";

/**
 * Counts deployed M2M client IAM roles for an ISB deployment, in the account
 * the `iamClient` targets. Mirrors `scripts/m2m/list-clients.sh`: page IAM
 * roles under the M2M path (`/isb-m2m/<namespace>/`, filtered server-side via
 * `PathPrefix`), name-prefilter, then keep only roles tagged
 * `isb-stack-type=M2mClient` and `isb-id=<namespace>_isb`.
 *
 * IAM `list-roles` + per-role tag fetch is used rather than
 * resourcegroupstaggingapi, which is eventually consistent for IAM (the same
 * reason the discovery script avoids it).
 */
export async function countM2mClients(
  iamClient: IAMClient,
  namespace: string,
): Promise<number> {
  const namePrefix = `${namespace}-${M2M_ROLE_NAME_INFIX}-`;
  const isbIdTagValue = `${namespace}_isb`;

  let count = 0;
  for await (const page of paginateListRoles(
    { client: iamClient },
    { PathPrefix: `/${buildM2mRolePrefix(namespace)}/` },
  )) {
    // PathPrefix scopes the listing server-side; the name-prefix check is a
    // free in-memory belt-and-suspenders so we only fetch tags for real
    // candidates. The type guard also narrows to roles that have a RoleName.
    const candidates = (page.Roles ?? []).filter(
      (role): role is Role & { RoleName: string } =>
        role.RoleName?.startsWith(namePrefix) ?? false,
    );

    // Tally sequentially: the reduce awaits the running total before starting
    // the next role, so the per-role ListRoleTags calls run one at a time.
    // Deliberately NOT Promise.all — IAM management APIs are throttled per
    // account and IAM does not publish a request-rate quota (its quota page
    // lists only object/character limits), so fanning out a call per candidate
    // risks an undocumented Throttling/RateExceeded. This is a once-a-day
    // heartbeat with few M2M roles, so serial is cheap and safe.
    // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html
    count += await candidates.reduce(
      async (runningTotal, role) =>
        (await runningTotal) +
        ((await isM2mClientRole(iamClient, role.RoleName, isbIdTagValue))
          ? 1
          : 0),
      Promise.resolve(0),
    );
  }

  return count;
}

async function isM2mClientRole(
  iamClient: IAMClient,
  roleName: string,
  isbIdTagValue: string,
): Promise<boolean> {
  const tags = await collectRoleTags(iamClient, roleName);
  return (
    tags.get(M2M_STACK_TYPE_TAG_KEY) === M2M_STACK_TYPE_TAG_VALUE &&
    tags.get(M2M_ISB_ID_TAG_KEY) === isbIdTagValue
  );
}

async function collectRoleTags(
  iamClient: IAMClient,
  roleName: string,
): Promise<Map<string, string>> {
  const pages = await collect(
    paginateListRoleTags({ client: iamClient }, { RoleName: roleName }),
  );
  // Flatten every page's tags into [key, value] entries (dropping any with a
  // missing key/value), then build the Map from them — no in-loop mutation.
  const entries = pages.flatMap((page) =>
    (page.Tags ?? []).flatMap(({ Key, Value }) =>
      Key !== undefined && Value !== undefined
        ? [[Key, Value] as [string, string]]
        : [],
    ),
  );
  return new Map(entries);
}
