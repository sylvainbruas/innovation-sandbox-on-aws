// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Blueprints typed adapter over the generated aggregate `IsbClient`. The
// generated transport types stay at this boundary; explicit mappers validate
// them into frontend-owned views. List operations omit malformed entries while
// single-item operations surface malformed successful responses as errors.
import type { ZodType } from "zod";

import type {
  Blueprint,
  BlueprintHealthMetrics,
  BlueprintMetadata,
  BlueprintWithStackSets,
  DeploymentHistory,
  StackSetConfig,
  StackSetHealthMetrics,
  StackSetSummary,
} from "@amzn/innovation-sandbox-api-client";
import {
  DeleteBlueprintCommand,
  GetBlueprintCommand,
  IsbClient,
  ListBlueprintsCommand,
  ListStackSetsCommand,
  RegisterBlueprintCommand,
  UpdateBlueprintCommand,
} from "@amzn/innovation-sandbox-api-client";
import {
  BlueprintView,
  BlueprintViewSchema,
  BlueprintWithStackSetsView,
  BlueprintWithStackSetsViewSchema,
  StackSetViewSchema,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/model";
import {
  BlueprintDetailResponse,
  BlueprintListResponse,
  RegisterBlueprintRequest,
  StackSetListResponse,
  UpdateBlueprintRequest,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";

import { normalizeSmithyError } from "../../helpers/isbApiClient";
import { toValidListItems } from "../../helpers/validListItems";

export { createIsbClient as createBlueprintClient } from "../../helpers/isbApiClient";

export interface SmithyBlueprintApi {
  getBlueprints(): Promise<BlueprintListResponse>;
  getBlueprintById(id: string): Promise<BlueprintDetailResponse>;
  registerBlueprint(
    blueprint: RegisterBlueprintRequest,
  ): Promise<BlueprintView>;
  updateBlueprint(
    id: string,
    updates: UpdateBlueprintRequest,
  ): Promise<BlueprintWithStackSetsView>;
  unregisterBlueprint(id: string): Promise<void>;
  listStackSets(params?: {
    pageIdentifier?: string;
    maxResults?: number;
  }): Promise<StackSetListResponse>;
}

class InvalidBlueprintResponseError extends Error {
  constructor(
    operation: string,
    public readonly validationError: unknown,
  ) {
    super(`Invalid ${operation} response`);
    this.name = "InvalidBlueprintResponseError";
  }
}

function parseBlueprintResponse<T>(
  operation: string,
  schema: ZodType<T>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidBlueprintResponseError(operation, result.error);
  }
  return result.data;
}

function mapBlueprintMetadata(metadata: BlueprintMetadata) {
  return {
    schemaVersion: metadata.schemaVersion,
    createdTime: metadata.createdTime,
    lastEditTime: metadata.lastEditTime,
  } satisfies Record<keyof BlueprintMetadata, unknown>;
}

function mapBlueprintHealthMetrics(metrics: BlueprintHealthMetrics) {
  return {
    totalDeploymentCount: metrics.totalDeploymentCount,
    totalSuccessfulCount: metrics.totalSuccessfulCount,
    lastDeploymentAt: metrics.lastDeploymentAt,
  } satisfies Record<keyof BlueprintHealthMetrics, unknown>;
}

function mapBlueprint(blueprint: Blueprint) {
  return {
    blueprintId: blueprint.blueprintId,
    name: blueprint.name,
    tags: blueprint.tags,
    createdBy: blueprint.createdBy,
    deploymentTimeoutMinutes: blueprint.deploymentTimeoutMinutes,
    regionConcurrencyType: blueprint.regionConcurrencyType,
    totalHealthMetrics: blueprint.totalHealthMetrics
      ? mapBlueprintHealthMetrics(blueprint.totalHealthMetrics)
      : undefined,
    meta: blueprint.meta ? mapBlueprintMetadata(blueprint.meta) : undefined,
  } satisfies Record<keyof Blueprint, unknown>;
}

function mapStackSetHealthMetrics(metrics: StackSetHealthMetrics) {
  return {
    deploymentCount: metrics.deploymentCount,
    successfulDeploymentCount: metrics.successfulDeploymentCount,
    lastFailureAt: metrics.lastFailureAt,
    lastSuccessAt: metrics.lastSuccessAt,
    consecutiveFailures: metrics.consecutiveFailures,
  } satisfies Record<keyof StackSetHealthMetrics, unknown>;
}

function mapStackSetConfig(stackSet: StackSetConfig) {
  return {
    blueprintId: stackSet.blueprintId,
    stackSetId: stackSet.stackSetId,
    administrationRoleArn: stackSet.administrationRoleArn,
    executionRoleName: stackSet.executionRoleName,
    regions: stackSet.regions,
    deploymentOrder: stackSet.deploymentOrder,
    maxConcurrentPercentage: stackSet.maxConcurrentPercentage,
    failureTolerancePercentage: stackSet.failureTolerancePercentage,
    concurrencyMode: stackSet.concurrencyMode,
    healthMetrics: stackSet.healthMetrics
      ? mapStackSetHealthMetrics(stackSet.healthMetrics)
      : undefined,
    meta: stackSet.meta ? mapBlueprintMetadata(stackSet.meta) : undefined,
  } satisfies Record<keyof StackSetConfig, unknown>;
}

function mapDeploymentHistory(deployment: DeploymentHistory) {
  return {
    stackSetId: deployment.stackSetId,
    leaseId: deployment.leaseId,
    accountId: deployment.accountId,
    status: deployment.status,
    operationId: deployment.operationId,
    deploymentStartedAt: deployment.deploymentStartedAt,
    deploymentCompletedAt: deployment.deploymentCompletedAt,
    duration: deployment.duration,
    errorType: deployment.errorType,
    errorMessage: deployment.errorMessage,
  } satisfies Record<keyof DeploymentHistory, unknown>;
}

function mapBlueprintWithStackSets(composite: BlueprintWithStackSets) {
  return {
    blueprint: composite.blueprint
      ? mapBlueprint(composite.blueprint)
      : undefined,
    stackSets: composite.stackSets?.map(mapStackSetConfig),
    recentDeployments: composite.recentDeployments?.map(mapDeploymentHistory),
  } satisfies Record<keyof BlueprintWithStackSets, unknown>;
}

function mapStackSetSummary(stackSet: StackSetSummary) {
  return {
    stackSetName: stackSet.stackSetName,
    stackSetId: stackSet.stackSetId,
    description: stackSet.description,
    status: stackSet.status,
    permissionModel: stackSet.permissionModel,
  } satisfies Record<keyof StackSetSummary, unknown>;
}

export class SmithyBlueprintClient implements SmithyBlueprintApi {
  constructor(private readonly client: IsbClient) {}

  async getBlueprints(): Promise<BlueprintListResponse> {
    try {
      const output = await this.client.send(new ListBlueprintsCommand({}));
      if (!output.data?.blueprints) {
        throw new Error("Blueprints list response did not contain data");
      }
      return {
        blueprints: toValidListItems({
          clientName: "SmithyBlueprintClient",
          getItemId: (composite) => composite.blueprint?.blueprintId,
          items: output.data.blueprints,
          itemType: "blueprint",
          mapItem: mapBlueprintWithStackSets,
          schema: BlueprintWithStackSetsViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? undefined,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getBlueprintById(id: string): Promise<BlueprintDetailResponse> {
    try {
      const output = await this.client.send(
        new GetBlueprintCommand({ blueprintId: id }),
      );
      if (!output.data) {
        throw new Error("Blueprint response did not contain data");
      }
      return parseBlueprintResponse(
        "GetBlueprint",
        BlueprintWithStackSetsViewSchema,
        mapBlueprintWithStackSets(output.data),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async registerBlueprint(
    blueprint: RegisterBlueprintRequest,
  ): Promise<BlueprintView> {
    try {
      const output = await this.client.send(
        new RegisterBlueprintCommand({
          name: blueprint.name,
          stackSetId: blueprint.stackSetId,
          regions: blueprint.regions,
          tags: blueprint.tags,
          deploymentTimeoutMinutes: blueprint.deploymentTimeoutMinutes,
          regionConcurrencyType: blueprint.regionConcurrencyType,
          maxConcurrentPercentage: blueprint.maxConcurrentPercentage,
          failureTolerancePercentage: blueprint.failureTolerancePercentage,
          concurrencyMode: blueprint.concurrencyMode,
        }),
      );
      if (!output.data) {
        throw new Error("Register blueprint response did not contain data");
      }
      return parseBlueprintResponse(
        "RegisterBlueprint",
        BlueprintViewSchema,
        mapBlueprint(output.data),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async updateBlueprint(
    id: string,
    updates: UpdateBlueprintRequest,
  ): Promise<BlueprintWithStackSetsView> {
    try {
      const output = await this.client.send(
        new UpdateBlueprintCommand({
          blueprintId: id,
          name: updates.name,
          tags: updates.tags,
          deploymentTimeoutMinutes: updates.deploymentTimeoutMinutes,
          regionConcurrencyType: updates.regionConcurrencyType,
          maxConcurrentPercentage: updates.maxConcurrentPercentage,
          failureTolerancePercentage: updates.failureTolerancePercentage,
          concurrencyMode: updates.concurrencyMode,
        }),
      );
      if (!output.data) {
        throw new Error("Update blueprint response did not contain data");
      }
      return parseBlueprintResponse(
        "UpdateBlueprint",
        BlueprintWithStackSetsViewSchema,
        mapBlueprintWithStackSets(output.data),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async unregisterBlueprint(id: string): Promise<void> {
    try {
      await this.client.send(new DeleteBlueprintCommand({ blueprintId: id }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async listStackSets(params?: {
    pageIdentifier?: string;
    maxResults?: number;
  }): Promise<StackSetListResponse> {
    try {
      const output = await this.client.send(
        new ListStackSetsCommand({
          pageIdentifier: params?.pageIdentifier,
          maxResults: params?.maxResults,
        }),
      );
      if (!output.data?.result) {
        throw new Error("StackSets list response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyBlueprintClient",
          getItemId: (stackSet) => stackSet.stackSetId,
          items: output.data.result,
          itemType: "StackSet",
          mapItem: mapStackSetSummary,
          schema: StackSetViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? undefined,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}
