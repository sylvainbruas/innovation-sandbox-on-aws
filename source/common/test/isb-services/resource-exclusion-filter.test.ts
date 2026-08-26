// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Resource } from "@aws-sdk/client-resource-explorer-2";
import { describe, expect, it } from "vitest";

import { ResourceExclusionFilter } from "@amzn/innovation-sandbox-commons/isb-services/resource-exclusion-filter.js";

describe("ResourceExclusionFilter", () => {
  const allResources: Resource[] = [
    {
      Arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-1",
      ResourceType: "ec2:instance",
    },
    { Arn: "arn:aws:s3:::my-bucket", ResourceType: "s3:bucket" },
    {
      Arn: "arn:aws:iam::123456789012:role/InnovationSandbox-CleanupRole",
      ResourceType: "iam:role",
    },
    {
      Arn: "arn:aws:iam::123456789012:role/aws-service-role/elb/AWSServiceRoleForELB",
      ResourceType: "iam:role",
    },
    {
      Arn: "arn:aws:resource-explorer-2:us-east-1:123456789012:index/default",
      ResourceType: "resource-explorer-2:index",
    },
    {
      Arn: "arn:aws:logs:us-east-1:123456789012:log-group:aws-controltower-CloudTrailLogs",
      ResourceType: "logs:log-group",
    },
  ];

  it("passes all resources through when no exclusions configured", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: [],
      excludedArnPatterns: [],
    });

    const result = filter.applyExclusions(allResources);

    expect(result.remainingResources).toHaveLength(6);
    expect(result.ignoredResources).toHaveLength(0);
  });

  it("filters by resource type", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: ["resource-explorer-2:index"],
      excludedArnPatterns: [],
    });

    const result = filter.applyExclusions(allResources);

    expect(result.remainingResources).toHaveLength(5);
    expect(result.ignoredResources).toHaveLength(1);
    expect(result.ignoredResources[0]!.ResourceType).toBe(
      "resource-explorer-2:index",
    );
  });

  it("filters by ARN glob pattern", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: [],
      excludedArnPatterns: ["arn:aws:iam::*:role/InnovationSandbox-*"],
    });

    const result = filter.applyExclusions(allResources);

    expect(result.remainingResources).toHaveLength(5);
    expect(result.ignoredResources).toHaveLength(1);
    expect(result.ignoredResources[0]!.Arn).toBe(
      "arn:aws:iam::123456789012:role/InnovationSandbox-CleanupRole",
    );
  });

  it("filters by multiple ARN patterns", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: [],
      excludedArnPatterns: [
        "arn:aws:iam::*:role/InnovationSandbox-*",
        "arn:aws:iam::*:role/aws-service-role/*",
        "arn:aws:resource-explorer-2:*:*:index/*",
        "arn:aws:logs:*:*:log-group:*aws-controltower*",
      ],
    });

    const result = filter.applyExclusions(allResources);

    expect(result.remainingResources).toHaveLength(2);
    expect(result.ignoredResources).toHaveLength(4);
    expect(result.remainingResources.map((r) => r.ResourceType)).toEqual(
      expect.arrayContaining(["ec2:instance", "s3:bucket"]),
    );
  });

  it("filters by both type and ARN pattern", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: ["s3:bucket"],
      excludedArnPatterns: ["arn:aws:iam::*:role/InnovationSandbox-*"],
    });

    const result = filter.applyExclusions(allResources);

    expect(result.remainingResources).toHaveLength(4);
    expect(result.ignoredResources).toHaveLength(2);
  });

  it("handles empty resources array", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: ["ec2:instance"],
      excludedArnPatterns: ["arn:aws:iam::*:role/*"],
    });

    const result = filter.applyExclusions([]);

    expect(result.remainingResources).toEqual([]);
    expect(result.ignoredResources).toEqual([]);
  });

  it("handles glob pattern with multiple wildcards", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: [],
      excludedArnPatterns: ["arn:aws:*:*:*:*InnovationSandbox*"],
    });

    const resources: Resource[] = [
      {
        Arn: "arn:aws:cloudformation:us-east-1:123456789012:stack/StackSet-InnovationSandbox-Spoke/abc123",
        ResourceType: "cloudformation:stack",
      },
      {
        Arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-1",
        ResourceType: "ec2:instance",
      },
    ];

    const result = filter.applyExclusions(resources);

    expect(result.remainingResources).toHaveLength(1);
    expect(result.remainingResources[0]!.ResourceType).toBe("ec2:instance");
    expect(result.ignoredResources).toHaveLength(1);
  });

  it("does not filter resources with undefined ARN by ARN pattern", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: [],
      excludedArnPatterns: ["arn:aws:iam::*:role/*"],
    });

    const resources: Resource[] = [
      { Arn: undefined, ResourceType: "ec2:instance" },
      {
        Arn: "arn:aws:iam::123456789012:role/TestRole",
        ResourceType: "iam:role",
      },
    ];

    const result = filter.applyExclusions(resources);

    expect(result.remainingResources).toHaveLength(1);
    expect(result.remainingResources[0]!.ResourceType).toBe("ec2:instance");
    expect(result.ignoredResources).toHaveLength(1);
  });

  it("handles special regex characters in ARN patterns", () => {
    const filter = new ResourceExclusionFilter({
      excludedResourceTypes: [],
      excludedArnPatterns: [
        "arn:aws:iam::123456789012:role/my.role+name[test]",
      ],
    });

    const resources: Resource[] = [
      {
        Arn: "arn:aws:iam::123456789012:role/my.role+name[test]",
        ResourceType: "iam:role",
      },
      {
        Arn: "arn:aws:iam::123456789012:role/other-role",
        ResourceType: "iam:role",
      },
    ];

    const result = filter.applyExclusions(resources);

    expect(result.remainingResources).toHaveLength(1);
    expect(result.ignoredResources).toHaveLength(1);
    expect(result.ignoredResources[0]!.Arn).toBe(
      "arn:aws:iam::123456789012:role/my.role+name[test]",
    );
  });
});
