// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { parse as parseArn } from "@aws-sdk/util-arn-parser";

export namespace AwsConsoleLink {
  export function cloudwatchLogInsights() {
    return "https://console.aws.amazon.com/cloudwatch/home#logsV2:logs-insights";
  }

  export function stateMachineExecution(cleanupExecutionArn: string) {
    return `https://console.aws.amazon.com/states/home#/v2/executions/details/${cleanupExecutionArn}`;
  }

  /**
   * Auto-detects ARN format and returns the appropriate console URL.
   * - Durable execution ARNs (containing "/durable-execution/") → Lambda durable execution console
   * - Step Functions execution ARNs → Step Functions execution console
   */
  export function executionConsoleUrl(arn: string): string {
    if (arn.includes("/durable-execution/")) {
      return durableExecution(arn);
    }
    return stateMachineExecution(arn);
  }

  /**
   * Generates a Lambda durable execution console URL from a durable execution ARN.
   *
   * ARN format: arn:aws:lambda:{region}:{accountId}:function:{functionName}:{qualifier}/durable-execution/{executionId}
   */
  export function durableExecution(executionArn: string) {
    const { region, resource } = parseArn(executionArn);

    // resource = "function:{functionName}:{qualifier}/durable-execution/{executionId}"
    const [type, functionName, qualifierAndExecution] = resource.split(":");
    const executionId = qualifierAndExecution?.split("/durable-execution/")[1];

    if (type !== "function" || !functionName || !executionId) {
      throw new Error(`Not a valid durable execution ARN: ${executionArn}`);
    }

    return `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/durable-executions/${functionName}/${executionId}`;
  }
}
