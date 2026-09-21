// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { LeaseTemplateLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import {
  type IsbRole,
  type IsbUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

/**
 * Shared across the Smithy-bound `/leaseTemplates` operations:
 * `authorizedToGetPrivateLeaseTemplates` by list/get, `resolveBlueprintName` by
 * create/update.
 */
export function authorizedToGetPrivateLeaseTemplates(user: IsbUser) {
  return user.roles.some(
    (role: IsbRole) => role === "Admin" || role === "Manager",
  );
}

export async function resolveBlueprintName(
  blueprintId: string | null | undefined,
  env: LeaseTemplateLambdaEnvironment,
): Promise<string | null> {
  if (!blueprintId) return null;
  const blueprintStore = IsbServices.blueprintStore(env);
  const blueprintResult = await blueprintStore.get(blueprintId);
  if (!blueprintResult.result) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            message: "Referenced blueprint not found.",
          },
        ],
      },
    });
  }
  return blueprintResult.result.blueprint.name;
}
