// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  useGetConfigurations,
  useGetConfigurationSection,
  usePutConfigurationSection,
} from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  adminConfigGetHandler,
  configurationSectionConflictHandler,
  configurationSectionGetHandler,
  configurationSectionPutHandler,
  mockAdminConfig,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getCurrentUser: vi.fn().mockResolvedValue({
      status: "authenticated",
      user: {
        type: "user",
        email: "admin@example.com",
        userId: "test-admin-id",
        roles: ["Admin"],
      },
    }),
    getIdToken: vi.fn().mockResolvedValue("mock-id-token"),
    getCredentials: vi.fn().mockResolvedValue({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-not-a-real-key",
      sessionToken: "test-session-token",
    }),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

const apiUrl = () => getConfig().ApiUrl;

describe("Settings hooks", () => {
  describe("useGetConfigurations (section-based shape)", () => {
    it("fetches all sections plus deploy-time fields", async () => {
      server.use(adminConfigGetHandler());

      const { result } = renderHook(() => useGetConfigurations(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.leases).toEqual(mockAdminConfig.leases);
      expect(result.current.data?.isbManagedRegions).toEqual([
        "us-east-1",
        "us-west-2",
      ]);
      expect(result.current.data?.awsAccessPortalUrl).toBe(
        mockAdminConfig.awsAccessPortalUrl,
      );
    });

    it("surfaces an error when the request fails", async () => {
      server.use(
        http.get(`${apiUrl()}/configurations`, () =>
          HttpResponse.json(
            { status: "error", message: "boom" },
            { status: 500 },
          ),
        ),
      );

      const { result } = renderHook(() => useGetConfigurations(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetConfigurationSection", () => {
    it("fetches a single section", async () => {
      server.use(configurationSectionGetHandler());

      const { result } = renderHook(
        () => useGetConfigurationSection("leases"),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(mockAdminConfig.leases);
    });

    it("does not fire when disabled via options", () => {
      const { result } = renderHook(
        () => useGetConfigurationSection("cleanup", { enabled: false }),
        { wrapper: createQueryClientWrapper() },
      );

      // Disabled query stays idle: never fetches, no data.
      expect(result.current.fetchStatus).toBe("idle");
      expect(result.current.data).toBeUndefined();
    });

    it("surfaces an error when the section request fails", async () => {
      server.use(
        http.get(`${apiUrl()}/configurations/:section`, () =>
          HttpResponse.json(
            { status: "error", message: "boom" },
            { status: 500 },
          ),
        ),
      );

      const { result } = renderHook(
        () => useGetConfigurationSection("notification"),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("usePutConfigurationSection", () => {
    it("saves a section and resolves with the updated data", async () => {
      server.use(configurationSectionPutHandler());

      const { result } = renderHook(
        () => usePutConfigurationSection("maintenance"),
        { wrapper: createQueryClientWrapper() },
      );

      result.current.mutate({ enabled: true });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.enabled).toBe(true);
      expect(result.current.data?.lastSavedBy).toBe("admin@example.com");
      // The PUT handler and mockAdminConfig share the same saved envelope, so
      // the returned meta matches the fixture's.
      expect(result.current.data?.meta?.lastEditTime).toBe(
        mockAdminConfig.maintenance.meta?.lastEditTime,
      );
    });

    it("rejects with a 409 conflict and does not mark success", async () => {
      server.use(configurationSectionConflictHandler());

      const { result } = renderHook(
        () => usePutConfigurationSection("leases"),
        { wrapper: createQueryClientWrapper() },
      );

      result.current.mutate({ maxBudget: 100 });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.isSuccess).toBe(false);
      expect(result.current.error).toBeDefined();
    });

    it("invalidates the all-sections read on success so it refetches", async () => {
      // Count requests to the GET /configurations endpoint.
      let getCount = 0;
      server.use(
        http.get(`${apiUrl()}/configurations`, () => {
          getCount += 1;
          return HttpResponse.json({ status: "success", data: {} });
        }),
        configurationSectionPutHandler(),
      );

      // Mount the all-sections read and the save mutation under one shared cache.
      const wrapper = createQueryClientWrapper();
      const { result } = renderHook(
        () => ({
          read: useGetConfigurations(),
          put: usePutConfigurationSection("maintenance"),
        }),
        { wrapper },
      );

      // Initial fetch completes.
      await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
      expect(getCount).toBe(1);

      // Saving a section must invalidate the read key and trigger a refetch.
      result.current.put.mutate({ enabled: true });
      await waitFor(() => expect(result.current.put.isSuccess).toBe(true));
      await waitFor(() => expect(getCount).toBe(2));
    });
  });
});
