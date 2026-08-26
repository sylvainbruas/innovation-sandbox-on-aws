// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Metric names for the WAF caller-mix count rules. Shared source of truth: the
// CDK (waf.ts) stamps them as visibilityConfig.metricName, the heartbeat
// collector reads CountedRequests back by the same names — they must match.
export const WAF_HUMAN_CALLS_METRIC_NAME = "IsbHumanApiCallsMetric";
export const WAF_M2M_CALLS_METRIC_NAME = "IsbM2mApiCallsMetric";

export const WAFV2_METRIC_NAMESPACE = "AWS/WAFV2";
export const WAFV2_COUNTED_REQUESTS_METRIC = "CountedRequests";
