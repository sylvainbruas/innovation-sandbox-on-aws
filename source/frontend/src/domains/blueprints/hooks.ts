// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getBlueprintService } from "@amzn/innovation-sandbox-frontend/domains/blueprints/service";
import {
  RegisterBlueprintRequest,
  UpdateBlueprintRequest,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";

export const useGetBlueprints = () => {
  return useQuery({
    queryKey: ["blueprints"],
    queryFn: async () => await getBlueprintService().getBlueprints(),
  });
};

export const useGetBlueprintById = (blueprintId?: string | null) => {
  return useQuery({
    queryKey: ["blueprints", blueprintId],
    queryFn: async () =>
      await getBlueprintService().getBlueprintById(blueprintId!),
    enabled: !!blueprintId,
  });
};

export const useRegisterBlueprint = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (blueprint: RegisterBlueprintRequest) =>
      await getBlueprintService().registerBlueprint(blueprint),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["blueprints"],
        refetchType: "all",
      }),
  });
};

export const useUpdateBlueprint = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: UpdateBlueprintRequest;
    }) => await getBlueprintService().updateBlueprint(id, updates),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["blueprints"],
        refetchType: "all",
      }),
  });
};

export const useUnregisterBlueprint = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (blueprintId: string) =>
      await getBlueprintService().unregisterBlueprint(blueprintId),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["blueprints"],
        refetchType: "all",
      }),
  });
};

export const useUnregisterBlueprints = (options?: {
  skipInvalidation?: boolean;
}) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (blueprintIds: string[]) =>
      await getBlueprintService().unregisterBlueprints(blueprintIds),
    onSuccess: () => {
      if (!options?.skipInvalidation) {
        client.invalidateQueries({
          queryKey: ["blueprints"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useListStackSets = (params?: {
  pageIdentifier?: string;
  maxResults?: number;
}) => {
  return useQuery({
    queryKey: ["stacksets", params],
    queryFn: async () => await getBlueprintService().listStackSets(params),
    staleTime: 5 * 60 * 1000, // 5 minutes - StackSets are relatively static
  });
};
