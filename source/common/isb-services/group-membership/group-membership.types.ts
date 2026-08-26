// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";

import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";

/**
 * Services required by group membership cache operations.
 */
export interface GetGroupMembershipsServices {
  principalStore: PrincipalStore;
  idcService: IdcService;
  logger: Logger;
}

/** Cache TTL in days. Group memberships refresh lazily after this period. */
export const GROUP_MEMBERSHIP_CACHE_TTL_DAYS = 1;
