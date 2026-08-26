// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { AccountService } from "@amzn/innovation-sandbox-frontend/domains/accounts/service";
import { CleanupReport } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";

export const useGetAccounts = () => {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: async () => await new AccountService().getAccounts(),
  });
};

export const useGetAccountById = (accountId: string | undefined) => {
  return useQuery({
    queryKey: ["accounts", accountId],
    queryFn: async () => await new AccountService().getAccountById(accountId!),
    enabled: !!accountId,
    // Poll only while a cleanup is actively in flight
    refetchInterval: (query) =>
      query.state.data?.activeCleanup ? 10_000 : false,
  });
};

export const useGetCleanupReports = (accountId: string | undefined) => {
  const queryClient = useQueryClient();
  const prevFingerprintRef = useRef<string | undefined>(undefined);

  // Full paginated list
  const listQuery = useInfiniteQuery({
    queryKey: ["accounts", accountId, "cleanup-reports"],
    queryFn: async ({ pageParam }) =>
      await new AccountService().getCleanupReports(accountId!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextPageIdentifier ?? undefined,
    enabled: !!accountId,
  });

  // Lightweight probe — polls every 10s for live step-level updates
  const latestQuery = useQuery({
    queryKey: ["accounts", accountId, "cleanup-report-latest"],
    queryFn: async () =>
      await new AccountService().getLatestCleanupReport(accountId!),
    enabled: !!accountId,
    refetchInterval: 10_000,
  });

  // Invalidate the full list when a new report appears
  useEffect(() => {
    const currentStartedAt = latestQuery.data?.startedAt;

    if (
      prevFingerprintRef.current !== undefined &&
      currentStartedAt !== prevFingerprintRef.current
    ) {
      queryClient.invalidateQueries({
        queryKey: ["accounts", accountId, "cleanup-reports"],
      });
    }
    prevFingerprintRef.current = currentStartedAt;
  }, [latestQuery.data, accountId, queryClient]);

  // Invalidate account details when cleanup report status changes
  // so the account status header stays in sync
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const currentStatus = latestQuery.data?.status;

    if (
      prevStatusRef.current !== undefined &&
      currentStatus !== prevStatusRef.current
    ) {
      queryClient.invalidateQueries({
        queryKey: ["accounts", accountId],
        exact: true,
      });
    }
    prevStatusRef.current = currentStatus;
  }, [latestQuery.data?.status, accountId, queryClient]);

  // Merge: replace reports[0] with the fresher polled version so
  // consumers always see the most up-to-date data in a single array.
  const reports = useMemo(() => {
    const listReports: CleanupReport[] =
      listQuery.data?.pages.flatMap((page) => page.result) ?? [];
    if (
      latestQuery.data &&
      listReports.length > 0 &&
      latestQuery.data.startedAt === listReports[0].startedAt
    ) {
      return [latestQuery.data, ...listReports.slice(1)];
    }
    return listReports;
  }, [listQuery.data, latestQuery.data]);

  return {
    reports,
    isLoading: listQuery.isLoading,
    isError: listQuery.isError,
    hasNextPage: listQuery.hasNextPage ?? false,
    fetchNextPage: listQuery.fetchNextPage,
    isFetchingNextPage: listQuery.isFetchingNextPage,
    refetch: listQuery.refetch,
  };
};

export const useGetUnregisteredAccounts = () => {
  return useQuery({
    queryKey: ["unregisteredAccounts"],
    queryFn: async () => await new AccountService().getUnregisteredAccounts(),
  });
};

export const useAddAccount = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().addAccount(awsAccountId),
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["unregisteredAccounts"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useEjectAccount = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().ejectAccount(awsAccountId),
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
      }
    },
  });
};

export const useCleanupAccount = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().cleanupAccount(awsAccountId),
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useQuarantineAccount = (options?: {
  skipInvalidation?: boolean;
}) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().quarantineAccount(awsAccountId),
    onSuccess: () => {
      if (!options?.skipInvalidation) {
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
      }
    },
  });
};

export const useSkipCooldown = (accountId: string | undefined) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!accountId) throw new Error("Account ID is required");
      await new AccountService().skipCooldown(accountId);
    },
    onSuccess: () => {
      client.invalidateQueries({
        queryKey: ["accounts", accountId, "cleanup-reports"],
      });
      client.invalidateQueries({
        queryKey: ["accounts", accountId, "cleanup-report-latest"],
      });
      client.invalidateQueries({
        queryKey: ["accounts", accountId],
        exact: true,
      });
      client.invalidateQueries({
        queryKey: ["accounts"],
        exact: true,
      });
    },
  });
};
