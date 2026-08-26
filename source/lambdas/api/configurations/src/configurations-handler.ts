// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { GetIdentityVerificationAttributesCommand } from "@aws-sdk/client-ses";
import middy from "@middy/core";
import httpRouterHandler, { Route } from "@middy/http-router";
import { APIGatewayProxyResult } from "aws-lambda";
import { z } from "zod";

import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import {
  AdminConfig,
  ConfigPutBodySchemas,
  ConfigSchemas,
  ConfigSection,
  ConfigSectionResponse,
  ConfigWriteSchemas,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  ConfigurationLambdaEnvironment,
  ConfigurationLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import apiMiddlewareBundle, {
  IsbApiContext,
  IsbApiEvent,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { httpJsonBodyParser } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-json-body-parser.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  getUserEmail,
  isM2MUser,
} from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";

const tracer = new Tracer();
const logger = new Logger();

const middyFactory = middy<
  IsbApiEvent,
  any,
  Error,
  ContextWithConfig & IsbApiContext<ConfigurationLambdaEnvironment>
>;

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/configurations",
    method: "GET",
    handler: middyFactory().handler(getAllConfigurationsHandler),
  },
  {
    path: "/configurations/{section}",
    method: "GET",
    handler: middyFactory().handler(getSectionHandler),
  },
  {
    path: "/configurations/{section}",
    method: "PUT",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(putSectionHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: ConfigurationLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(httpRouterHandler(routes));

async function getAllConfigurationsHandler(
  _event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<ConfigurationLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const configStore = IsbServices.configStore(context.env);
  const storedSections = await configStore.getAllSections();

  const sections = {} as {
    [Section in ConfigSection]: ConfigSectionResponse<Section>;
  };
  for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
    const stored = storedSections[section];
    if (stored) {
      (sections as Record<ConfigSection, unknown>)[section] = stored;
    } else {
      (sections as Record<ConfigSection, unknown>)[section] = {
        ...ConfigSchemas[section].parse({}),
        lastSavedBy: null,
      };
    }
  }

  const accountPoolConfigStore = IsbServices.accountPoolStackConfigStore(
    context.env,
  );
  const { isbManagedRegions } = await accountPoolConfigStore.get();

  const data: AdminConfig = {
    ...sections,
    isbManagedRegions,
    awsAccessPortalUrl: context.env.AWS_ACCESS_PORTAL_URL,
  };

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

function validateSectionParam(
  section: string | undefined,
): asserts section is ConfigSection {
  if (!section || !Object.hasOwn(ConfigSchemas, section)) {
    throw createHttpJSendError({
      statusCode: 404,
      data: { errors: [{ message: "Configuration section not found" }] },
    });
  }
}

function getConfigStore(
  context: ContextWithConfig & IsbApiContext<ConfigurationLambdaEnvironment>,
) {
  return IsbServices.configStore(context.env);
}

async function getSectionHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<ConfigurationLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const section = event.pathParameters?.section;
  validateSectionParam(section);

  const configStore = getConfigStore(context);
  const stored = await configStore.getSection(section);

  const data = stored ?? {
    ...ConfigSchemas[section].parse({}),
    lastSavedBy: null,
  };

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

// The notification field validated against SES. Also used as the `field` key
// in 400 error payloads, which the frontend maps onto the inline input error —
// deriving it from the schema keeps all uses in sync with the property name.
const EMAIL_FROM_FIELD = "emailFrom" satisfies keyof z.infer<
  (typeof ConfigWriteSchemas)["notification"]
>;

/**
 * Builds the list of identities to check for a given email address: the exact
 * address itself, plus every parent domain up to the TLD. SES treats a verified
 * domain as covering all addresses (and subdomains) beneath it.
 *
 * Example: "user@mail.corp.example.com" → checks
 *   ["user@mail.corp.example.com", "mail.corp.example.com", "corp.example.com", "example.com"]
 */
function buildIdentityChain(emailFrom: string): string[] {
  const atIndex = emailFrom.lastIndexOf("@");
  if (atIndex < 1) {
    return [emailFrom];
  }
  const domain = emailFrom.substring(atIndex + 1).toLowerCase();
  const labels = domain.split(".");
  const identities = [emailFrom];
  for (let i = 0; i < labels.length - 1; i++) {
    identities.push(labels.slice(i).join("."));
  }
  return identities;
}

/**
 * Validates that an email address is backed by a verified SES identity in this
 * account. Checks the exact address and every parent domain (SES verifies at
 * the domain level). Fail-closed: if the SES call itself errors, the save is
 * rejected so an unverified address is never silently persisted.
 */
async function validateSesIdentity(
  emailFrom: string,
  env: { USER_AGENT_EXTRA: string },
): Promise<void> {
  if (!emailFrom) {
    return;
  }
  const identities = buildIdentityChain(emailFrom);

  let verificationAttributes: Record<string, { VerificationStatus?: string }>;
  try {
    const sesClient = IsbClients.ses(env);
    const response = await sesClient.send(
      new GetIdentityVerificationAttributesCommand({ Identities: identities }),
    );
    verificationAttributes = response.VerificationAttributes ?? {};
  } catch (error: unknown) {
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    const message = error instanceof Error ? error.message : String(error);
    if (statusCode && statusCode < 500) {
      logger.error(
        "SES identity check denied — possible IAM misconfiguration",
        {
          emailFrom,
          error: message,
        },
      );
    } else {
      logger.warn("SES identity check failed", { emailFrom, error: message });
    }
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            field: EMAIL_FROM_FIELD,
            message:
              "Unable to verify this email against SES. Please try again shortly.",
          },
        ],
      },
    });
  }

  const verified = identities.some(
    (id) => verificationAttributes[id]?.VerificationStatus === "Success",
  );

  if (!verified) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            field: EMAIL_FROM_FIELD,
            message:
              "The email provided is not a verified SES identity in this account. Verify the address or its domain in Amazon SES before saving.",
          },
        ],
      },
    });
  }
}

async function putSectionHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<ConfigurationLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const section = event.pathParameters?.section;
  validateSectionParam(section);

  if (isM2MUser(context.user)) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [
          { message: "User is not authorized to update configuration." },
        ],
      },
    });
  }

  const parseResult = ConfigPutBodySchemas[section].safeParse(event.body);
  if (!parseResult.success) {
    throw createHttpJSendValidationError(parseResult.error);
  }

  const { meta, lastSavedBy: _lastSavedBy, ...fields } = parseResult.data;
  const expectedLastEditTime = meta?.lastEditTime;

  if (section === "notification" && EMAIL_FROM_FIELD in fields) {
    await validateSesIdentity(fields[EMAIL_FROM_FIELD], context.env);
  }

  const editedBy = getUserEmail(context.user);

  const configStore = getConfigStore(context);
  try {
    const data = await configStore.putSection(
      section,
      fields as z.infer<(typeof ConfigWriteSchemas)[ConfigSection]>,
      editedBy,
      expectedLastEditTime,
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    if (error instanceof ConflictError) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message:
                "Configuration was modified by another administrator. Reload to see the latest values.",
            },
          ],
        },
      });
    }
    throw error;
  }
}
