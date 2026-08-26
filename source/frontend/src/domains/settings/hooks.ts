// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type ConfigSection,
  type SectionData,
  SettingService,
} from "./service";

const CONFIG_STALE_TIME = 5 * 60 * 1000; // 5 minutes (matches backend SSM cache)

/**
 * Reads the full configuration: all six sections (each with its audit
 * envelope) plus the read-only deploy-time fields. Keyed on
 * `["configurations"]`; the per-section query below uses `["configurations",
 * <section>]`, so a section save invalidates both via the shared prefix.
 */
export const useGetConfigurations = () => {
  return useQuery({
    queryKey: ["configurations"],
    queryFn: async () => await new SettingService().getConfigurations(),
    staleTime: CONFIG_STALE_TIME,
  });
};

/**
 * Read a single config section (used by the per-section Reload action).
 *
 * `enabled` defaults to `true` but can be turned off so the query does not fire
 * until the caller is ready (e.g. an on-demand Reload). Passing a falsy section
 * also disables the query rather than issuing a request for an invalid key.
 */
export const useGetConfigurationSection = (
  section: ConfigSection,
  options?: { enabled?: boolean },
) => {
  return useQuery({
    queryKey: ["configurations", section],
    queryFn: async () =>
      await new SettingService().getConfigurationSection(section),
    staleTime: CONFIG_STALE_TIME,
    enabled: (options?.enabled ?? true) && !!section,
  });
};

/**
 * Full-replacement save for a single section.
 *
 * On success, invalidates the entire `["configurations"]` prefix so every
 * dependent read refetches: the all-sections read (`["configurations"]`, used
 * by Admin Settings and the lease/leaseTemplate/blueprint pages) and this
 * section's per-section read (`["configurations", <section>]`).
 *
 * On a 409 conflict the mutation rejects with the `ApiError` thrown by
 * `ApiProxy` (carrying `statusCode === 409`) and performs no invalidation or
 * refetch. The calling form is responsible for surfacing the conflict and
 * offering an explicit Reload, per the design (no auto-refetch).
 */
export const usePutConfigurationSection = <T extends ConfigSection>(
  section: T,
) => {
  const client = useQueryClient();
  return useMutation<SectionData<T>, Error, unknown>({
    mutationFn: async (data: unknown) =>
      await new SettingService().putConfigurationSection(section, data),
    onSuccess: () => {
      // Prefix match: invalidates ["configurations"] and
      // ["configurations", <section>] in one call.
      client.invalidateQueries({
        queryKey: ["configurations"],
        refetchType: "all",
      });
    },
  });
};
