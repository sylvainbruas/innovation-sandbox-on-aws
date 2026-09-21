// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PrincipalSearchType } from "@amzn/innovation-sandbox-shared/types/principal.js";

import { registerApiSingletonReset } from "../../helpers/apiSingletons";
import type { PrincipalSearchResponse } from "./model";
import {
  createPrincipalClient,
  type SmithyPrincipalApi,
  SmithyPrincipalClient,
} from "./smithy-client";

export class PrincipalService {
  constructor(private readonly api: SmithyPrincipalApi) {}

  async getPrincipals(
    type: PrincipalSearchType,
    query = "",
    limit = 20,
    exact = false,
  ): Promise<PrincipalSearchResponse> {
    return this.api.searchPrincipals(type, query, limit, exact);
  }
}

let principalService: PrincipalService | undefined;

export function getPrincipalService(): PrincipalService {
  principalService ??= new PrincipalService(
    new SmithyPrincipalClient(createPrincipalClient()),
  );
  return principalService;
}

registerApiSingletonReset(() => {
  principalService = undefined;
});
