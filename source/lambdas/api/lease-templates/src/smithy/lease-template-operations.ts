// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";

import type {
  CreateLeaseTemplateServerInput,
  CreateLeaseTemplateServerOutput,
  DeleteLeaseTemplateServerInput,
  DeleteLeaseTemplateServerOutput,
  GetLeaseTemplateServerInput,
  GetLeaseTemplateServerOutput,
  LeaseTemplate as LeaseTemplateOutput,
  LeaseTemplatesApiService,
  ListLeaseTemplatesServerInput,
  ListLeaseTemplatesServerOutput,
  UpdateLeaseTemplateServerInput,
  UpdateLeaseTemplateServerOutput,
} from "@amzn/innovation-sandbox-api-server/lease-templates";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/lease-templates";
import { UnknownItem } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  validateLeaseTemplateCompliesWithGlobalConfig,
  ValidationException,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import {
  PersistedLeaseTemplate,
  PersistedLeaseTemplateMetadataSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { validateCostReportGroup } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config-utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { LeaseTemplateLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { parseRawJsonBody } from "@amzn/innovation-sandbox-commons/lambda/smithy/parse-raw-json-body.js";
import {
  addCorrelationContext,
  LogPatterns,
  searchableLeaseTemplateProperties,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { LeaseTemplateWritableSchema } from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { getUserEmail } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import {
  authorizedToGetPrivateLeaseTemplates,
  resolveBlueprintName,
} from "@amzn/innovation-sandbox-lease-templates/lease-template-helpers.js";

export type LeaseTemplateSmithyContext =
  IsbSmithyContext<LeaseTemplateLambdaEnvironment>;

/**
 * Request bodies keep the pre-Smithy Zod contract. Smithy validates what the model
 * can express (required, length, `@range`, enum, type) before the operation runs;
 * these schemas run inside the operation and catch only what the model cannot:
 *  - `strictObject` unknown-key rejection (restJson1 silently drops unknown members);
 *  - refined formats — `blueprintId`'s UUID rule, `description`'s FreeText rule;
 *  - `.gt(0)` positivity on the `Double` amount/duration fields (`maxSpend`,
 *    `leaseDurationInHours`, threshold `dollarsSpent`/`hoursRemaining`) — the
 *    inclusive-only `@range` cannot express `.gt(0)`, so the model leaves them
 *    unconstrained (see `main.smithy`) and Zod owns the bound.
 * `POST` also rejects `meta`; `PUT` accepts it, matching the pre-Smithy `omit` sets.
 */
const createRequestSchema = LeaseTemplateWritableSchema;

const updateRequestSchema = LeaseTemplateWritableSchema.extend({
  meta: PersistedLeaseTemplateMetadataSchema.optional(),
});

/**
 * Adapts a persisted `PersistedLeaseTemplate` (the commons Zod type, whose `meta`
 * timestamps are ISO strings) into `LeaseTemplateOutput` — the generated Smithy
 * `LeaseTemplate` shape the operations return as their `data`. Both are "a lease
 * template"; the only real change is the two `meta` timestamps, which the generated
 * serializer's `serializeDateTime` requires as JS `Date`s, so the stored ISO strings
 * are parsed to `Date` here. Every other member passes through unchanged.
 *
 * On the wire the serializer then alphabetizes members, drops `null`s, and
 * normalizes the timestamp form (`.000Z` → `Z`) — deviations from the pre-Smithy
 * wire that are accepted, since no consumer depends on them (the frontend adapter
 * parses into typed objects and canonicalizes null/absent).
 */
function toLeaseTemplateOutput(
  template: PersistedLeaseTemplate,
): LeaseTemplateOutput {
  // LeaseTemplateOutput validates the transformed values. Requiring every
  // persisted key makes optional members mandatory in this mapping, so adding a
  // persisted field fails compilation until the adapter handles it explicitly.
  type ExhaustiveLeaseTemplateOutputMapping = LeaseTemplateOutput &
    Record<keyof PersistedLeaseTemplate, unknown>;

  const mapped = {
    uuid: template.uuid,
    name: template.name,
    description: template.description,
    requiresApproval: template.requiresApproval,
    createdBy: template.createdBy,
    visibility: template.visibility,
    maxSpend: template.maxSpend,
    budgetThresholds: template.budgetThresholds,
    leaseDurationInHours: template.leaseDurationInHours,
    durationThresholds: template.durationThresholds,
    costReportGroup: template.costReportGroup,
    blueprintId: template.blueprintId ?? undefined,
    blueprintName: template.blueprintName ?? undefined,
    allowOwnerToShareLease: template.allowOwnerToShareLease,
    meta: template.meta
      ? {
          createdTime: template.meta.createdTime
            ? DateTime.fromISO(template.meta.createdTime, {
                zone: "utc",
              }).toJSDate()
            : undefined,
          lastEditTime: template.meta.lastEditTime
            ? DateTime.fromISO(template.meta.lastEditTime, {
                zone: "utc",
              }).toJSDate()
            : undefined,
          schemaVersion: template.meta.schemaVersion,
        }
      : undefined,
  } satisfies ExhaustiveLeaseTemplateOutputMapping;

  return mapped;
}

/**
 * Rethrows a `ValidationException` as the pre-Smithy 400 JSend error. Any other
 * error is a real fault and rethrown unchanged for `httpErrorHandler`.
 */
function throwValidationErrorAs400(error: unknown): never {
  if (error instanceof ValidationException) {
    throw createHttpJSendError({
      statusCode: 400,
      data: { errors: [{ message: error.message }] },
    });
  }
  throw error;
}

function listLeaseTemplates(logger: Logger) {
  return async (
    input: ListLeaseTemplatesServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<ListLeaseTemplatesServerOutput> => {
    const { lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    // No extra Zod parsing is required here: unlike create/update there is no
    // request body, and the whole input (`maxResults`, `pageIdentifier`) is
    // captured by the model, so the generated deserializer/validator has already
    // rejected anything invalid before this runs. Default `maxResults` to 2000
    // when absent, matching the pre-Smithy pagination default.
    const { result, nextPageIdentifier, error } =
      // Filter PRIVATE templates out at the query layer for non-elevated users so
      // that neither the result set nor the pagination token can disclose a
      // PRIVATE template's UUID.
      await leaseTemplateStore.findAllVisible({
        pageIdentifier: input.pageIdentifier,
        pageSize: input.maxResults ?? 2000,
        includePrivate: authorizedToGetPrivateLeaseTemplates(
          lambdaContext.user,
        ),
      });

    if (error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: Error while fetching lease templates - ${error}`,
      );
    }

    return {
      status: JSendStatus.SUCCESS,
      data: {
        result: result.map(toLeaseTemplateOutput),
        nextPageIdentifier: nextPageIdentifier ?? undefined,
      },
    };
  };
}

function createLeaseTemplate(logger: Logger) {
  return async (
    _input: CreateLeaseTemplateServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<CreateLeaseTemplateServerOutput> => {
    const { event, lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    // Model validation (required/length/enum/type) already passed. This Zod parse
    // of the raw body applies the pre-Smithy defaults and is the sole owner of what
    // the model cannot express — `strictObject` unknown keys, refined formats
    // (`blueprintId` UUID, `description` FreeText), and `.gt(0)` positivity on the
    // unconstrained `Double` amount/duration fields (see `createRequestSchema`
    // above). Its failures become the pre-Smithy validation error.
    const parsedBodyResult = createRequestSchema.safeParse(
      parseRawJsonBody(event),
    );
    if (!parsedBodyResult.success) {
      throw createHttpJSendValidationError(parsedBodyResult.error);
    }
    const requestData = parsedBodyResult.data;

    try {
      validateLeaseTemplateCompliesWithGlobalConfig(
        requestData,
        lambdaContext.globalConfig,
      );
      validateCostReportGroup(
        requestData.costReportGroup,
        lambdaContext.globalConfig.costReporting,
      );
    } catch (error) {
      throwValidationErrorAs400(error);
    }

    const blueprintName = await resolveBlueprintName(
      requestData.blueprintId,
      lambdaContext.env,
    );

    const newLeaseTemplate = await leaseTemplateStore.create({
      uuid: randomUUID(),
      createdBy: getUserEmail(lambdaContext.user),
      ...requestData,
      blueprintName,
    });

    addCorrelationContext(
      logger,
      searchableLeaseTemplateProperties(newLeaseTemplate),
    );

    logger.info(
      `Created new LeaseTemplate (${newLeaseTemplate.name}) (${newLeaseTemplate.uuid})`,
      summarizeUpdate({ oldItem: undefined, newItem: newLeaseTemplate }),
    );

    return {
      status: JSendStatus.SUCCESS,
      data: toLeaseTemplateOutput(newLeaseTemplate),
    };
  };
}

function getLeaseTemplate(logger: Logger) {
  return async (
    input: GetLeaseTemplateServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<GetLeaseTemplateServerOutput> => {
    const { lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    const leaseTemplateResponse = await leaseTemplateStore.get(
      input.leaseTemplateId,
    );
    const leaseTemplate = leaseTemplateResponse.result;
    if (leaseTemplateResponse.error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: Error retrieving lease template ${input.leaseTemplateId}: ${leaseTemplateResponse.error}`,
      );
    }

    if (
      !leaseTemplate ||
      (leaseTemplate.visibility === "PRIVATE" &&
        !authorizedToGetPrivateLeaseTemplates(lambdaContext.user))
    ) {
      throw createHttpJSendError({
        statusCode: 404,
        data: { errors: [{ message: "Lease template not found." }] },
      });
    }

    return {
      status: JSendStatus.SUCCESS,
      data: toLeaseTemplateOutput(leaseTemplate),
    };
  };
}

function updateLeaseTemplate(logger: Logger) {
  return async (
    input: UpdateLeaseTemplateServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<UpdateLeaseTemplateServerOutput> => {
    const { event, lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    // As in `createLeaseTemplate`: model validation already ran; this Zod parse
    // owns what the model cannot express — `strictObject` unknown keys, refined
    // formats (`blueprintId` UUID, `description` FreeText), and `.gt(0)` positivity
    // on the unconstrained `Double` fields (see `updateRequestSchema` above).
    const parsedBodyResult = updateRequestSchema.safeParse(
      parseRawJsonBody(event),
    );
    if (!parsedBodyResult.success) {
      throw createHttpJSendValidationError(parsedBodyResult.error);
    }

    // Fetch the existing template so config-compliance validation is
    // change-aware: a required-but-missing field (cost report group, max budget,
    // duration) shouldn't block edits to unrelated fields on a template that
    // predates the requirement.
    const existingTemplateResponse = await leaseTemplateStore.get(
      input.leaseTemplateId,
    );
    const existingTemplate = existingTemplateResponse.result;

    if (!existingTemplate) {
      throw createHttpJSendError({
        statusCode: 404,
        data: { errors: [{ message: `Lease Template not found.` }] },
      });
    }

    try {
      validateLeaseTemplateCompliesWithGlobalConfig(
        parsedBodyResult.data,
        lambdaContext.globalConfig,
        { previous: existingTemplate },
      );
      validateCostReportGroup(
        parsedBodyResult.data.costReportGroup,
        lambdaContext.globalConfig.costReporting,
        { previousCostReportGroup: existingTemplate.costReportGroup },
      );
    } catch (error) {
      throwValidationErrorAs400(error);
    }

    const resolvedBlueprintName = await resolveBlueprintName(
      parsedBodyResult.data.blueprintId,
      lambdaContext.env,
    );

    // createdBy is server-owned: absent from the request schema and restored
    // here from the persisted record.
    const leaseTemplate = {
      uuid: input.leaseTemplateId,
      ...parsedBodyResult.data,
      createdBy: existingTemplate.createdBy,
      blueprintName: resolvedBlueprintName,
    };

    let result;
    try {
      result = await leaseTemplateStore.update(leaseTemplate);
    } catch (error) {
      if (error instanceof UnknownItem) {
        throw createHttpJSendError({
          statusCode: 404,
          data: { errors: [{ message: `Lease Template not found.` }] },
        });
      }
      throw error;
    }

    logger.info(
      `Updated LeaseTemplate (${leaseTemplate.name})(${leaseTemplate.uuid})`,
      summarizeUpdate(result),
    );

    return {
      status: JSendStatus.SUCCESS,
      data: toLeaseTemplateOutput(result.newItem),
    };
  };
}

function deleteLeaseTemplate(logger: Logger) {
  return async (
    input: DeleteLeaseTemplateServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<DeleteLeaseTemplateServerOutput> => {
    const { lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    const itemId = input.leaseTemplateId;
    const deletedItem = await leaseTemplateStore.delete(itemId);
    if (deletedItem) {
      logger.info(
        `deleted lease template (${itemId})`,
        summarizeUpdate({ oldItem: deletedItem }),
      );
    } else {
      logger.info(
        `attempted to delete lease template (${itemId}), but it did not exist`,
      );
    }

    // The pre-Smithy body was `{"status":"success","data":null}`; the model output is
    // `{status}` only and the `data: null` is no longer restored — an accepted
    // deviation (the DELETE response body is not consumed by any client).
    return { status: JSendStatus.SUCCESS };
  };
}

/**
 * The five-operation `LeaseTemplatesApi` service. Conventional Smithy on the
 * inside — the mux routes, the model validates, the generated serializer writes
 * the body; the pre-Smithy request/response contract is preserved by the Zod
 * checks above and by `convertToIsbResponse` in the Lambda handler.
 */
export function leaseTemplateService(
  logger: Logger,
): LeaseTemplatesApiService<LeaseTemplateSmithyContext> {
  return {
    ListLeaseTemplates: withDelegatedErrors(listLeaseTemplates(logger)),
    CreateLeaseTemplate: withDelegatedErrors(createLeaseTemplate(logger)),
    GetLeaseTemplate: withDelegatedErrors(getLeaseTemplate(logger)),
    UpdateLeaseTemplate: withDelegatedErrors(updateLeaseTemplate(logger)),
    DeleteLeaseTemplate: withDelegatedErrors(deleteLeaseTemplate(logger)),
  };
}
