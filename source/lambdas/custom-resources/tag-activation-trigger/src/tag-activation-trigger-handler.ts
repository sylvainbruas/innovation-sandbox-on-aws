// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  CloudFormationCustomResourceCreateEvent,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
  Context,
} from "aws-lambda";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  TagActivationTriggerEnvironment,
  TagActivationTriggerEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/tag-activation-trigger-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  isbAccountTagKeys,
  toCeTagKey,
} from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";

type TagActivationTriggerContext = Context &
  ValidatedEnvironment<TagActivationTriggerEnvironment>;

const tracer = new Tracer();
const logger = new Logger();

const onCreateOrUpdate = async (
  event:
    | CloudFormationCustomResourceCreateEvent
    | CloudFormationCustomResourceUpdateEvent,
  context: TagActivationTriggerContext,
): Promise<CdkCustomResourceResponse> => {
  const physicalResourceId =
    event.RequestType === "Update"
      ? event.PhysicalResourceId
      : "IsbTagActivationTrigger";
  try {
    const sfnClient = IsbClients.stepFunctions(context.env);
    await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: context.env.STATE_MACHINE_ARN,
      }),
    );
  } catch (error) {
    // Fire-and-forget: never block stack deployment on an activation-workflow
    // failure. Customers can manually activate via the Billing Console as a
    // fallback (documented in the IG). Logged at error level so standard
    // CloudWatch error dashboards surface it.
    logger.error("Error starting tag activation workflow", error as Error);
  }
  return { PhysicalResourceId: physicalResourceId };
};

const onDelete = async (
  event: CloudFormationCustomResourceDeleteEvent,
  context: TagActivationTriggerContext,
): Promise<CdkCustomResourceResponse> => {
  try {
    const credentials = fromTemporaryIsbOrgManagementCredentials(context.env);
    const ceService = IsbServices.costExplorer(context.env, credentials);
    await ceService.setCostAllocationTagsStatus(
      isbAccountTagKeys(context.env.ISB_NAMESPACE).map(toCeTagKey),
      "Inactive",
    );
  } catch (error) {
    // Best-effort: must not block stack deletion. Historical cost data
    // remains queryable in Cost Explorer for AWS's retention window
    // regardless of whether deactivation succeeds. Logged at error level so
    // standard CloudWatch error dashboards surface it.
    logger.error("Error deactivating ISB cost allocation tags", error as Error);
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
};

const lambdaHandler = async (
  event: CdkCustomResourceEvent,
  context: TagActivationTriggerContext,
): Promise<CdkCustomResourceResponse> => {
  switch (event.RequestType) {
    case "Create":
    case "Update":
      logger.info("Isb Tag Activation Trigger on Create / Update");
      return onCreateOrUpdate(event, context);
    case "Delete":
      logger.info("Isb Tag Activation Trigger on Delete");
      return onDelete(event, context);
    default:
      return assertNever(event);
  }
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: TagActivationTriggerEnvironmentSchema,
  moduleName: "tag-activation-trigger",
}).handler(lambdaHandler);
