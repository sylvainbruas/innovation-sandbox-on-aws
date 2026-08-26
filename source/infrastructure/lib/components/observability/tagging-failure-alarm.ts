// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { FilterPattern, LogGroup, MetricFilter } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface TaggingFailureAlarmProps {
  /**
   * Log group receiving TagResourceFailed structured logs from the lifecycle
   * Lambdas (leases-handler, accounts-handler, account-lifecycle-management).
   */
  readonly globalLogGroup: LogGroup;

  /**
   * Log group receiving TagResourceFailed structured logs from the durable
   * cleanup Lambda's finalize step.
   */
  readonly cleanupLogGroup: LogGroup;
}

/**
 * Alarm on `TagResourceFailed` structured log emissions across the ISB log
 * groups. Any `Organizations:TagResource` failure inside the ISB lifecycle
 * (approval, cleanup, ejection, cost-report-group update, Status tag writes)
 * increments the shared metric and trips this alarm.
 *
 * Per design §7, `TagResourceFailed` is the single reliability signal for
 * the account-tagging feature. Sustained low rates on this alarm are the
 * gate for retiring the legacy `LINKED_ACCOUNT` cost-attribution fallback.
 *
 * No alarm action is attached. Operators subscribe post-deploy via SNS or
 * their preferred notification mechanism — the AWS Solutions convention for
 * this repo (see `AssignmentDLQAlarm` and `ExecutionFailedAlarm` for
 * precedent).
 */
export class TaggingFailureAlarm extends Construct {
  public readonly alarm: Alarm;

  constructor(scope: Construct, id: string, props: TaggingFailureAlarmProps) {
    super(scope, id);

    const filterPattern = FilterPattern.stringValue(
      "$.logDetailType",
      "=",
      "TagResourceFailed",
    );

    const globalFilter = new MetricFilter(this, "GlobalTagFailedFilter", {
      logGroup: props.globalLogGroup,
      metricNamespace: "InnovationSandbox/Tagging",
      metricName: "TagResourceFailedGlobal",
      filterPattern,
      metricValue: "1",
      defaultValue: 0,
    });

    const cleanupFilter = new MetricFilter(this, "CleanupTagFailedFilter", {
      logGroup: props.cleanupLogGroup,
      metricNamespace: "InnovationSandbox/Tagging",
      metricName: "TagResourceFailedCleanup",
      filterPattern,
      metricValue: "1",
      defaultValue: 0,
    });

    this.alarm = new Alarm(this, "TagResourceFailedAlarm", {
      alarmDescription:
        "One or more `Organizations:TagResource` calls failed inside the ISB " +
        "lifecycle in the last hour. Failures leave sandbox accounts without " +
        "ISB-<namespace>:* tags, causing lease-monitoring to fall back to the legacy " +
        "LINKED_ACCOUNT cost-attribution path for the affected leases. " +
        "Investigate via structured logs (`logDetailType=TagResourceFailed`) " +
        "in the ISB log groups to determine the `reason` (TagSpaceExhausted " +
        "vs ApiError) and remediate.",
      metric: new MathExpression({
        expression: "global + cleanup",
        usingMetrics: {
          global: globalFilter.metric({
            period: Duration.hours(1),
            statistic: "Sum",
          }),
          cleanup: cleanupFilter.metric({
            period: Duration.hours(1),
            statistic: "Sum",
          }),
        },
        period: Duration.hours(1),
        label: "TagResourceFailedTotal",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
