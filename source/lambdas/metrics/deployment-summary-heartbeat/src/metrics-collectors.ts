// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  AccessAnalyzerClient,
  PolicyType,
  ValidatePolicyCommand,
} from "@aws-sdk/client-accessanalyzer";
import {
  CloudFormationClient,
  GetTemplateSummaryCommand,
} from "@aws-sdk/client-cloudformation";

import { AccountPoolConfig } from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config.js";
import { BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { getCloudFormationTemplateServices } from "@amzn/innovation-sandbox-commons/utils/stack-set-parser.js";

export async function summarizeAccountPool(orgsService: SandboxOuService) {
  return {
    available: (await orgsService.listAllAccountsInOU("Available")).length,
    active: (await orgsService.listAllAccountsInOU("Active")).length,
    frozen: (await orgsService.listAllAccountsInOU("Frozen")).length,
    cleanup: (await orgsService.listAllAccountsInOU("CleanUp")).length,
    quarantine: (await orgsService.listAllAccountsInOU("Quarantine")).length,
  };
}

export async function getScpMetrics(
  logger: Logger,
  accountPoolConfig: AccountPoolConfig,
  accessAnalyzerClient: AccessAnalyzerClient,
): Promise<{
  additionalAllowedServicesList: string[];
  bedrockInferenceProfilePatternsList: string[];
}> {
  const allServices = parseCommaSeparatedList(
    accountPoolConfig.additionalAllowedServices,
  );

  return {
    additionalAllowedServicesList:
      allServices.length > 0
        ? await filterValidIamActions(logger, allServices, accessAnalyzerClient)
        : [],
    bedrockInferenceProfilePatternsList: parseCommaSeparatedList(
      accountPoolConfig.bedrockInferenceProfilePatterns,
    ).flatMap((arn) => {
      const slashIdx = arn.indexOf("/");
      return slashIdx === -1 ? [] : [arn.substring(slashIdx + 1)];
    }),
  };
}

async function filterValidIamActions(
  logger: Logger,
  actions: string[],
  accessAnalyzerClient: AccessAnalyzerClient,
): Promise<string[]> {
  try {
    const policyDocument = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: actions, Resource: "*" }],
    });

    const response = await accessAnalyzerClient.send(
      new ValidatePolicyCommand({
        policyDocument,
        policyType: PolicyType.IDENTITY_POLICY,
      }),
    );

    const invalidActions = new Set(
      response.findings
        ?.filter(
          (f) =>
            f.findingType === "ERROR" &&
            (f.issueCode === "INVALID_SERVICE_IN_ACTION" ||
              f.issueCode === "INVALID_ACTION"),
        )
        ?.map((f) => {
          // Primary: find "Action" in the path, take the next entry's index
          const path = f.locations?.at(0)?.path ?? [];
          const actionKeyIdx = path.findIndex((p) => p.value === "Action");
          const actionIndex = path[actionKeyIdx + 1]?.index;
          if (actionIndex !== undefined) {
            return actions[actionIndex];
          }
          // Fallback: parse full action string from findingDetails message if path structure is unexpected
          // Handles both "The service X specified..." (INVALID_SERVICE_IN_ACTION) and "The action X does not exist." (INVALID_ACTION)
          return (
            f.findingDetails?.match(/The service (\S+) specified/)?.[1] ??
            f.findingDetails?.match(/The action (\S+) does not exist/)?.[1]
          );
        })
        ?.filter((a): a is string => a !== undefined),
    );

    if (invalidActions.size > 0) {
      logger.warn("Filtering invalid IAM actions from metrics", {
        invalidActions: [...invalidActions],
      });
    }

    return actions.filter((a) => !invalidActions.has(a));
  } catch (error) {
    logger.warn(
      "Failed to validate IAM actions, skipping additionalAllowedServicesList metric",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return [];
  }
}

function parseCommaSeparatedList(value: string | undefined): string[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value.split(",").map((item) => item.trim());
}

export async function summarizeBlueprints(
  logger: Logger,
  blueprintStore: BlueprintStore,
  cfnClient: CloudFormationClient,
): Promise<{
  numBlueprints: number;
  blueprintServiceCounts: Record<string, number>;
}> {
  const blueprints = await collect(
    stream(blueprintStore, blueprintStore.listBlueprints, {}),
  );

  const serviceCounts: Record<string, number> = {};

  // listBlueprints returns empty stackSets for performance, so we still need
  // get() per blueprint for the full stack-set details.
  const blueprintWithStackSets = await Promise.all(
    blueprints.map((blueprint) =>
      blueprintStore.get(blueprint.blueprint.blueprintId),
    ),
  );

  const stackSetIds = blueprintWithStackSets.flatMap(
    (blueprint) =>
      blueprint.result?.stackSets?.map((stackSet) => stackSet.stackSetId) ?? [],
  );

  await Promise.all(
    stackSetIds.map(async (stackSetId) => {
      // Skip a single unreadable StackSet rather than dropping the whole
      // metric — the others still contribute their counts.
      try {
        const response = await cfnClient.send(
          new GetTemplateSummaryCommand({ StackSetName: stackSetId }),
        );

        const resourceTypes = response.ResourceTypes ?? [];
        if (resourceTypes.length === 0) {
          return;
        }

        const templateServiceCounts =
          getCloudFormationTemplateServices(resourceTypes);

        Object.entries(templateServiceCounts).forEach(([service, count]) => {
          serviceCounts[service] = (serviceCounts[service] || 0) + count;
        });
      } catch (error) {
        logger.warn("Failed to analyze StackSet", {
          stackSetId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return {
    numBlueprints: blueprints.length,
    blueprintServiceCounts: serviceCounts,
  };
}

export async function summarizeMultiUserLeases(
  leaseTemplates: LeaseTemplate[],
  principalStore: PrincipalStore,
): Promise<{
  numTemplatesWithSharing: number;
  numLeasesWithAssignments: number;
  totalUserAssignments: number;
  totalGroupAssignments: number;
  avgAssignmentsPerLease: number;
  maxAssignmentsPerLease: number;
}> {
  const numTemplatesWithSharing = leaseTemplates.filter(
    (template) => template.allowOwnerToShareLease === true,
  ).length;

  const assignments = await collect(
    stream(principalStore, principalStore.listAllAssignments, {
      pageSize: 1000,
    }),
  );

  let totalUserAssignments = 0;
  let totalGroupAssignments = 0;
  const leaseCountMap = new Map<string, number>();

  for (const assignment of assignments) {
    if (assignment.principalType === "USER") {
      totalUserAssignments++;
    } else {
      totalGroupAssignments++;
    }
    leaseCountMap.set(
      assignment.leaseId,
      (leaseCountMap.get(assignment.leaseId) ?? 0) + 1,
    );
  }

  const maxAssignmentsPerLease = [...leaseCountMap.values()].reduce(
    (max, count) => Math.max(max, count),
    0,
  );

  const numLeasesWithAssignments = leaseCountMap.size;
  const totalAssignments = totalUserAssignments + totalGroupAssignments;
  const avgAssignmentsPerLease =
    numLeasesWithAssignments > 0
      ? Math.round((totalAssignments / numLeasesWithAssignments) * 100) / 100
      : 0;

  return {
    numTemplatesWithSharing,
    numLeasesWithAssignments,
    totalUserAssignments,
    totalGroupAssignments,
    avgAssignmentsPerLease,
    maxAssignmentsPerLease,
  };
}
