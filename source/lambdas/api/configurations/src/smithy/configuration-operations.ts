// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { GetIdentityVerificationAttributesCommand } from "@aws-sdk/client-ses";

import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { PersistedConfigSectionData } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { ConfigurationLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { parseRawJsonBody } from "@amzn/innovation-sandbox-commons/lambda/smithy/parse-raw-json-body.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  ConfigPutBodySchemas,
  ConfigSchemas,
  ConfigSection,
  ConfigSectionFields,
  ConfigurationResponseMetadata,
  hasCompleteConfigurationResponseMetadata,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  getUserEmail,
  isM2MUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import type {
  ConfigurationsApiService,
  GetConfigurationsServerInput,
  GetConfigurationsServerOutput,
  AdminConfiguration as SmithyAdminConfiguration,
  ConfigurationResponseMetadata as SmithyConfigurationResponseMetadata,
} from "@amzn/innovation-sandbox-api-server/configurations";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/configurations";

export type ConfigurationSmithyContext =
  IsbSmithyContext<ConfigurationLambdaEnvironment>;

type ConfigurationSectionOutput<T extends ConfigSection> =
  ConfigSectionFields<T> & {
    lastSavedBy: string | null;
    meta?: ConfigurationResponseMetadata;
  };

/**
 * Runs a read against the config/account-pool stores, logging which read failed
 * (with domain context) before rethrowing. The generated pipeline turns the
 * rethrown error into a 500; this line is what makes that 500 diagnosable — the
 * read path is otherwise silent (unlike the write path's SES/conflict logging).
 */
async function withReadContext<T>(
  logger: Logger,
  operation: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    logger.error(`configuration read failed: ${operation}`, {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Adapts a persisted section into the generated Smithy output: fields pass through;
 * `meta` timestamps are opaque strings (byte-exact concurrency token); `schemaVersion`
 * is dropped and a null `lastSavedBy`/absent `meta` for a never-saved section. `meta`
 * is emitted only when both timestamps are present;
 * the store already rejects corrupt records, so this guard is defense-in-depth.
 */
function toConfigurationOutput<T extends ConfigSection>(
  section: ConfigurationSectionOutput<ConfigSection>,
  sectionName: T,
  logger: Logger,
): SmithyAdminConfiguration[T] {
  const { meta, lastSavedBy, ...fields } = section;
  const complete = hasCompleteConfigurationResponseMetadata(meta);
  if (meta && !complete) {
    logger.warn(
      `configuration section '${sectionName}' has incomplete meta; treating as unsaved`,
    );
  }
  const responseMeta = complete
    ? ({
        createdTime: meta.createdTime,
        lastEditTime: meta.lastEditTime,
      } satisfies SmithyConfigurationResponseMetadata)
    : undefined;
  return {
    ...fields,
    lastSavedBy: lastSavedBy ?? undefined,
    meta: responseMeta,
  } as unknown as SmithyAdminConfiguration[T];
}

/** The stored section, or its code defaults with a null `lastSavedBy` and no meta. */
function readSection(
  stored: PersistedConfigSectionData<ConfigSection> | undefined,
  section: ConfigSection,
): ConfigurationSectionOutput<ConfigSection> {
  return stored ?? { ...ConfigSchemas[section].parse({}), lastSavedBy: null };
}

// The notification field validated against SES; also the `field` key in its 400
// payloads, which the frontend maps onto the inline input error. `satisfies keyof`
// ties the literal to the section schema so a field rename fails the build here
// rather than silently misrouting SES validation errors to a stale key.
const EMAIL_FROM_FIELD =
  "emailFrom" satisfies keyof PersistedConfigSectionData<"notification">;

/**
 * Identities to check for an address: the address itself plus every parent
 * domain up to the TLD, because SES verifies at the domain level.
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
 * Fail-closed SES check: rejects the save unless the address (or a parent
 * domain) is a verified SES identity. A failed SES call is treated as unverified
 * so an unverified address is never silently persisted.
 */
async function validateSesIdentity(
  logger: Logger,
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
    // Log the domain only, never the full address: `emailFrom` is modeled
    // `@sensitive` (redacted on the wire), so it must not appear in cleartext in
    // CloudWatch either. The domain is what a responder needs to know which SES
    // identity failed.
    const emailDomain = emailFrom.includes("@")
      ? emailFrom.slice(emailFrom.lastIndexOf("@") + 1)
      : "<redacted>";
    if (statusCode && statusCode < 500) {
      logger.error(
        "SES identity check denied — possible IAM misconfiguration",
        { emailDomain, error: message },
      );
    } else {
      logger.warn("SES identity check failed", { emailDomain, error: message });
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

/**
 * `GET /configurations` — every section (stored or code-default) plus the
 * deploy-time fields resolved outside the config store.
 */
function getConfigurations(logger: Logger) {
  return async (
    _input: GetConfigurationsServerInput,
    context: ConfigurationSmithyContext,
  ): Promise<GetConfigurationsServerOutput> => {
    const { env } = context.lambdaContext;

    // Wrap the store reads so a DynamoDB/SSM failure is logged with which read
    // failed before it becomes an undifferentiated 500 downstream.
    const storedSections = await withReadContext(
      logger,
      "getConfigurations:getAllSections",
      () => IsbServices.configStore(env).getAllSections(),
    );

    // Keep the aggregate mapping explicit so generated Smithy member changes
    // fail here instead of being hidden by a string-indexed loop.
    const sections = {
      leases: toConfigurationOutput(
        readSection(storedSections.leases, "leases"),
        "leases",
        logger,
      ),
      cleanup: toConfigurationOutput(
        readSection(storedSections.cleanup, "cleanup"),
        "cleanup",
        logger,
      ),
      notification: toConfigurationOutput(
        readSection(storedSections.notification, "notification"),
        "notification",
        logger,
      ),
      maintenance: toConfigurationOutput(
        readSection(storedSections.maintenance, "maintenance"),
        "maintenance",
        logger,
      ),
      termsOfService: toConfigurationOutput(
        readSection(storedSections.termsOfService, "termsOfService"),
        "termsOfService",
        logger,
      ),
      costReporting: toConfigurationOutput(
        readSection(storedSections.costReporting, "costReporting"),
        "costReporting",
        logger,
      ),
    } satisfies Pick<SmithyAdminConfiguration, ConfigSection>;

    const { isbManagedRegions } = await withReadContext(
      logger,
      "getConfigurations:accountPoolConfig",
      () => IsbServices.accountPoolStackConfigStore(env).get(),
    );

    const data = {
      ...sections,
      isbManagedRegions,
      awsAccessPortalUrl: env.AWS_ACCESS_PORTAL_URL,
    } satisfies SmithyAdminConfiguration;

    return {
      status: JSendStatus.SUCCESS,
      data,
    };
  };
}

/** `GET /configurations/{section}` for one section (literal path). */
function getSection(logger: Logger, section: ConfigSection) {
  return async (_input: unknown, context: ConfigurationSmithyContext) => {
    const { env } = context.lambdaContext;
    const stored = await withReadContext(logger, `getSection:${section}`, () =>
      IsbServices.configStore(env).getSection(section),
    );
    return {
      status: JSendStatus.SUCCESS,
      data: toConfigurationOutput(
        readSection(stored ?? undefined, section),
        section,
        logger,
      ),
    };
  };
}

/** `PUT /configurations/{section}` for one section (literal path). */
function updateSection(logger: Logger, section: ConfigSection) {
  return async (_input: unknown, context: ConfigurationSmithyContext) => {
    const { event, lambdaContext } = context;
    const { env, user } = lambdaContext;

    // Defense-in-depth backstop: `rejectM2mConfigWrites` already rejects M2M
    // writes before the pipeline (ahead of model validation), so this normally
    // never runs — it guards against a future handler-wiring change that drops
    // that middleware. Admin-only is enforced by the RBAC map.
    if (isM2MUser(user)) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [
            { message: "User is not authorized to update configuration." },
          ],
        },
      });
    }

    // Model validation (required/range/length/enum/type) already ran; this Zod
    // re-parse of the raw body is the sole owner of what the model cannot express
    // — `strict` unknown-key rejection, the `leases` cross-field rule, and the
    // request audit envelope — exactly as the Lease Templates domain does.
    const parseResult = ConfigPutBodySchemas[section].safeParse(
      parseRawJsonBody(event),
    );
    if (!parseResult.success) {
      throw createHttpJSendValidationError(parseResult.error);
    }

    const {
      meta,
      lastSavedBy: _lastSavedBy,
      ...fields
    } = parseResult.data as {
      meta?: { lastEditTime?: string };
      lastSavedBy?: unknown;
      [field: string]: unknown;
    };
    const expectedLastEditTime = meta?.lastEditTime;

    if (
      section === "notification" &&
      typeof fields[EMAIL_FROM_FIELD] === "string"
    ) {
      await validateSesIdentity(logger, fields[EMAIL_FROM_FIELD], env);
    }

    try {
      const data = await IsbServices.configStore(env).putSection(
        section,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fields as any,
        getUserEmail(user),
        expectedLastEditTime,
      );
      return {
        status: JSendStatus.SUCCESS,
        data: toConfigurationOutput(data, section, logger),
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
  };
}

/**
 * The `ConfigurationsApi` service. `GetConfigurations` plus a read and a write per
 * section (13 operations on literal paths). The per-section read/write operations
 * are structurally identical, so they are built from `getSection`/`updateSection`
 * factories keyed by section; the object is asserted to the generated interface
 * because those factories return one shared shape rather than each operation's
 * distinct generated types.
 */
export function configurationService(
  logger: Logger,
): ConfigurationsApiService<ConfigurationSmithyContext> {
  return {
    GetConfigurations: withDelegatedErrors(getConfigurations(logger)),
    GetLeasesConfiguration: withDelegatedErrors(getSection(logger, "leases")),
    UpdateLeasesConfiguration: withDelegatedErrors(
      updateSection(logger, "leases"),
    ),
    GetCleanupConfiguration: withDelegatedErrors(getSection(logger, "cleanup")),
    UpdateCleanupConfiguration: withDelegatedErrors(
      updateSection(logger, "cleanup"),
    ),
    GetNotificationConfiguration: withDelegatedErrors(
      getSection(logger, "notification"),
    ),
    UpdateNotificationConfiguration: withDelegatedErrors(
      updateSection(logger, "notification"),
    ),
    GetMaintenanceConfiguration: withDelegatedErrors(
      getSection(logger, "maintenance"),
    ),
    UpdateMaintenanceConfiguration: withDelegatedErrors(
      updateSection(logger, "maintenance"),
    ),
    GetTermsOfServiceConfiguration: withDelegatedErrors(
      getSection(logger, "termsOfService"),
    ),
    UpdateTermsOfServiceConfiguration: withDelegatedErrors(
      updateSection(logger, "termsOfService"),
    ),
    GetCostReportingConfiguration: withDelegatedErrors(
      getSection(logger, "costReporting"),
    ),
    UpdateCostReportingConfiguration: withDelegatedErrors(
      updateSection(logger, "costReporting"),
    ),
  } as unknown as ConfigurationsApiService<ConfigurationSmithyContext>;
}
