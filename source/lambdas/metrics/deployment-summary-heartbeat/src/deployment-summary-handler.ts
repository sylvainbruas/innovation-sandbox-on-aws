// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { Context } from "aws-lambda";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  DeploymentSummaryLambdaEnvironment,
  DeploymentSummaryLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-summary-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

import { collectApiCallsByAuthType } from "./api-call-mix.js";
import { countM2mClients } from "./m2m-client-discovery.js";
import { collectMetric } from "./metric-task.js";
import {
  getScpMetrics,
  summarizeAccountPool,
  summarizeBlueprints,
  summarizeMultiUserLeases,
} from "./metrics-collectors.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "HeartbeatMetrics" });

const MINUTE_MS = 60_000;
// Per-collector timeout budgets. Generous by design — the timeout is a safety
// net so one stuck collector can't consume the whole (15-min) Lambda, not an
// SLA. HEAVY is for the multi-call scans (blueprints, multi-user leases).
const DEFAULT_TIMEOUT_MS = 2 * MINUTE_MS;
const HEAVY_TIMEOUT_MS = 5 * MINUTE_MS;

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: DeploymentSummaryLambdaEnvironmentSchema,
  moduleName: "metrics",
})
  .use(isbConfigMiddleware())
  .handler(summarizeDeployment);

async function summarizeDeployment(
  _event: unknown,
  context: Context &
    ValidatedEnvironment<DeploymentSummaryLambdaEnvironment> &
    ContextWithConfig,
) {
  const { env } = context;

  // leaseTemplates is itself a table scan, and feeds both the counts below and
  // multiUserLeases; fetching it once up front lets multiUserLeases stay a
  // separate collector with its own (larger) timeout budget. Folding all
  // lease-template work into one collector would read cleaner but hide the
  // cost/slowness of the multiUserLeases scan.
  const leaseTemplates = await collectLeaseTemplates(env);

  // Independent collectors run concurrently. Each is individually
  // timeout-guarded with a fallback (see the collect* helpers), so a single
  // slow/failing collector degrades only its own fields, not the whole
  // heartbeat.
  const [
    numM2mClients,
    blueprints,
    accountPool,
    scpMetrics,
    multiUserLeases,
    dailyApiCallsByAuthType,
  ] = await Promise.all([
    collectM2mClientCount(env),
    collectBlueprints(env),
    collectAccountPool(env),
    collectScpMetrics(env),
    collectMultiUserLeases(env, leaseTemplates),
    collectApiCallMix(env),
  ]);

  logger.info("ISB Deployment Summary", {
    logDetailType: "DeploymentSummary",
    numM2mClients,
    numLeaseTemplates: leaseTemplates.length,
    numLeaseTemplatesWithBlueprint: leaseTemplates.filter(
      (template) => !!template.blueprintId,
    ).length,
    ...blueprints,
    config: {
      numCostReportGroups:
        context.globalConfig.costReporting.costReportGroups.length,
      requireMaxBudget: context.globalConfig.leases.requireMaxBudget,
      maxBudget: context.globalConfig.leases.maxBudget,
      requireMaxDuration: context.globalConfig.leases.requireMaxDuration,
      maxDurationHours: context.globalConfig.leases.maxDurationHours,
      maxLeasesPerUser: context.globalConfig.leases.maxLeasesPerUser,
      requireCostReportGroup:
        context.globalConfig.costReporting.requireCostReportGroup,
      numberOfFailedAttemptsToCancelCleanup:
        context.globalConfig.cleanup.numberOfFailedAttemptsToCancelCleanup,
      waitBeforeRetryFailedAttemptSeconds:
        context.globalConfig.cleanup.waitBeforeRetryFailedAttemptSeconds,
      numberOfSuccessfulAttemptsToFinishCleanup:
        context.globalConfig.cleanup.numberOfSuccessfulAttemptsToFinishCleanup,
      waitBeforeRerunSuccessfulAttemptSeconds:
        context.globalConfig.cleanup.waitBeforeRerunSuccessfulAttemptSeconds,
      isStableTaggingEnabled: context.env.IS_STABLE_TAGGING_ENABLED === "Yes",
      isMultiAccountDeployment:
        context.env.ORG_MGT_ACCOUNT_ID !== context.env.HUB_ACCOUNT_ID,
      allowUserLeaseTermination:
        context.globalConfig.leases.allowUserLeaseTermination,
      leaseRequestWindowHours:
        context.globalConfig.leases.leaseRequestWindowHours,
      maxLeaseRequestsPerWindow:
        context.globalConfig.leases.maxLeaseRequestsPerWindow,
      leaseSharingEnabled: context.globalConfig.leases.leaseSharingEnabled,
      enablePrincipalSearch: context.globalConfig.leases.enablePrincipalSearch,
    },
    accountPool,
    ...scpMetrics,
    ...multiUserLeases,
    dailyApiCallsByAuthType,
  } satisfies SubscribableLog);
}

