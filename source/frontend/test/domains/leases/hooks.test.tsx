// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  useFreezeLease,
  useGetAssignments,
  useGetLeaseById,
  useGetLeases,
  useGetLeasesByEmail,
  useGetPendingApprovals,
  useGetPrincipals,
  useGetSharedLeases,
  useLeasesForCurrentUser,
  useRequestNewLease,
  useReviewLease,
  useTerminateLease,
  useUnfreezeLease,
  useUpdateAssignments,
  useUpdateLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import {
  AssignmentPrincipalRef,
  LeaseAssignment,
  LeasePatchRequest,
  NewLeaseRequest,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockLease } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const [{ authenticated }, { buildCognitoAuthServiceMock }] =
      await Promise.all([
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures"),
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock"),
      ]);
    return {
      CognitoAuthService: buildCognitoAuthServiceMock({
        getCurrentUser: vi.fn().mockResolvedValue(authenticated()),
      }),
    };
  },
);

describe("Lease hooks", () => {
  describe("useLeasesForCurrentUser", () => {
    it("should fetch leases successfully", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: { result: [mockLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useLeasesForCurrentUser(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual([mockLease]);
    });

    it("should handle error when fetching leases fails", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to fetch" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useLeasesForCurrentUser(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("refetchOnMount", () => {
    it("useGetLeases refetches on every mount even within staleTime", async () => {
      // "always" refetches on remount even within staleTime; the default
      // (true) would skip the second mount, which is the stale-data bug.
      let calls = 0;
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          calls++;
          return HttpResponse.json({
            status: "success",
            data: { result: [mockLease], nextPageIdentifier: null },
          });
        }),
      );

      const wrapper = createQueryClientWrapper();
      const first = renderHook(() => useGetLeases(), { wrapper });
      await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
      expect(calls).toBe(1);
      first.unmount();

      const second = renderHook(() => useGetLeases(), { wrapper });
      await waitFor(() => expect(calls).toBe(2));
      expect(second.result.current.isSuccess).toBe(true);
    });
  });

  describe("useRequestNewLease", () => {
    it("should request a new lease successfully", async () => {
      const { result } = renderHook(() => useRequestNewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      const newLeaseRequest: NewLeaseRequest = {
        leaseTemplateUuid: "template-uuid-123",
      };

      let apiCallMade = false;
      server.use(
        http.post(`${getConfig().ApiUrl}/leases`, async ({ request }) => {
          const body = await request.json();
          expect(body).toEqual(newLeaseRequest);
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      result.current.mutate(newLeaseRequest);

      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true);
        },
        { timeout: 5000 },
      );

      expect(apiCallMade).toBe(true);
      expect(result.current.isError).toBe(false);
      expect(result.current.data).toBeUndefined();
    });

    it("should handle error when requesting a new lease fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to create lease" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useRequestNewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      const newLeaseRequest = {
        leaseTemplateUuid: "template-uuid-123",
      };

      result.current.mutate(newLeaseRequest);

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetPrincipals", () => {
    const mockPrincipals = [
      {
        principalId: "user-1",
        principalType: "USER" as const,
        displayName: "Alice Smith",
        email: "alice@example.com",
      },
      {
        principalId: "group-1",
        principalType: "GROUP" as const,
        displayName: "Engineering",
      },
    ];

    it("should not fetch when query is shorter than 2 characters", async () => {
      let apiCalled = false;
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, () => {
          apiCalled = true;
          return HttpResponse.json({
            status: "success",
            data: { principals: mockPrincipals, totalMatches: 2 },
          });
        }),
      );

      const { result } = renderHook(() => useGetPrincipals("all", "a"), {
        wrapper: createQueryClientWrapper(),
      });

      // Give React Query a chance to start a fetch (it shouldn't)
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(apiCalled).toBe(false);
      expect(result.current.fetchStatus).toBe("idle");
      expect(result.current.data).toBeUndefined();
    });

    it("should fetch when query has 2 or more characters", async () => {
      let receivedUrl: URL | undefined;
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json({
            status: "success",
            data: { principals: mockPrincipals, totalMatches: 2 },
          });
        }),
      );

      const { result } = renderHook(
        () => useGetPrincipals("users", "alice", 10),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual({
        principals: mockPrincipals,
        totalMatches: 2,
      });
      expect(receivedUrl?.searchParams.get("q")).toBe("alice");
      expect(receivedUrl?.searchParams.get("type")).toBe("users");
      expect(receivedUrl?.searchParams.get("limit")).toBe("10");
    });

    it("should handle errors from the principals search endpoint", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, () => {
          return HttpResponse.json(
            { status: "error", message: "boom" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useGetPrincipals("all", "alice"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetAssignments", () => {
    const leaseId = "lease-uuid-1";
    const mockAssignments: LeaseAssignment[] = [
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        assigneeEmail: "alice@example.com",
        addedBy: "owner@example.com",
        addedDate: "2026-01-01T00:00:00.000Z",
        isOwner: false,
        isDesired: true,
        syncStatus: "active",
      },
      {
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
        addedBy: "owner@example.com",
        addedDate: "2026-01-02T00:00:00.000Z",
        isOwner: false,
        isDesired: true,
        syncStatus: "active",
      },
    ];

    it("should fetch assignments for the given leaseId", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () =>
          HttpResponse.json({
            status: "success",
            data: { assignments: mockAssignments },
          }),
        ),
      );

      const { result } = renderHook(() => useGetAssignments(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.assignments).toEqual(mockAssignments);
    });

    it("should handle errors from the assignments endpoint", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () =>
          HttpResponse.json(
            { status: "error", message: "boom" },
            { status: 500 },
          ),
        ),
      );

      const { result } = renderHook(() => useGetAssignments(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useUpdateAssignments", () => {
    const leaseId = "lease-uuid-1";
    const desired: AssignmentPrincipalRef[] = [
      { principalId: "user-1", principalType: "USER" },
      { principalId: "group-1", principalType: "GROUP" },
    ];

    it("PUTs the desired assignments and returns desiredCount", async () => {
      let receivedBody: unknown;
      server.use(
        http.put(
          `${getConfig().ApiUrl}/leases/${leaseId}/assignments`,
          async ({ request }) => {
            receivedBody = await request.json();
            return HttpResponse.json(
              { status: "success", data: { desiredCount: desired.length } },
              { status: 202 },
            );
          },
        ),
      );

      const { result } = renderHook(() => useUpdateAssignments(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId, assignments: desired });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(receivedBody).toEqual({ assignments: desired });
      expect(result.current.data).toEqual({ desiredCount: desired.length });
    });

    it("surfaces errors from the assignments endpoint", async () => {
      server.use(
        http.put(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () =>
          HttpResponse.json(
            { status: "error", message: "lock held" },
            { status: 409 },
          ),
        ),
      );

      const { result } = renderHook(() => useUpdateAssignments(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId, assignments: desired });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetSharedLeases", () => {
    const mockDirectLease = {
      ...mockLease,
      leaseId: "encoded-lease-id-1",
      accessType: "direct" as const,
    };

    const mockGroupLease = {
      ...mockLease,
      leaseId: "encoded-lease-id-2",
      accessType: "group" as const,
      sourceGroupName: "Engineering",
    };

    it("should fetch direct shared leases for the current user", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("accessType")).toBe("direct");
          expect(url.searchParams.get("userId")).toBeDefined();
          return HttpResponse.json({
            status: "success",
            data: { result: [mockDirectLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useGetSharedLeases("direct"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.result).toHaveLength(1);
      expect(result.current.data?.result[0].accessType).toBe("direct");
    });

    it("should fetch group shared leases for the current user", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("accessType")).toBe("group");
          return HttpResponse.json({
            status: "success",
            data: { result: [mockGroupLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useGetSharedLeases("group"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.result).toHaveLength(1);
      expect(result.current.data?.result[0].accessType).toBe("group");
      expect(result.current.data?.result[0].sourceGroupName).toBe(
        "Engineering",
      );
    });

    it("should exhaustively paginate until nextPageIdentifier is null", async () => {
      let callCount = 0;
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
          callCount++;
          const url = new URL(request.url);
          if (!url.searchParams.has("pageIdentifier")) {
            // First page
            return HttpResponse.json({
              status: "success",
              data: {
                result: [mockDirectLease],
                nextPageIdentifier: "cursor-page-2",
              },
            });
          }
          // Second page (final)
          return HttpResponse.json({
            status: "success",
            data: {
              result: [{ ...mockDirectLease, leaseId: "encoded-lease-id-3" }],
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useGetSharedLeases("direct"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(callCount).toBe(2);
      expect(result.current.data?.result).toHaveLength(2);
      expect(result.current.data?.nextPageIdentifier).toBeNull();
    });

    it("should handle errors from the shared leases endpoint", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/shared`, () =>
          HttpResponse.json(
            { status: "fail", data: { errors: [{ message: "Unauthorized" }] } },
            { status: 403 },
          ),
        ),
      );

      const { result } = renderHook(() => useGetSharedLeases("direct"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetLeases", () => {
    it("should fetch all leases successfully", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: { result: [mockLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useGetLeases(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([mockLease]);
    });

    it("should handle error when fetching leases fails", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to fetch" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useGetLeases(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetPendingApprovals", () => {
    it("should select only leases with PendingApproval status", async () => {
      const pendingLease = {
        ...mockLease,
        leaseId: "pending-1",
        status: "PendingApproval",
      };
      const activeLease = {
        ...mockLease,
        leaseId: "active-1",
        status: "Active",
      };

      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: [pendingLease, activeLease],
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useGetPendingApprovals(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data![0].status).toBe("PendingApproval");
    });

    it("should return empty array when no pending approvals exist", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: [{ ...mockLease, status: "Active" }],
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useGetPendingApprovals(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toHaveLength(0);
    });
  });

  describe("useGetLeasesByEmail", () => {
    it("should fetch leases filtered by email", async () => {
      const email = "user@example.com";
      let receivedUrl: URL | undefined;

      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json({
            status: "success",
            data: { result: [mockLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useGetLeasesByEmail(email), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([mockLease]);
      expect(receivedUrl?.searchParams.get("userEmail")).toBe(email);
    });

    it("should handle error when fetching leases by email fails", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to fetch" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(
        () => useGetLeasesByEmail("user@example.com"),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetLeaseById", () => {
    it("should fetch a single lease by id", async () => {
      const leaseId = "lease-uuid-123";

      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}`, () => {
          return HttpResponse.json({
            status: "success",
            data: mockLease,
          });
        }),
      );

      const { result } = renderHook(() => useGetLeaseById(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(mockLease);
    });

    it("should not fetch when uuid is undefined", async () => {
      let apiCalled = false;
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/:id`, () => {
          apiCalled = true;
          return HttpResponse.json({
            status: "success",
            data: mockLease,
          });
        }),
      );

      const { result } = renderHook(() => useGetLeaseById(undefined), {
        wrapper: createQueryClientWrapper(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(apiCalled).toBe(false);
      expect(result.current.fetchStatus).toBe("idle");
      expect(result.current.data).toBeUndefined();
    });

    it("should handle error when fetching lease by id fails", async () => {
      const leaseId = "lease-uuid-123";

      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}`, () => {
          return HttpResponse.json(
            { status: "error", message: "Not found" },
            { status: 404 },
          );
        }),
      );

      const { result } = renderHook(() => useGetLeaseById(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useUpdateLease", () => {
    it("should PATCH a lease successfully", async () => {
      const patchRequest: LeasePatchRequest = {
        leaseId: "lease-uuid-123",
        maxSpend: 500,
      };

      let receivedBody: unknown;
      server.use(
        http.patch(
          `${getConfig().ApiUrl}/leases/${patchRequest.leaseId}`,
          async ({ request }) => {
            receivedBody = await request.json();
            return HttpResponse.json({ status: "success" }, { status: 200 });
          },
        ),
      );

      const { result } = renderHook(() => useUpdateLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(patchRequest);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(receivedBody).toEqual({ maxSpend: 500 });
    });

    it("should handle error when updating lease fails", async () => {
      server.use(
        http.patch(`${getConfig().ApiUrl}/leases/:id`, () => {
          return HttpResponse.json(
            { status: "error", message: "Update failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useUpdateLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId: "lease-uuid-123", maxSpend: 500 });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useReviewLease", () => {
    it("should POST to review endpoint with approve action", async () => {
      const leaseId = "lease-uuid-123";
      let receivedBody: unknown;

      server.use(
        http.post(
          `${getConfig().ApiUrl}/leases/${leaseId}/review`,
          async ({ request }) => {
            receivedBody = await request.json();
            return HttpResponse.json({ status: "success" }, { status: 200 });
          },
        ),
      );

      const { result } = renderHook(() => useReviewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId, approve: true });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(receivedBody).toEqual({ action: "Approve" });
    });

    it("should POST to review endpoint with deny action", async () => {
      const leaseId = "lease-uuid-123";
      let receivedBody: unknown;

      server.use(
        http.post(
          `${getConfig().ApiUrl}/leases/${leaseId}/review`,
          async ({ request }) => {
            receivedBody = await request.json();
            return HttpResponse.json({ status: "success" }, { status: 200 });
          },
        ),
      );

      const { result } = renderHook(() => useReviewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId, approve: false });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(receivedBody).toEqual({ action: "Deny" });
    });

    it("should handle error when review fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases/:id/review`, () => {
          return HttpResponse.json(
            { status: "error", message: "Review failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useReviewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId: "lease-uuid-123", approve: true });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useTerminateLease", () => {
    it("should POST to terminate endpoint successfully", async () => {
      const leaseId = "lease-uuid-123";
      let apiCallMade = false;

      server.use(
        http.post(`${getConfig().ApiUrl}/leases/${leaseId}/terminate`, () => {
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      const { result } = renderHook(() => useTerminateLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(leaseId);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(apiCallMade).toBe(true);
    });

    it("should handle error when termination fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases/:id/terminate`, () => {
          return HttpResponse.json(
            { status: "error", message: "Termination failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useTerminateLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate("lease-uuid-123");

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useFreezeLease", () => {
    it("should POST to freeze endpoint successfully", async () => {
      const leaseId = "lease-uuid-123";
      let apiCallMade = false;

      server.use(
        http.post(`${getConfig().ApiUrl}/leases/${leaseId}/freeze`, () => {
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      const { result } = renderHook(() => useFreezeLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(leaseId);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(apiCallMade).toBe(true);
    });

    it("should handle error when freeze fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases/:id/freeze`, () => {
          return HttpResponse.json(
            { status: "error", message: "Freeze failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useFreezeLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate("lease-uuid-123");

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useUnfreezeLease", () => {
    it("should POST to unfreeze endpoint successfully", async () => {
      const leaseId = "lease-uuid-123";
      let apiCallMade = false;

      server.use(
        http.post(`${getConfig().ApiUrl}/leases/${leaseId}/unfreeze`, () => {
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      const { result } = renderHook(() => useUnfreezeLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(leaseId);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(apiCallMade).toBe(true);
    });

    it("should handle error when unfreeze fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases/:id/unfreeze`, () => {
          return HttpResponse.json(
            { status: "error", message: "Unfreeze failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useUnfreezeLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate("lease-uuid-123");

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });
});
