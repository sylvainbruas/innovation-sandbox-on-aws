// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ConstraintViolationException,
  OrganizationsClient,
  TagResourceCommand,
  UntagResourceCommand,
} from "@aws-sdk/client-organizations";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { MonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  ISB_ACCOUNT_TAG_SUFFIXES,
  ISB_LEASE_TAG_SUFFIXES,
  IsbAccountTags,
  IsbStatusTagValue,
  NO_COST_REPORT_GROUP_TAG_VALUE,
} from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";

const mockOrganizationsClient = mockClient(OrganizationsClient);

const ACCOUNT_ID = "123456789012";
const NAMESPACE = "myisb";
const LEASE_TAGS: IsbAccountTags = {
  LeaseId: "lease-uuid",
  CostReportGroup: "team-alpha",
  LeaseTemplate: "template-uuid",
  User: "user@example.com",
};

describe("OrganizationsTaggingService", () => {
  let service: OrganizationsTaggingService;

  beforeEach(() => {
    mockOrganizationsClient.reset();
    service = new OrganizationsTaggingService({
      orgsClient: mockOrganizationsClient as unknown as OrganizationsClient,
      namespace: NAMESPACE,
    });
  });

  describe("tagAccount()", () => {
    it("sends all tags to Organizations on the happy path", async () => {
      mockOrganizationsClient.on(TagResourceCommand).resolves({});

      await service.tagAccount(ACCOUNT_ID, LEASE_TAGS);

      const calls = mockOrganizationsClient.commandCalls(TagResourceCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input).toEqual({
        ResourceId: ACCOUNT_ID,
        Tags: [
          { Key: "ISB-myisb:LeaseId", Value: "lease-uuid" },
          { Key: "ISB-myisb:CostReportGroup", Value: "team-alpha" },
          { Key: "ISB-myisb:LeaseTemplate", Value: "template-uuid" },
          { Key: "ISB-myisb:User", Value: "user@example.com" },
        ],
      });
    });

    it("propagates MAX_TAG_LIMIT_EXCEEDED so the caller can classify it", async () => {
      const limitError = new ConstraintViolationException({
        $metadata: {},
        Reason: "MAX_TAG_LIMIT_EXCEEDED",
        message: "tag limit",
      });
      mockOrganizationsClient.on(TagResourceCommand).rejects(limitError);

      await expect(service.tagAccount(ACCOUNT_ID, LEASE_TAGS)).rejects.toBe(
        limitError,
      );
    });

    it("propagates generic SDK errors", async () => {
      const apiError = new Error("AccessDenied");
      mockOrganizationsClient.on(TagResourceCommand).rejects(apiError);

      await expect(service.tagAccount(ACCOUNT_ID, LEASE_TAGS)).rejects.toBe(
        apiError,
      );
    });
  });

  describe("untagAccount()", () => {
    it("sends tag keys to Organizations on the happy path", async () => {
      mockOrganizationsClient.on(UntagResourceCommand).resolves({});

      await service.untagAccount(ACCOUNT_ID, [...ISB_ACCOUNT_TAG_SUFFIXES]);

      const calls = mockOrganizationsClient.commandCalls(UntagResourceCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input).toEqual({
        ResourceId: ACCOUNT_ID,
        TagKeys: [
          "ISB-myisb:LeaseId",
          "ISB-myisb:CostReportGroup",
          "ISB-myisb:LeaseTemplate",
          "ISB-myisb:User",
          "ISB-myisb:Status",
        ],
      });
    });

    it("propagates SDK errors", async () => {
      const error = new Error("boom");
      mockOrganizationsClient.on(UntagResourceCommand).rejects(error);

      await expect(service.untagAccount(ACCOUNT_ID, ["LeaseId"])).rejects.toBe(
        error,
      );
    });
  });

  describe("updateStatusTag()", () => {
    it.each<IsbStatusTagValue>([
      "Available",
      "Active",
      "Frozen",
      "CleanUp",
      "Quarantine",
    ])(
      "writes the Status tag as %s via a single TagResource call",
      async (status) => {
        mockOrganizationsClient.on(TagResourceCommand).resolves({});

        await service.updateStatusTag(ACCOUNT_ID, status);

        const calls = mockOrganizationsClient.commandCalls(TagResourceCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.args[0].input).toEqual({
          ResourceId: ACCOUNT_ID,
          Tags: [{ Key: "ISB-myisb:Status", Value: status }],
        });
      },
    );
  });

  describe("applyLeaseTags()", () => {
    it("writes the 4 lease tags + Status=Active in a single TagResource call", async () => {
      mockOrganizationsClient.on(TagResourceCommand).resolves({});
      const lease = generateSchemaData(MonitoredLeaseSchema, {
        awsAccountId: ACCOUNT_ID,
        status: "Active",
        costReportGroup: "team-alpha",
        originalLeaseTemplateUuid: "template-uuid-123",
      });
      const userId = "idc-user-123";

      await service.applyLeaseTags(lease, userId);

      const calls = mockOrganizationsClient.commandCalls(TagResourceCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input).toEqual({
        ResourceId: ACCOUNT_ID,
        Tags: [
          { Key: "ISB-myisb:LeaseId", Value: lease.uuid },
          { Key: "ISB-myisb:CostReportGroup", Value: "team-alpha" },
          { Key: "ISB-myisb:LeaseTemplate", Value: "template-uuid-123" },
          { Key: "ISB-myisb:User", Value: userId },
          { Key: "ISB-myisb:Status", Value: "Active" },
        ],
      });
    });

    it("falls back to the no-cost-report-group sentinel when the lease has none", async () => {
      mockOrganizationsClient.on(TagResourceCommand).resolves({});
      const lease = generateSchemaData(MonitoredLeaseSchema, {
        awsAccountId: ACCOUNT_ID,
        status: "Active",
        costReportGroup: undefined,
      });

      await service.applyLeaseTags(lease, "idc-user-123");

      const tags =
        mockOrganizationsClient.commandCalls(TagResourceCommand)[0]!.args[0]
          .input.Tags!;
      expect(tags).toContainEqual({
        Key: "ISB-myisb:CostReportGroup",
        Value: NO_COST_REPORT_GROUP_TAG_VALUE,
      });
    });

    it("propagates SDK errors so the caller can classify and log", async () => {
      const apiError = new Error("AccessDenied");
      mockOrganizationsClient.on(TagResourceCommand).rejects(apiError);

      await expect(
        service.applyLeaseTags(
          generateSchemaData(MonitoredLeaseSchema, { status: "Active" }),
          "idc-user-123",
        ),
      ).rejects.toBe(apiError);
    });
  });

  describe("removeLeaseTags()", () => {
    it("removes only the 4 lease tags via a single UntagResource call", async () => {
      mockOrganizationsClient.on(UntagResourceCommand).resolves({});

      await service.removeLeaseTags(ACCOUNT_ID);

      const calls = mockOrganizationsClient.commandCalls(UntagResourceCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input).toEqual({
        ResourceId: ACCOUNT_ID,
        TagKeys: ISB_LEASE_TAG_SUFFIXES.map((s) => `ISB-myisb:${s}`),
      });

      expect(calls[0]!.args[0].input.TagKeys).not.toContain("ISB-myisb:Status");
    });

    it("propagates SDK errors so the caller can log", async () => {
      const apiError = new Error("Throttled");
      mockOrganizationsClient.on(UntagResourceCommand).rejects(apiError);

      await expect(service.removeLeaseTags(ACCOUNT_ID)).rejects.toBe(apiError);
    });
  });
});
