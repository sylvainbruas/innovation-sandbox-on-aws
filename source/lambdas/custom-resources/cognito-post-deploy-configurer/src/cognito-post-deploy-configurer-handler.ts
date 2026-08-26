// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  CloudFormationCustomResourceDeleteEvent,
  Context,
} from "aws-lambda";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  CognitoPostDeployEnvironment,
  CognitoPostDeployEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/cognito-post-deploy-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";

const tracer = new Tracer();
const logger = new Logger();

export interface CognitoPostDeployResourceProperties {
  UserPoolId: string;
  AppClientId: string;
  PreTokenGenLambdaArn: string;
  CallbackUrls: string[];
  LogoutUrls: string[];
}

type CognitoPostDeployContext = Context &
  ValidatedEnvironment<CognitoPostDeployEnvironment>;

const onCreateOrUpdate = async (
  props: CognitoPostDeployResourceProperties,
  context: CognitoPostDeployContext,
): Promise<CdkCustomResourceResponse> => {
  const {
    UserPoolId,
    AppClientId,
    PreTokenGenLambdaArn,
    CallbackUrls,
    LogoutUrls,
  } = props;

  const authService = IsbServices.authService(context.env);

  await authService.attachPreTokenGenerationTrigger({
    userPoolId: UserPoolId,
    lambdaArn: PreTokenGenLambdaArn,
  });

  await authService.updateAppClientUrls({
    userPoolId: UserPoolId,
    appClientId: AppClientId,
    callbackUrls: CallbackUrls,
    logoutUrls: LogoutUrls,
  });

  return {
    PhysicalResourceId: `cognito-post-deploy-${UserPoolId}`,
    Data: {
      Status: "SUCCESS",
      CallbackUrls,
      LogoutUrls,
    },
  };
};

const onDelete = async (
  event: CloudFormationCustomResourceDeleteEvent,
): Promise<CdkCustomResourceResponse> => {
  logger.info(
    "Retaining Cognito configuration on delete (trigger and URLs will remain)",
  );
  return {
    PhysicalResourceId: event.PhysicalResourceId,
    Data: {
      Status: "RETAINED",
    },
  };
};

const cognitoPostDeployHandler = async (
  event: CdkCustomResourceEvent<CognitoPostDeployResourceProperties>,
  context: CognitoPostDeployContext,
): Promise<CdkCustomResourceResponse> => {
  try {
    switch (event.RequestType) {
      case "Create":
      case "Update": {
        return await onCreateOrUpdate(event.ResourceProperties, context);
      }
      case "Delete": {
        return onDelete(event);
      }
    }
  } catch (error: unknown) {
    logger.error(
      "Failed to handle Cognito post-deploy configuration",
      error as Error,
    );
    throw error;
  }
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: CognitoPostDeployEnvironmentSchema,
  moduleName: "cognito-post-deploy-configurer",
}).handler(cognitoPostDeployHandler);
