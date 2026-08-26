// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { DateTime } from "luxon";

import {
  WAF_HUMAN_CALLS_METRIC_NAME,
  WAF_M2M_CALLS_METRIC_NAME,
  WAFV2_COUNTED_REQUESTS_METRIC,
  WAFV2_METRIC_NAMESPACE,
} from "@amzn/innovation-sandbox-commons/observability/waf-auth-metrics.js";

const ONE_DAY_SECONDS = 86_400;

export interface ApiCallsByAuthType {
  m2m: number;
  user: number;
}

/**
 * Reads WAF-allowed API call counts by caller type from the two count-rule
 * CountedRequests metrics, over the previous full UTC day (not a rolling 24h,
 * which would overlap/gap as the heartbeat's schedule drifts).
 */
export async function collectApiCallsByAuthType(
  cloudWatch: CloudWatchClient,
  webAclName: string,
  region: string,
): Promise<ApiCallsByAuthType> {
  const endTime = DateTime.utc().startOf("day");
  const startTime = endTime.minus({ days: 1 });

  const dimensions = (ruleMetricName: string) => [
    { Name: "WebACL", Value: webAclName },
    { Name: "Region", Value: region },
    { Name: "Rule", Value: ruleMetricName },
  ];

  const response = await cloudWatch.send(
    new GetMetricDataCommand({
      StartTime: startTime.toJSDate(),
      EndTime: endTime.toJSDate(),
      MetricDataQueries: [
        {
          Id: "user",
          MetricStat: {
            Metric: {
              Namespace: WAFV2_METRIC_NAMESPACE,
              MetricName: WAFV2_COUNTED_REQUESTS_METRIC,
              Dimensions: dimensions(WAF_HUMAN_CALLS_METRIC_NAME),
            },
            Period: ONE_DAY_SECONDS,
            Stat: "Sum",
          },
        },
        {
          Id: "m2m",
          MetricStat: {
            Metric: {
              Namespace: WAFV2_METRIC_NAMESPACE,
              MetricName: WAFV2_COUNTED_REQUESTS_METRIC,
              Dimensions: dimensions(WAF_M2M_CALLS_METRIC_NAME),
            },
            Period: ONE_DAY_SECONDS,
            Stat: "Sum",
          },
        },
      ],
    }),
  );

  // Stat: "Sum" aggregates within a period; this sums across the returned
  // datapoints (a midnight-aligned day yields one, but the window could widen)
  // and normalizes the no-datapoint case (quiet rule) to 0.
  const sumForId = (id: string) =>
    (
      response.MetricDataResults?.find((result) => result.Id === id)?.Values ??
      []
    ).reduce((total, value) => total + value, 0);

  return { m2m: sumForId("m2m"), user: sumForId("user") };
}
