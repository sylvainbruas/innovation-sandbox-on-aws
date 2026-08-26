// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-commons/utils/auth-utils";
import { ApiProxy } from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";
import {
  MOCK_ID_TOKEN,
  mockCognitoCredentials,
} from "@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures";

const mockGetIdToken = vi.fn();
const mockGetCredentials = vi.fn();

const fetchHeaders = (callIndex = 0): Record<string, string> =>
  vi.mocked(fetch).mock.calls[callIndex]![1]!.headers as Record<string, string>;
vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getIdToken: (...args: unknown[]) => mockGetIdToken(...args),
    getCredentials: (...args: unknown[]) => mockGetCredentials(...args),
    getCurrentUser: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

describe("ApiProxy", () => {
  let proxy: ApiProxy;

  beforeEach(() => {
    vi.clearAllMocks();
    proxy = new ApiProxy("http://localhost/api");
    mockGetIdToken.mockResolvedValue(MOCK_ID_TOKEN);
    mockGetCredentials.mockResolvedValue(mockCognitoCredentials);
  });

  describe("successful requests", () => {
    it("sends GET signed with SigV4 to the same-origin /api URL", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "success", data: { id: "123" } }),
      });

      const result = await proxy.get<{ id: string }>("/items");

      // fetch URL is the same-origin /api URL CloudFront serves; CloudFront
      // strips /api and the RestApiOrigin prepends /prod before forwarding.
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost/api/items",
        expect.objectContaining({
          method: "GET",
          body: undefined,
        }),
      );
      const headers = fetchHeaders();
      expect(headers[IDENTITY_HEADER]).toBe(MOCK_ID_TOKEN);
      expect(headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(result).toEqual({ id: "123" });
    });

    it("includes x-isb-identity in SignedHeaders so it's covered by the signature", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "success", data: {} }),
      });

      await proxy.get("/items");

      const authz = fetchHeaders()["authorization"]!;
      const signedHeaders = authz.match(/SignedHeaders=([^,]+)/)?.[1] ?? "";
      expect(signedHeaders.split(";")).toContain(IDENTITY_HEADER);
    });

    it("emits a complete SigV4 header set", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "success", data: {} }),
      });

      await proxy.get("/items");
      const headers = fetchHeaders();

      // Stable SigV4 surface: authoring date + propagated session token for
      // temp creds + the Authorization tuple naming the right service/region.
      expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
      expect(headers["x-amz-security-token"]).toBe(
        mockCognitoCredentials.sessionToken,
      );

      const authz = headers["authorization"]!;
      expect(authz).toMatch(/^AWS4-HMAC-SHA256 /);
      const credential = authz.match(/Credential=([^,]+)/)?.[1] ?? "";
      const [accessKey, , region, service, terminator] = credential.split("/");
      expect(accessKey).toBe(mockCognitoCredentials.accessKeyId);
      expect(region).toBe("us-east-1");
      expect(service).toBe("execute-api");
      expect(terminator).toBe("aws4_request");

      // Signature is hex-encoded 32-byte HMAC-SHA256
      const signature = authz.match(/Signature=([0-9a-f]+)/)?.[1] ?? "";
      expect(signature).toMatch(/^[0-9a-f]{64}$/);

      // SignedHeaders covers what API Gateway must verify: host (Host
      // rewritten by CloudFront's RestApiOrigin) and the ID-token header.
      const signedHeaders = (
        authz.match(/SignedHeaders=([^,]+)/)?.[1] ?? ""
      ).split(";");
      expect(signedHeaders).toEqual(expect.arrayContaining(["host", IDENTITY_HEADER]));
    });

    it("signs query parameters as a separate canonical-query component", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "success", data: {} }),
      });

      await proxy.get("/items?pageIdentifier=abc&maxResults=10");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost/api/items?pageIdentifier=abc&maxResults=10",
        expect.objectContaining({ method: "GET" }),
      );

      const sigWithQuery =
        fetchHeaders()["authorization"]!.match(/Signature=([0-9a-f]+)/)?.[1] ??
        "";

      // Same path, no query — signatures must differ. Catches the regression
      // where the query string is folded into the canonical URI instead of
      // canonicalized separately.
      vi.mocked(fetch).mockClear();
      await proxy.get("/items");
      const sigWithoutQuery =
        fetchHeaders()["authorization"]!.match(/Signature=([0-9a-f]+)/)?.[1] ??
        "";

      expect(sigWithQuery).not.toBe(sigWithoutQuery);
      expect(sigWithQuery).toMatch(/^[0-9a-f]{64}$/);
    });

    it("sends POST with JSON body and signed headers", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ status: "success", data: { created: true } }),
      });

      const result = await proxy.post("/items", { name: "test" });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost/api/items",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "test" }),
        }),
      );
      const headers = fetchHeaders();
      expect(headers[IDENTITY_HEADER]).toBe(MOCK_ID_TOKEN);
      expect(headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(result).toEqual({ created: true });
    });

    it("sends PUT request", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ status: "success", data: { updated: true } }),
      });

      await proxy.put("/items/1", { name: "updated" });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost/api/items/1",
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("sends PATCH request", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ status: "success", data: { patched: true } }),
      });

      await proxy.patch("/items/1", { name: "patched" });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost/api/items/1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });

    it("sends DELETE request", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ status: "success", data: { deleted: true } }),
      });

      await proxy.delete("/items/1");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost/api/items/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("authentication errors", () => {
    it("throws when getIdToken returns null", async () => {
      mockGetIdToken.mockResolvedValue(null);

      await expect(proxy.get("/items")).rejects.toThrow("No active session");
    });

    it("throws when getCredentials returns null", async () => {
      mockGetCredentials.mockResolvedValue(null);

      await expect(proxy.get("/items")).rejects.toThrow("No active session");
    });
  });

  describe("HTTP error handling", () => {
    it("throws field-specific error from JSend response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            data: {
              errors: [{ field: "name", message: "is required" }],
            },
          }),
      });

      await expect(proxy.post("/items", {})).rejects.toThrow(
        "name: is required",
      );
    });

    it("throws message-only error from JSend response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            data: {
              errors: [{ message: "Resource already exists" }],
            },
          }),
      });

      await expect(proxy.post("/items", {})).rejects.toThrow(
        "Resource already exists",
      );
    });

    it("throws generic HTTP error when response is not JSON", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("not JSON")),
      });

      await expect(proxy.get("/items")).rejects.toThrow("HTTP error 500");
      expect(consoleSpy).toHaveBeenCalledWith(
        "API Response was not valid JSON",
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });

    it("throws generic HTTP error when no error details in response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ message: "Forbidden" }),
      });

      await expect(proxy.get("/items")).rejects.toThrow("HTTP error 403");
    });

    it("throws ApiError carrying the status code and JSend data payload", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            status: "fail",
            data: {
              errors: [{ message: "Rate limit exceeded" }],
              retryAt: "2026-06-09T14:32:00.000Z",
            },
          }),
      });

      await expect(proxy.post("/leases", {})).rejects.toMatchObject({
        message: "Rate limit exceeded",
        statusCode: 429,
        data: { retryAt: "2026-06-09T14:32:00.000Z" },
      });
    });
  });

  describe("API error handling", () => {
    it("throws when API returns non-success status", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "error",
            message: "Internal error",
          }),
      });

      await expect(proxy.get("/items")).rejects.toThrow(
        "API error: GET /items",
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "API error",
        expect.objectContaining({
          request: expect.objectContaining({ method: "GET", url: "/items" }),
        }),
      );
      consoleSpy.mockRestore();
    });
  });
});
