// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { PrincipalService } from "@amzn/innovation-sandbox-frontend/domains/principals/service";
import type { SmithyPrincipalApi } from "@amzn/innovation-sandbox-frontend/domains/principals/smithy-client";

const api = (): SmithyPrincipalApi => ({ searchPrincipals: vi.fn() });

describe("PrincipalService", () => {
  it("delegates searches to the Smithy adapter", async () => {
    const stub = api();
    const service = new PrincipalService(stub);

    await service.getPrincipals("all", "alice", 10, true);

    expect(stub.searchPrincipals).toHaveBeenCalledWith(
      "all",
      "alice",
      10,
      true,
    );
  });

  it("applies the pre-Smithy query defaults", async () => {
    const stub = api();
    const service = new PrincipalService(stub);

    await service.getPrincipals("users");

    expect(stub.searchPrincipals).toHaveBeenCalledWith("users", "", 20, false);
  });
});
