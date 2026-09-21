// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  useGetPrincipals,
  useResolvePrincipal,
} from "@amzn/innovation-sandbox-frontend/domains/principals/hooks";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
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

const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000001";
const principals = [
  {
    principalId: PRINCIPAL_ID,
    principalType: "USER" as const,
    displayName: "Alice Smith",
    email: "alice@example.com",
  },
];

describe("principal hooks", () => {
  it("does not search before the minimum query length", async () => {
    let apiCalled = false;
    server.use(
      http.get(`${getConfig().ApiUrl}/principals/search`, () => {
        apiCalled = true;
        return HttpResponse.json({
          status: "success",
          data: { principals, totalMatches: 1 },
        });
      }),
    );

    const { result } = renderHook(() => useGetPrincipals("all", "a"), {
      wrapper: createQueryClientWrapper(),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(apiCalled).toBe(false);
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("searches with the requested filter and limit", async () => {
    let receivedUrl: URL | undefined;
    server.use(
      http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
        receivedUrl = new URL(request.url);
        return HttpResponse.json({
          status: "success",
          data: { principals, totalMatches: 1 },
        });
      }),
    );

    const { result } = renderHook(
      () => useGetPrincipals("users", "alice", 10),
      { wrapper: createQueryClientWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ principals, totalMatches: 1 });
    expect(receivedUrl?.searchParams.get("q")).toBe("alice");
    expect(receivedUrl?.searchParams.get("type")).toBe("users");
    expect(receivedUrl?.searchParams.get("limit")).toBe("10");
  });

  it("rejects an exact lookup when no valid principal remains", async () => {
    server.use(
      http.get(getConfig().ApiUrl + "/principals/search", () =>
        HttpResponse.json({
          status: "success",
          data: {
            principals: [
              {
                principalId: PRINCIPAL_ID,
                principalType: "SERVICE",
                displayName: "Invalid principal",
              },
            ],
            totalMatches: 1,
          },
        }),
      ),
    );

    const { result } = renderHook(() => useResolvePrincipal(), {
      wrapper: createQueryClientWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        identifier: "alice@example.com",
        type: "users",
      }),
    ).rejects.toThrow("Principal lookup returned no valid result");
  });

  it("surfaces principal-search failures", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/principals/search`, () =>
        HttpResponse.json(
          { status: "error", message: "boom" },
          { status: 500 },
        ),
      ),
    );

    const { result } = renderHook(() => useGetPrincipals("all", "alice"), {
      wrapper: createQueryClientWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeDefined();
  });
});
