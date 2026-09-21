// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Principal as SmithyPrincipal } from "@amzn/innovation-sandbox-api-client";
import {
  IsbClient,
  SearchPrincipalsCommand,
} from "@amzn/innovation-sandbox-api-client";
import type { PrincipalSearchType } from "@amzn/innovation-sandbox-shared/types/principal.js";

import { normalizeSmithyError } from "../../helpers/isbApiClient";
import { toValidListItems } from "../../helpers/validListItems";
import { IdcPrincipalViewSchema, type PrincipalSearchResponse } from "./model";

export { createIsbClient as createPrincipalClient } from "../../helpers/isbApiClient";

export interface SmithyPrincipalApi {
  searchPrincipals(
    type: PrincipalSearchType,
    query: string,
    limit: number,
    exact: boolean,
  ): Promise<PrincipalSearchResponse>;
}

function mapPrincipal(principal: SmithyPrincipal) {
  return {
    principalId: principal.principalId,
    principalType: principal.principalType,
    displayName: principal.displayName ?? "",
    email: principal.email,
  } satisfies Record<keyof SmithyPrincipal, unknown>;
}

export class SmithyPrincipalClient implements SmithyPrincipalApi {
  constructor(private readonly client: IsbClient) {}

  async searchPrincipals(
    type: PrincipalSearchType,
    query: string,
    limit: number,
    exact: boolean,
  ): Promise<PrincipalSearchResponse> {
    try {
      const output = await this.client.send(
        new SearchPrincipalsCommand({
          type,
          limit,
          exact,
          // Preserve the pre-Smithy request shape by omitting an empty query.
          ...(query.length > 0 ? { q: query } : {}),
        }),
      );
      if (!output.data?.principals || output.data.totalMatches === undefined) {
        throw new Error("Principal search response did not contain data");
      }

      return {
        principals: toValidListItems({
          clientName: "SmithyPrincipalClient",
          getItemId: (principal) => principal.principalId,
          items: output.data.principals,
          itemType: "principal",
          mapItem: mapPrincipal,
          schema: IdcPrincipalViewSchema,
        }),
        totalMatches: output.data.totalMatches,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}
