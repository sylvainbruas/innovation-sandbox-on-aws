// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Fn } from "aws-cdk-lib";
import { Construct } from "constructs";

import { CognitoPostDeployConfigurer } from "@amzn/innovation-sandbox-infrastructure/components/auth/cognito-post-deploy-configurer";
import { PreTokenGenerationLambda } from "@amzn/innovation-sandbox-infrastructure/components/auth/pre-token-generation-lambda";
import {
  DEV_FRONTEND_ORIGIN,
  isDevMode,
} from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";

export interface IsbAuthResourcesProps {
  namespace: string;
  idcAccountId: string;
  cognitoUserPoolId: string;
  cognitoUserPoolArn: string;
  cognitoAppClientId: string;
  resolvedBaseUrl: string;
  awsAccessPortalUrl: string;
}

export class IsbAuthResources extends Construct {
  constructor(scope: Construct, id: string, props: IsbAuthResourcesProps) {
    super(scope, id);

    const preTokenGeneration = new PreTokenGenerationLambda(
      this,
      "PreTokenGenerationLambda",
      {
        namespace: props.namespace,
        idcAccountId: props.idcAccountId,
        cognitoUserPoolArn: props.cognitoUserPoolArn,
      },
    );

    const devMode = isDevMode(scope);

    const callbackUrls = [Fn.join("", [props.resolvedBaseUrl, "/callback"])];
    // Sign-out lands on the IDC portal — clearing the Cognito session alone
    // can't end the IDC session, so we hand off rather than show an in-app page.
    const logoutUrls = [props.awsAccessPortalUrl];

    // In dev mode, also allow the local Vite dev server so the frontend can run
    // locally against the deployed API. The canonical URL stays first so it
    // remains the DefaultRedirectURI.
    // The logout url remains the IDC portal URL
    if (devMode) {
      callbackUrls.push(`${DEV_FRONTEND_ORIGIN}/callback`);
    }

    new CognitoPostDeployConfigurer(this, "CognitoPostDeployConfigurer", {
      namespace: props.namespace,
      userPoolId: props.cognitoUserPoolId,
      appClientId: props.cognitoAppClientId,
      preTokenGenLambdaArn:
        preTokenGeneration.lambda.lambdaFunction.functionArn,
      callbackUrls,
      logoutUrls,
    });
  }
}
