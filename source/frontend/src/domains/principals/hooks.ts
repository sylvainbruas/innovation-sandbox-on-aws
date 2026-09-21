// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";

import type { PrincipalSearchType } from "@amzn/innovation-sandbox-shared/types/principal.js";

import { getPrincipalService } from "./service";

export const PRINCIPAL_SEARCH_MIN_CHARS = 2;

export const useGetPrincipals = (
  type: PrincipalSearchType,
  query = "",
  limit = 20,
  options?: { enabled?: boolean },
) =>
  useQuery({
    queryKey: ["principals", type, query, limit],
    queryFn: async () =>
      await getPrincipalService().getPrincipals(type, query, limit),
    enabled:
      (options?.enabled ?? true) && query.length >= PRINCIPAL_SEARCH_MIN_CHARS,
    staleTime: 5 * 60 * 1000,
    // Keep results visible while the next search is in flight so the
    // typeahead dropdown does not disappear between keystrokes.
    placeholderData: keepPreviousData,
  });

/**
 * Resolve one principal by exact email (user) or group name. Exact lookup
 * triggers the server's just-in-time IDC lookup when search is disabled.
 */
export const useResolvePrincipal = () =>
  useMutation({
    mutationFn: async ({
      identifier,
      type,
    }: {
      identifier: string;
      type: "users" | "groups";
    }) => {
      const response = await getPrincipalService().getPrincipals(
        type,
        identifier,
        1,
        true,
      );
      const principal = response.principals[0];
      if (!principal) {
        throw new Error("Principal lookup returned no valid result");
      }
      return principal;
    },
  });
