// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  WAF_HUMAN_CALLS_METRIC_NAME,
  WAF_M2M_CALLS_METRIC_NAME,
} from "@amzn/innovation-sandbox-commons/observability/waf-auth-metrics.js";
import { collectApiCallsByAuthType } from "@amzn/innovation-sandbox-deployment-summary-heartbeat/api-call-mix.js";

const WEB_ACL_NAME = "myisb-web-acl";
const REGION = "us-east-1";
const cloudWatchMock = mockClient(CloudWatchClient);

describe("collectApiCallsByAuthType", () => {
  beforeEach(() => {
    cloudWatchMock.reset();
  });

  it("sums each query's datapoints into m2m and user counts", async () => {
    cloudWatchMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "user", Values: [10, 5] },
        { Id: "m2m", Values: [3] },
      ],
    });

    expect(
      await collectApiCallsByAuthType(
        new CloudWatchClient({}),
        WEB_ACL_NAME,
        REGION,
      ),
    ).toEqual({ m2m: 3, user: 15 });
  });

  it("queries both count rules by their WAF metric names, WebACL, and Region", async () => {
    cloudWatchMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

    await collectApiCallsByAuthType(new CloudWatchClient({}), WEB_ACL_NAME, REGION);

    const input = cloudWatchMock.commandCalls(GetMetricDataCommand)[0]?.args[0]
      .input;
    const queries = input?.MetricDataQueries ?? [];
    const ruleOf = (id: string) =>
      queries
        .find((query) => query.Id === id)
        ?.MetricStat?.Metric?.Dimensions?.find((dim) => dim.Name === "Rule")
        ?.Value;
    const dimsOf = (id: string) =>
      queries.find((query) => query.Id === id)?.MetricStat?.Metric?.Dimensions;

    expect(ruleOf("user")).toBe(WAF_HUMAN_CALLS_METRIC_NAME);
    expect(ruleOf("m2m")).toBe(WAF_M2M_CALLS_METRIC_NAME);
    expect(dimsOf("user")).toEqual(
      expect.arrayContaining([
        { Name: "WebACL", Value: WEB_ACL_NAME },
        { Name: "Region", Value: REGION },
      ]),
    );
    // Full-day Sum: one datapoint per day.
    expect(queries[0]?.MetricStat?.Stat).toBe("Sum");
    expect(queries[0]?.MetricStat?.Period).toBe(86_400);
  });

  it("queries the previous full UTC day, midnight-aligned", async () => {
    cloudWatchMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

    await collectApiCallsByAuthType(
      new CloudWatchClient({}),
      WEB_ACL_NAME,
      REGION,
    );

    const input = cloudWatchMock.commandCalls(GetMetricDataCommand)[0]?.args[0]
      .input;
    const start = input?.StartTime as Date;
    const end = input?.EndTime as Date;

    // End is midnight UTC (start of today); start is exactly 24h earlier.
    expect(end.getTime() % 86_400_000).toBe(0);
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });

  it("normalizes a missing datapoint (no nonzero value reported) to 0", async () => {
    // CountedRequests reports only on a nonzero value, so a quiet rule yields
    // no result / empty Values.
    cloudWatchMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [{ Id: "user", Values: [8] }],
    });

    expect(
      await collectApiCallsByAuthType(
        new CloudWatchClient({}),
        WEB_ACL_NAME,
        REGION,
      ),
    ).toEqual({ m2m: 0, user: 8 });
  });

  it("returns zero counts when no metric data is returned at all", async () => {
    cloudWatchMock.on(GetMetricDataCommand).resolves({});

    expect(
      await collectApiCallsByAuthType(
        new CloudWatchClient({}),
        WEB_ACL_NAME,
        REGION,
      ),
    ).toEqual({ m2m: 0, user: 0 });
  });
});