// Each collect* helper binds one collector to its name, timeout budget, and
// fallback. Failures degrade to the fallback (logged) rather than failing the
// heartbeat. Add a new metric by adding a helper and a line in Promise.all.

function collectLeaseTemplates(env: DeploymentSummaryLambdaEnvironment) {
  const store = IsbServices.leaseTemplateStore(env);
  return collectMetric(logger, "leaseTemplates", DEFAULT_TIMEOUT_MS, [], () =>
    collect(stream(store, store.findAll, {})),
  );
}

function collectM2mClientCount(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(logger, "numM2mClients", DEFAULT_TIMEOUT_MS, 0, () =>
    countM2mClients(IsbClients.iam(env), env.ISB_NAMESPACE),
  );
}

function collectApiCallMix(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(
    logger,
    "dailyApiCallsByAuthType",
    DEFAULT_TIMEOUT_MS,
    { m2m: 0, user: 0 },
    () =>
      collectApiCallsByAuthType(
        IsbClients.cloudWatch(env),
        env.WAF_WEB_ACL_NAME,
        env.WAF_REGION,
      ),
  );
}

function collectBlueprints(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(
    logger,
    "blueprints",
    HEAVY_TIMEOUT_MS,
    { numBlueprints: 0, blueprintServiceCounts: {} },
    () =>
      summarizeBlueprints(
        logger,
        IsbServices.blueprintStore(env),
        IsbClients.cloudFormation(env),
      ),
  );
}

function collectAccountPool(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(
    logger,
    "accountPool",
    DEFAULT_TIMEOUT_MS,
    { available: 0, active: 0, frozen: 0, cleanup: 0, quarantine: 0 },
    () =>
      summarizeAccountPool(
        IsbServices.orgsService(
          env,
          fromTemporaryIsbOrgManagementCredentials(env),
        ),
      ),
  );
}

function collectScpMetrics(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(
    logger,
    "scpMetrics",
    DEFAULT_TIMEOUT_MS,
    {
      additionalAllowedServicesList: [],
      bedrockInferenceProfilePatternsList: [],
    },
    async () =>
      getScpMetrics(
        logger,
        await IsbServices.accountPoolStackConfigStore(env).get(),
        IsbClients.accessAnalyzer(env),
      ),
  );
}

function collectMultiUserLeases(
  env: DeploymentSummaryLambdaEnvironment,
  leaseTemplates: LeaseTemplate[],
) {
  return collectMetric(
    logger,
    "multiUserLeases",
    HEAVY_TIMEOUT_MS,
    {
      numTemplatesWithSharing: 0,
      numLeasesWithAssignments: 0,
      totalUserAssignments: 0,
      totalGroupAssignments: 0,
      avgAssignmentsPerLease: 0,
      maxAssignmentsPerLease: 0,
    },
    () =>
      summarizeMultiUserLeases(leaseTemplates, IsbServices.principalStore(env)),
  );
}
