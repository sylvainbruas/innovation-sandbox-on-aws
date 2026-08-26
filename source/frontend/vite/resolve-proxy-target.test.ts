// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CloudFormationClient,
  DescribeStacksCommand,
  type DescribeStacksCommandOutput,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDevProxy,
  PROXIED_PATHS,
  resolveApiProxyTarget,
} from "./resolve-proxy-target";

const cfnMock = mockClient(CloudFormationClient);

const cloudFrontUrl = "https://d111111abcdef8.cloudfront.net";

function outputsResponse(
  outputs: { OutputKey: string; OutputValue: string }[],
): Partial<DescribeStacksCommandOutput> {
  return {
    Stacks: [
      {
        StackName: "stack",
        CreationTime: new Date(),
        StackStatus: "CREATE_COMPLETE",
        Outputs: outputs,
      },
    ],
  };
}

describe("resolveApiProxyTarget", () => {
  beforeEach(() => {
    cfnMock.reset();
    vi.stubEnv("AWS_PROFILE", undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns VITE_API_PROXY_TARGET without calling CloudFormation", async () => {
    const result = await resolveApiProxyTarget({
      VITE_API_PROXY_TARGET: "https://override.example.com",
      DEPLOY_REGION: "us-east-1",
    });

    expect(result).toBe("https://override.example.com");
    expect(cfnMock.commandCalls(DescribeStacksCommand)).toHaveLength(0);
  });

  it("returns undefined when DEPLOY_REGION is not set", async () => {
    const result = await resolveApiProxyTarget({});

    expect(result).toBeUndefined();
    expect(cfnMock.commandCalls(DescribeStacksCommand)).toHaveLength(0);
  });

  it("resolves CloudFrontDistributionUrl from the default Compute stack", async () => {
    cfnMock.on(DescribeStacksCommand).resolves(
      outputsResponse([
        {
          OutputKey: "CloudFrontDistributionUrl",
          OutputValue: cloudFrontUrl,
        },
      ]),
    );

    const result = await resolveApiProxyTarget({ DEPLOY_REGION: "us-east-1" });

    expect(result).toBe(cloudFrontUrl);
    const calls = cfnMock.commandCalls(DescribeStacksCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.StackName).toBe("InnovationSandbox-Compute");
  });

  it("uses STACK_PREFIX to build the Compute stack name", async () => {
    cfnMock.on(DescribeStacksCommand).resolves(
      outputsResponse([
        {
          OutputKey: "CloudFrontDistributionUrl",
          OutputValue: cloudFrontUrl,
        },
      ]),
    );

    await resolveApiProxyTarget({
      DEPLOY_REGION: "us-east-1",
      STACK_PREFIX: "MyIsb",
    });

    expect(
      cfnMock.commandCalls(DescribeStacksCommand)[0]!.args[0].input.StackName,
    ).toBe("MyIsb-Compute");
  });

  it("sets AWS_PROFILE from HUB_ACCOUNT_PROFILE when not already set", async () => {
    cfnMock.on(DescribeStacksCommand).resolves(
      outputsResponse([
        {
          OutputKey: "CloudFrontDistributionUrl",
          OutputValue: cloudFrontUrl,
        },
      ]),
    );

    await resolveApiProxyTarget({
      DEPLOY_REGION: "us-east-1",
      HUB_ACCOUNT_PROFILE: "hub-profile",
    });

    expect(process.env.AWS_PROFILE).toBe("hub-profile");
  });

  it("does not override an already-set AWS_PROFILE", async () => {
    vi.stubEnv("AWS_PROFILE", "preexisting");
    cfnMock.on(DescribeStacksCommand).resolves(
      outputsResponse([
        {
          OutputKey: "CloudFrontDistributionUrl",
          OutputValue: cloudFrontUrl,
        },
      ]),
    );

    await resolveApiProxyTarget({
      DEPLOY_REGION: "us-east-1",
      HUB_ACCOUNT_PROFILE: "hub-profile",
    });

    expect(process.env.AWS_PROFILE).toBe("preexisting");
  });

  it("returns undefined when the CloudFront output is missing", async () => {
    cfnMock
      .on(DescribeStacksCommand)
      .resolves(
        outputsResponse([
          { OutputKey: "SomeOtherOutput", OutputValue: "value" },
        ]),
      );

    const result = await resolveApiProxyTarget({ DEPLOY_REGION: "us-east-1" });

    expect(result).toBeUndefined();
  });

  it("returns undefined (fails soft) when CloudFormation throws", async () => {
    cfnMock
      .on(DescribeStacksCommand)
      .rejects(new Error("Stack does not exist"));

    const result = await resolveApiProxyTarget({ DEPLOY_REGION: "us-east-1" });

    expect(result).toBeUndefined();
  });
});

describe("buildDevProxy", () => {
  it("maps every proxied path to the target with host rewriting", () => {
    const proxy = buildDevProxy(cloudFrontUrl);

    expect(Object.keys(proxy)).toEqual(PROXIED_PATHS);
    for (const proxyPath of PROXIED_PATHS) {
      expect(proxy[proxyPath]).toEqual({
        target: cloudFrontUrl,
        changeOrigin: true,
        secure: true,
      });
    }
  });
});
