// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { Lease } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { getUserEmail } from "@amzn/innovation-sandbox-commons/utils/auth-utils";
import { isAssignmentLockActive } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { LeaseService } from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import {
  AssignmentPrincipalRef,
  LeasePatchRequest,
  NewLeaseRequest,
  PrincipalSearchType,
  SharedLeaseAccessType,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

const fetchLeases = async () => await new LeaseService().getLeases();

const LOCK_POLL_INTERVAL_MS = 5_000;

/**
 * How often to refetch the lease list. The 1-minute staleTime would otherwise
 * leave the bulk action menu deciding on stale lock state. Keyed on lock
 * liveness rather than presence, so an expired lock stops polling.
 */
export const leaseListPollInterval = (
  leases?: Pick<Lease, "resourceLock">[],
): number | false =>
  leases?.some(isAssignmentLockActive) ? LOCK_POLL_INTERVAL_MS : false;

export const useGetLeases = (options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ["leases"],
    queryFn: fetchLeases,
    staleTime: 60 * 1000, // 1 minute
    // Refetch on mount so SPA navigation reflects cross-session changes.
    refetchOnMount: "always",
    enabled: options?.enabled ?? true,
    refetchInterval: (query) => leaseListPollInterval(query.state.data),
  });
};

export const useGetPendingApprovals = () => {
  return useQuery({
    queryKey: ["leases"], // Same query key as useGetLeases
    queryFn: fetchLeases,
    staleTime: 60 * 1000, // 1 minute
    refetchOnMount: "always",
    select: (data) => {
      // Filter for pending approvals
      return data?.filter((lease) => lease.status === "PendingApproval") ?? [];
    },
  });
};

export const useGetLeasesByEmail = (email: string) => {
  return useQuery({
    queryKey: ["leases", email],
    queryFn: async () => await new LeaseService().getLeases(email),
    refetchOnMount: "always",
  });
};

export const useGetLeaseById = (
  uuid?: string,
  { pollWhileLocked = false } = {},
) => {
  return useQuery({
    queryKey: ["leases", uuid],
    queryFn: async () => await new LeaseService().getLeaseById(uuid!),
    enabled: !!uuid,
    refetchOnMount: "always",
    refetchInterval: (query) => {
      if (!pollWhileLocked) return false;
      const lease = query.state.data;
      return lease && isAssignmentLockActive(lease) ? 5_000 : false;
    },
  });
};

export const useLeasesForCurrentUser = () => {
  const { user } = useUser();
  const userEmail = user ? getUserEmail(user) : undefined;

  return useQuery({
    queryKey: ["leases", userEmail],
    queryFn: async () => {
      if (!userEmail) {
        return [];
      }
      return await new LeaseService().getLeases(userEmail);
    },
    enabled: !!userEmail, // Only run query when user email is available
    staleTime: 60 * 1000, // 1 minute
    refetchOnMount: "always",
  });
};

export const useRequestNewLease = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: NewLeaseRequest) =>
      await new LeaseService().requestNewLease(request),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
    },
  });
};

export const useUpdateLease = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: LeasePatchRequest) =>
      await new LeaseService().updateLease(request),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
    },
  });
};

export const useReviewLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      leaseId,
      approve,
    }: {
      leaseId: string;
      approve: boolean;
    }) => {
      await new LeaseService().reviewLease(leaseId, approve);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useTerminateLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseId: string) => {
      await new LeaseService().terminateLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["assignments"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useFreezeLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseId: string) => {
      await new LeaseService().freezeLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["assignments"],
          refetchType: "all",
        });
      }
    },
  });
};

export const PRINCIPAL_SEARCH_MIN_CHARS = 2;

export const useGetPrincipals = (
  type: PrincipalSearchType,
  query: string = "",
  limit: number = 20,
  options?: { enabled?: boolean },
) => {
  return useQuery({
    queryKey: ["principals", type, query, limit],
    queryFn: async () =>
      await new LeaseService().getPrincipals(type, query, limit),
    enabled:
      (options?.enabled ?? true) && query.length >= PRINCIPAL_SEARCH_MIN_CHARS,
    staleTime: 5 * 60 * 1000, // 5 minutes
    // Keep previous results on screen while the next fetch is in flight so
    // the typeahead dropdown doesn't flicker/disappear between keystrokes.
    placeholderData: keepPreviousData,
  });
};

export const useGetAssignments = (leaseId?: string) => {
  return useQuery({
    queryKey: ["assignments", leaseId],
    queryFn: async () => await new LeaseService().getAssignments(leaseId!),
    enabled: !!leaseId,
    refetchOnMount: "always",
    placeholderData: keepPreviousData,
  });
};

/**
 * Resolves a principal by exact email (users) or group name (groups) via the
 * search endpoint with `exact=true`. Used in manual entry mode when
 * enablePrincipalSearch is disabled.
 */
export const useResolvePrincipal = () => {
  return useMutation({
    mutationFn: async ({
      identifier,
      type,
    }: {
      identifier: string;
      type: "users" | "groups";
    }) => {
      // exact=true triggers the JIT IDC lookup. The API returns 404 if the
      // principal doesn't exist, which the ApiProxy surfaces as a thrown error.
      const response = await new LeaseService().getPrincipals(
        type,
        identifier,
        1,
        true,
      );
      return response.principals[0];
    },
  });
};

export const useUpdateAssignments = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      leaseId,
      assignments,
    }: {
      leaseId: string;
      assignments: AssignmentPrincipalRef[];
    }) => await new LeaseService().updateAssignments(leaseId, assignments),
    onSuccess: (_data, variables) => {
      client.invalidateQueries({
        queryKey: ["assignments", variables.leaseId],
        refetchType: "all",
      });
      client.invalidateQueries({
        queryKey: ["leases"],
        refetchType: "all",
      });
      client.invalidateQueries({
        queryKey: ["sharedLeases"],
        refetchType: "all",
      });
    },
  });
};

/**
 * Fetches all shared leases for the current user by access type.
 *
 * The service layer exhaustively fetches all pages (maxResults=100) so the
 * frontend has the complete dataset for client-side filtering and pagination.
 */
export const useGetSharedLeases = (accessType: SharedLeaseAccessType) => {
  const { user } = useUser();
  const userId = user?.userId;

  return useQuery({
    queryKey: ["sharedLeases", accessType, userId],
    queryFn: async () => {
      return await new LeaseService().getSharedLeases(userId!, accessType);
    },
    enabled: !!userId,
    staleTime: 60 * 1000, // 1 minute
    refetchOnMount: "always",
    placeholderData: keepPreviousData,
  });
};

export const useUnfreezeLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseId: string) => {
      await new LeaseService().unfreezeLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["assignments"],
          refetchType: "all",
        });
      }
    },
  });
};
