// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";

import { LeaseTemplateService } from "./service";
import { NewLeaseTemplate } from "./types";

export const useGetLeaseTemplates = () => {
  return useQuery({
    queryKey: ["leaseTemplates"],
    queryFn: async () => await new LeaseTemplateService().getLeaseTemplates(),
  });
};

export const useGetLeaseTemplateById = (uuid?: string) => {
  return useQuery({
    queryKey: ["leaseTemplates", uuid],
    queryFn: async () =>
      await new LeaseTemplateService().getLeaseTemplateById(uuid!),
    enabled: !!uuid,
  });
};

export const useDeleteLeaseTemplates = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseTemplateIds: string[]) =>
      await new LeaseTemplateService().deleteLeaseTemplates(leaseTemplateIds),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["leaseTemplates"],
        refetchType: "all",
      }),
  });
};

export const useUpdateLeaseTemplate = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseTemplate: LeaseTemplate) =>
      await new LeaseTemplateService().updateLeaseTemplate(leaseTemplate),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["leaseTemplates"],
        refetchType: "all",
      }),
  });
};

export const useAddLeaseTemplate = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseTemplate: NewLeaseTemplate) =>
      await new LeaseTemplateService().addLeaseTemplate(leaseTemplate),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["leaseTemplates"],
        refetchType: "all",
      }),
  });
};
