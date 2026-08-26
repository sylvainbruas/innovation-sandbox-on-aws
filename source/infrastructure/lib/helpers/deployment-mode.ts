// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Construct } from "constructs";

/**
 * Local Vite dev server origin. In dev mode the Cognito app client also
 * registers localhost callback/logout URLs so the frontend can run locally
 * against the deployed API without manual Cognito changes.
 */
export const DEV_FRONTEND_ORIGIN = "http://localhost:5173";

export function getDeploymentMode(scope: Construct): string {
  return scope.node.tryGetContext("deploymentMode") ?? "prod";
}

export function isDevMode(scope: Construct) {
  return getDeploymentMode(scope) === "dev";
}
