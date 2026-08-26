// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import {
  CostExplorerClient,
  ListCostAllocationTagsCommand,
  UpdateCostAllocationTagsStatusCommand,
} from "@aws-sdk/client-cost-explorer";
import {
  OrganizationsClient,
  TagResourceCommand,
  UntagResourceCommand,
} from "@aws-sdk/client-organizations";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TagActivationCheckerEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/tag-activation-checker-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { isbAccountTagKeys } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
import {
  TagActivationCheckerCheckEvent,
  TagActivationCheckerSeedEvent,
  handler,
} from "@amzn/innovation-sandbox-tag-activation-checker/tag-activation-checker-handler.js";

const HUB_ACCOUNT_ID = "123456789012";
const NAMESPACE = "myisb";
const TAG_KEYS = isbAccountTagKeys(NAMESPACE);

const orgsMock = mockClient(OrganizationsClient);
const ceMock = mockClient(CostExplorerClient);

const testEnv = generateSchemaData(TagActivationCheckerEnvironmentSchema, {
  ISB_NAMESPACE: NAMESPACE,
  HUB_ACCOUNT_ID,
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  orgsMock.reset();
  ceMock.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const seedEvent = (): TagActivationCheckerSeedEvent => ({
  phase: "SEED",
  hubAccountId: HUB_ACCOUNT_ID,
});

const checkEvent = (
  overrides: Partial<TagActivationCheckerCheckEvent> = {},
): TagActivationCheckerCheckEvent => ({
  phase: "CHECK",
  hubAccountId: HUB_ACCOUNT_ID,
  maxAttempts: 24,
  attempt: 0,
  ...overrides,
});

describe("tag-activation-checker handler — SEED phase", () => {
  it("tags the hub account with all 5 ISB keys and returns seeded=true", async () => {
    orgsMock.on(TagResourceCommand).resolves({});

    const result = await handler(seedEvent(), mockContext(testEnv));

    expect(result).toEqual({ seeded: true });

    const tagCalls = orgsMock.commandCalls(TagResourceCommand);
    expect(tagCalls).toHaveLength(1);
    const input = tagCalls[0]!.args[0].input;
    expect(input.ResourceId).toBe(HUB_ACCOUNT_ID);
    expect(input.Tags?.map((t) => t.Key)).toEqual(TAG_KEYS);
    // every seed tag has the same placeholder value
    const values = new Set(input.Tags?.map((t) => t.Value));
    expect(values.size).toBe(1);
  });

  it("propagates seed-tag SDK failures so Step Functions retries", async () => {
    const error = new Error("AccessDenied");
    orgsMock.on(TagResourceCommand).rejects(error);

    await expect(handler(seedEvent(), mockContext(testEnv))).rejects.toBe(
      error,
    );
  });
});

describe("tag-activation-checker handler — CHECK phase", () => {
  it("returns completed=true and removes seed tags when all 5 keys are Active", async () => {
    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: TAG_KEYS.map((key) => ({
        TagKey: `accountTag/${key}`,
        Status: "Active",
        Type: "UserDefined",
      })),
    });
    orgsMock.on(UntagResourceCommand).resolves({});

    const result = await handler(checkEvent(), mockContext(testEnv));

    expect(result).toEqual({ completed: true });

    const listCalls = ceMock.commandCalls(ListCostAllocationTagsCommand);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.args[0].input.TagKeys).toEqual(
      TAG_KEYS.map((k) => `accountTag/${k}`),
    );

    expect(
      ceMock.commandCalls(UpdateCostAllocationTagsStatusCommand),
    ).toHaveLength(0);
    const untagCalls = orgsMock.commandCalls(UntagResourceCommand);
    expect(untagCalls).toHaveLength(1);
    expect(untagCalls[0]!.args[0].input).toEqual({
      ResourceId: HUB_ACCOUNT_ID,
      TagKeys: TAG_KEYS,
    });
  });

  it("logs the full ISB-<namespace>: keys, not the bare suffixes", async () => {
    // Operators paste these strings straight into the Cost Allocation Tags page,
    // so the log must carry the namespaced key rather than e.g. "LeaseId".
    const infoSpy = vi
      .spyOn(Logger.prototype, "info")
      .mockImplementation(() => {});
    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: [
        {
          TagKey: `accountTag/ISB-${NAMESPACE}:LeaseId`,
          Status: "Inactive",
          Type: "UserDefined",
        },
      ],
    });
    ceMock.on(UpdateCostAllocationTagsStatusCommand).resolves({});

    await handler(checkEvent(), mockContext(testEnv));

    expect(infoSpy).toHaveBeenCalledWith(
      "Tag activation check",
      expect.objectContaining({
        logDetailType: "TagActivationCheck",
        tagsActive: [],
        tagsInactive: [`ISB-${NAMESPACE}:LeaseId`],
        tagsMissing: [
          `ISB-${NAMESPACE}:CostReportGroup`,
          `ISB-${NAMESPACE}:LeaseTemplate`,
          `ISB-${NAMESPACE}:User`,
          `ISB-${NAMESPACE}:Status`,
        ],
      }),
    );
  });

  it("logs the activated keys on success", async () => {
    const infoSpy = vi
      .spyOn(Logger.prototype, "info")
      .mockImplementation(() => {});
    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: TAG_KEYS.map((key) => ({
        TagKey: `accountTag/${key}`,
        Status: "Active" as const,
        Type: "UserDefined" as const,
      })),
    });
    orgsMock.on(UntagResourceCommand).resolves({});

    await handler(checkEvent(), mockContext(testEnv));

    expect(infoSpy).toHaveBeenCalledWith(
      "Tag activation succeeded",
      expect.objectContaining({
        logDetailType: "TagActivationSucceeded",
        tagsActivated: TAG_KEYS,
      }),
    );
  });

  it("logs the stuck keys on the final attempt", async () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: [],
    });

    await handler(
      checkEvent({ attempt: 23, maxAttempts: 24 }),
      mockContext(testEnv),
    );

    expect(errorSpy).toHaveBeenCalledWith(
      "Tag activation failed",
      expect.objectContaining({
        logDetailType: "TagActivationFailed",
        reason: "MaxAttemptsReached",
        tagsInactive: [],
        tagsMissing: TAG_KEYS,
      }),
    );
  });

  it("succeeds even if seed-tag removal fails (best-effort)", async () => {
    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: TAG_KEYS.map((key) => ({
        TagKey: `accountTag/${key}`,
        Status: "Active",
        Type: "UserDefined",
      })),
    });
    orgsMock.on(UntagResourceCommand).rejects(new Error("transient"));

    const result = await handler(checkEvent(), mockContext(testEnv));

    expect(result).toMatchObject({ completed: true });
  });

  it("activates Inactive tags and returns completed=false with attempt incremented", async () => {
    const inactiveKeys = [
      `ISB-${NAMESPACE}:LeaseId`,
      `ISB-${NAMESPACE}:Status`,
    ];
    const activeKeys = TAG_KEYS.filter((k) => !inactiveKeys.includes(k));

    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: [
        ...inactiveKeys.map((key) => ({
          TagKey: `accountTag/${key}`,
          Status: "Inactive" as const,
          Type: "UserDefined" as const,
        })),
        ...activeKeys.map((key) => ({
          TagKey: `accountTag/${key}`,
          Status: "Active" as const,
          Type: "UserDefined" as const,
        })),
      ],
    });
    ceMock.on(UpdateCostAllocationTagsStatusCommand).resolves({});

    const result = await handler(
      checkEvent({ attempt: 3 }),
      mockContext(testEnv),
    );

    expect(result).toEqual({ completed: false });

    const updateCalls = ceMock.commandCalls(
      UpdateCostAllocationTagsStatusCommand,
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.args[0].input.CostAllocationTagsStatus).toEqual(
      inactiveKeys.map((key) => ({
        TagKey: `accountTag/${key}`,
        Status: "Active",
      })),
    );
    // do not untag while still inactive
    expect(orgsMock.commandCalls(UntagResourceCommand)).toHaveLength(0);
  });

  it("skips activation when keys are missing from ListCostAllocationTags (not yet propagated)", async () => {
    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: [],
    });

    const result = await handler(
      checkEvent({ attempt: 1 }),
      mockContext(testEnv),
    );

    expect(result).toEqual({ completed: false });
    expect(
      ceMock.commandCalls(UpdateCostAllocationTagsStatusCommand),
    ).toHaveLength(0);
  });

  it("rethrows ListCostAllocationTags errors so Step Functions retries", async () => {
    const error = new Error("list-failed");
    ceMock.on(ListCostAllocationTagsCommand).rejects(error);

    await expect(handler(checkEvent(), mockContext(testEnv))).rejects.toBe(
      error,
    );
  });

  it("rethrows UpdateCostAllocationTagsStatus errors so Step Functions retries", async () => {
    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: TAG_KEYS.map((key) => ({
        TagKey: `accountTag/${key}`,
        Status: "Inactive" as const,
        Type: "UserDefined" as const,
      })),
    });
    const error = new Error("activate-failed");
    ceMock.on(UpdateCostAllocationTagsStatusCommand).rejects(error);

    await expect(handler(checkEvent(), mockContext(testEnv))).rejects.toBe(
      error,
    );
  });

  it("returns completed=false on the final attempt so the state machine can transition to Fail", async () => {
    ceMock.on(ListCostAllocationTagsCommand).resolves({
      CostAllocationTags: [],
    });

    const result = await handler(
      checkEvent({ attempt: 23, maxAttempts: 24 }),
      mockContext(testEnv),
    );

    expect(result).toMatchObject({ completed: false });
  });
});
