// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ConcurrencyMode,
  RegionConcurrencyType,
} from "@amzn/innovation-sandbox-shared/types/blueprint";

import type {
  BlueprintView,
  BlueprintWithStackSetsView,
  DeploymentHistoryView,
  StackSetConfigView,
  StackSetView,
} from "./model";

/** Deployment strategy presets used by the registration wizard. */
export type DeploymentStrategy = "Default" | "Custom";

/** Display form of the API's uppercase region-concurrency value. */
export type RegionConcurrencyTypeUI = "Sequential" | "Parallel";

export const REGION_CONCURRENCY_OPTIONS = {
  SEQUENTIAL: {
    value: "Sequential" as const,
    label: "Sequential",
    description: "Deploy to one region at a time",
  },
  PARALLEL: {
    value: "Parallel" as const,
    label: "Parallel",
    description: "Deploy to all regions simultaneously",
  },
} as const;

export const CONCURRENCY_MODE_OPTIONS = {
  STRICT: {
    value: "STRICT_FAILURE_TOLERANCE" as const,
    label: "Strict",
    description: "Reduces concurrency as failures occur",
  },
  SOFT: {
    value: "SOFT_FAILURE_TOLERANCE" as const,
    label: "Soft",
    description: "Maintains maximum concurrency",
  },
} as const;

export const getConcurrencyModeLabel = (mode: ConcurrencyMode): string => {
  const option = Object.values(CONCURRENCY_MODE_OPTIONS).find(
    (candidate) => candidate.value === mode,
  );
  return option ? `${option.label}: ${option.description}` : mode;
};

export interface DeploymentConfig {
  regionConcurrencyType: RegionConcurrencyTypeUI;
  maxConcurrentPercentage: number;
  failureTolerancePercentage: number;
  concurrencyMode: ConcurrencyMode;
}

export interface DeploymentStrategyConfig extends DeploymentConfig {
  label: string;
  description: string;
}

export const DEPLOYMENT_STRATEGY_CONFIGS: Record<
  DeploymentStrategy,
  DeploymentStrategyConfig
> = {
  Default: {
    regionConcurrencyType: "Sequential",
    maxConcurrentPercentage: 100,
    failureTolerancePercentage: 0,
    concurrencyMode: "STRICT_FAILURE_TOLERANCE",
    label: "Default",
    description:
      "Deploys one region at a time with 0% failure tolerance. Safest approach.",
  },
  Custom: {
    regionConcurrencyType: "Sequential",
    maxConcurrentPercentage: 100,
    failureTolerancePercentage: 0,
    concurrencyMode: "STRICT_FAILURE_TOLERANCE",
    label: "Custom",
    description: "Configure each deployment parameter individually",
  },
} as const;

export interface RegisterBlueprintRequest {
  name: string;
  stackSetId: string;
  regions: string[];
  tags?: Record<string, string>;
  deploymentTimeoutMinutes?: number;
  regionConcurrencyType?: RegionConcurrencyType;
  maxConcurrentPercentage?: number;
  failureTolerancePercentage?: number;
  concurrencyMode?: ConcurrencyMode;
}

export type UpdateBlueprintRequest = Partial<
  Pick<
    BlueprintView,
    "name" | "tags" | "deploymentTimeoutMinutes" | "regionConcurrencyType"
  >
> &
  Partial<
    Pick<
      StackSetConfigView,
      | "maxConcurrentPercentage"
      | "failureTolerancePercentage"
      | "concurrencyMode"
    >
  >;

export interface BlueprintListResponse {
  blueprints: BlueprintWithStackSetsView[];
  nextPageIdentifier?: string;
}

export interface BlueprintDetailResponse {
  blueprint: BlueprintView;
  stackSets: StackSetConfigView[];
  recentDeployments?: DeploymentHistoryView[];
}

export interface StackSetListResponse {
  result: StackSetView[];
  nextPageIdentifier?: string;
}
