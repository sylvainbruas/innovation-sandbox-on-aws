// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Callback relay Lambda: bridges CodeBuild Build State Change events
 * to the durable function's callback API.
 *
 * Flow:
 *  1. EventBridge delivers a CodeBuild Build State Change event (terminal status)
 *  2. Extract the build ID from the event
 *  3. Call BatchGetBuilds to retrieve the DURABLE_CALLBACK_ID env var
 *  4. Call SendDurableExecutionCallbackSuccess or SendDurableExecutionCallbackFailure
 */

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { BatchGetBuildsCommand } from "@aws-sdk/client-codebuild";
import {
  SendDurableExecutionCallbackFailureCommand,
  SendDurableExecutionCallbackSuccessCommand,
} from "@aws-sdk/client-lambda";
import { EventBridgeEvent } from "aws-lambda";

const logger = new Logger({ serviceName: "CallbackRelay" });

interface CodeBuildStateChangeDetail {
  "build-status": string;
  "project-name": string;
  "build-id": string;
}

type CodeBuildStateChangeEvent = EventBridgeEvent<
  "CodeBuild Build State Change",
  CodeBuildStateChangeDetail
>;

export async function handler(event: CodeBuildStateChangeEvent): Promise<void> {
  const env = BaseLambdaEnvironmentSchema.parse(process.env);
  const codeBuildClient = IsbClients.codeBuild(env);
  const lambdaClient = IsbClients.lambda(env);

  const buildId = event.detail["build-id"];
  const buildStatus = event.detail["build-status"];

  logger.info("Processing CodeBuild state change", {
    buildId,
    buildStatus,
  });

  const buildsResponse = await codeBuildClient.send(
    new BatchGetBuildsCommand({ ids: [buildId] }),
  );

  const build = buildsResponse.builds?.[0];
  if (!build) {
    logger.error("Build not found", { buildId });
    return;
  }

  const callbackIdVar = build.environment?.environmentVariables?.find(
    (v: { name?: string; value?: string }) => v.name === "DURABLE_CALLBACK_ID",
  );

  if (!callbackIdVar?.value) {
    logger.warn("No DURABLE_CALLBACK_ID env var found, skipping", {
      buildId,
    });
    return;
  }

  const callbackId = callbackIdVar.value;

  if (buildStatus === "SUCCEEDED") {
    await lambdaClient.send(
      new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: callbackId,
        Result: new TextEncoder().encode(
          JSON.stringify({ buildStatus, buildId }),
        ),
      }),
    );
  } else {
    await lambdaClient.send(
      new SendDurableExecutionCallbackFailureCommand({
        CallbackId: callbackId,
        Error: {
          ErrorType: "CodeBuildFailure",
          ErrorMessage: `Build ${buildId} finished with status: ${buildStatus}`,
        },
      }),
    );
  }

  logger.info("Callback sent", { callbackId, buildStatus, buildId });
}
