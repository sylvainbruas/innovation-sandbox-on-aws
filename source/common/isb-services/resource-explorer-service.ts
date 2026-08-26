// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ExclusionResult,
  ResourceExclusionFilter,
} from "@amzn/innovation-sandbox-commons/isb-services/resource-exclusion-filter.js";
import { fromTemporaryIsbSandboxAccountCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  AssociateDefaultViewCommand,
  ConflictException,
  CreateIndexCommand,
  CreateViewCommand,
  GetDefaultViewCommand,
  GetIndexCommand,
  paginateListViews,
  Resource,
  ResourceExplorer2Client,
  ResourceNotFoundException,
  SearchCommand,
} from "@aws-sdk/client-resource-explorer-2";

const MAX_PAGES_PER_REGION = 10;
const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;

const VALIDATOR_DEFAULT_VIEW_NAME = "isb-post-cleanup-validator";
const USABLE_INDEX_STATES = new Set(["CREATING", "ACTIVE", "UPDATING"]);

// AWS global resources (IAM, CloudFront, etc.) are only indexed in us-east-1,
// so it is always included even when not a managed region.
const GLOBAL_RESOURCE_REGION = "us-east-1";

export interface ResourceExplorerServiceProps {
  intermediateRoleArn: string;
  spokeRoleName: string;
  customUserAgent: string;
  managedRegions: readonly string[];
  exclusionFilter: ResourceExclusionFilter;
}

/**
 * A region that failed during enumeration.
 */
export interface RegionError {
  region: string;
  error: string;
}

/**
 * Result of listing resources in a sandbox account.
 */
export interface ListResourcesResult extends ExclusionResult {
  /** Regions that failed during enumeration. Partial results from successful regions are still included. */
  errors: RegionError[];
  /** Whether enumeration was exhaustive across all regions. False if any region hit the pagination safety limit. */
  exhaustive: boolean;
}

export interface IndexEnsureResult {
  region: string;
  created: boolean;
  state?: string;
  error?: string;
  viewError?: string;
}

export interface EnsureIndexesResult {
  indexes: IndexEnsureResult[];
}

/**
 * Service for enumerating resources in sandbox accounts using AWS Resource Explorer.
 * Encapsulates cross-account credential resolution, multi-region enumeration,
 * and exclusion filtering into a single `listResources(accountId)` call.
 */
export class ResourceExplorerService {
  private readonly props: ResourceExplorerServiceProps;
  private readonly effectiveRegions: string[];

  constructor(props: ResourceExplorerServiceProps) {
    this.props = props;
    this.effectiveRegions = [
      ...new Set([...props.managedRegions, GLOBAL_RESOURCE_REGION]),
    ];
  }

  /**
   * Lists all resources in a sandbox account across ISB-managed regions,
   * partitioned into resources (not matching any exclusion filter) and
   * filtered (matching an exclusion filter).
   *
   * If a region fails, partial results from successful regions are still returned
   * and the failed region is reported in the `errors` array. The caller decides
   * whether to proceed or fail based on errors.
   *
   * @param accountId - The 12-digit AWS account ID of the sandbox account
   * @returns ListResourcesResult with resources, filtered, and errors arrays
   */
  public async listResources(accountId: string): Promise<ListResourcesResult> {
    if (!AWS_ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error("Invalid account ID format: expected exactly 12 digits");
    }

    const { resources, errors, exhaustive } = await this.enumerate(accountId);
    const partitioned = this.props.exclusionFilter.applyExclusions(resources);

    return {
      ...partitioned,
      errors,
      exhaustive,
    };
  }

  /**
   * Idempotently ensures a LOCAL index + default view exists in every effective
   * region. Resource Explorer only reports resources for regions with an index,
   * so running this each cleanup keeps validation correct even if a user deleted
   * the index. Per-region failures are isolated (reported, never thrown).
   *
   * Resource Explorer allows one index per region and it has no user-specified
   * name, so the index this creates is the only one a sandbox account can have.
   * That is why the ProtectIsbResourceExplorerIndex SCP statement denies the
   * index actions account-wide rather than scoping them to an ARN: there is no
   * user-created index to preserve. ProtectIsbResourceExplorerValidatorView
   * scopes the view actions by name instead, so sandbox users can still create
   * and search their own views against this index.
   */
  public async ensureIndexes(accountId: string): Promise<EnsureIndexesResult> {
    if (!AWS_ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error("Invalid account ID format: expected exactly 12 digits");
    }

    const credentials = this.buildCredentials(accountId);

    // Regions are independent, so ensure them in parallel. Each region's failure
    // is isolated via .catch so one bad region never fails the others.
    const indexes = await Promise.all(
      this.effectiveRegions.map((region) =>
        this.ensureIndexInRegion(region, credentials).catch(
          (error): IndexEnsureResult => ({
            region,
            created: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    );

    return { indexes };
  }

  private async ensureIndexInRegion(
    region: string,
    credentials: ReturnType<typeof fromTemporaryIsbSandboxAccountCredentials>,
  ): Promise<IndexEnsureResult> {
    const client = new ResourceExplorer2Client({
      region,
      credentials,
      customUserAgent: this.props.customUserAgent,
    });

    const existing = await this.getIndex(client);
    if (existing) {
      // Search requires a default view, so ensure one even if the index exists.
      const viewError = await this.ensureDefaultView(client);
      return { region, created: false, state: existing.State, viewError };
    }

    const created = await client.send(new CreateIndexCommand({}));
    const viewError = await this.ensureDefaultView(client);
    return { region, created: true, state: created.State, viewError };
  }

  // Returns the region's usable index, or undefined when none exists or the
  // existing one is deleted/being deleted (other errors throw). A DELETED index
  // still returns 200, so the state must be checked rather than the response
  // alone — treating it as present skips creation and then fails view setup with
  // UnauthorizedException.
  private getIndex(
    client: ResourceExplorer2Client,
  ): Promise<{ State?: string } | undefined> {
    return client
      .send(new GetIndexCommand({}))
      .then((response) =>
        response.State && USABLE_INDEX_STATES.has(response.State)
          ? { State: response.State }
          : undefined,
      )
      .catch((error) => {
        if (error instanceof ResourceNotFoundException) {
          return undefined;
        }
        throw error;
      });
  }

  // Creates + associates a default view only when absent (safe to call always).
  private async ensureDefaultView(
    client: ResourceExplorer2Client,
  ): Promise<string | undefined> {
    try {
      const defaultView = await client.send(new GetDefaultViewCommand({}));
      if (defaultView.ViewArn) {
        return;
      }

      const viewArn = await this.createOrGetValidatorView(client);
      if (viewArn) {
        await client.send(
          new AssociateDefaultViewCommand({ ViewArn: viewArn }),
        );
      }
      return;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Creates the validator view, or looks up the existing one when that name is
   * already taken. A prior run that created the view but failed before
   * associating it as default would otherwise conflict here on every subsequent
   * run, leaving the region without a default view and breaking Search.
   */
  private async createOrGetValidatorView(
    client: ResourceExplorer2Client,
  ): Promise<string | undefined> {
    try {
      const created = await client.send(
        new CreateViewCommand({ ViewName: VALIDATOR_DEFAULT_VIEW_NAME }),
      );
      return created.View?.ViewArn;
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
      return this.findValidatorView(client);
    }
  }

  /**
   * Finds the validator view's ARN by paging through the region's views.
   *
   * A single page returns every view today (the per-region view quota is 10 and
   * cannot currently be raised), but paginating keeps this correct if that quota
   * is ever lifted.
   */
  private async findValidatorView(
    client: ResourceExplorer2Client,
  ): Promise<string | undefined> {
    const listViewsPaginator = paginateListViews({ client }, {});

    for await (const page of listViewsPaginator) {
      // View ARNs are `arn:...:<account>:view/<name>/<uuid>`, so match the name
      // between the `view/` segment and the trailing UUID.
      const match = page.Views?.find((arn) =>
        arn.includes(`:view/${VALIDATOR_DEFAULT_VIEW_NAME}/`),
      );
      if (match) {
        return match;
      }
    }

    return undefined;
  }

  private buildCredentials(
    accountId: string,
  ): ReturnType<typeof fromTemporaryIsbSandboxAccountCredentials> {
    const spokeRoleArn = `arn:aws:iam::${accountId}:role/${this.props.spokeRoleName}`;
    return fromTemporaryIsbSandboxAccountCredentials(spokeRoleArn, {
      INTERMEDIATE_ROLE_ARN: this.props.intermediateRoleArn,
      USER_AGENT_EXTRA: this.props.customUserAgent,
    });
  }

  /**
   * Enumerates all resources across managed regions using Resource Explorer Search API.
   * Isolates per-region failures so a single region issue doesn't lose all results.
   */
  private async enumerate(accountId: string): Promise<{
    resources: Resource[];
    errors: RegionError[];
    exhaustive: boolean;
  }> {
    const credentials = this.buildCredentials(accountId);

    const allResources: Resource[] = [];
    const errors: RegionError[] = [];
    let exhaustive = true;

    for (const region of this.effectiveRegions) {
      try {
        const regionResult = await this.enumerateRegion(region, credentials);
        allResources.push(...regionResult.resources);
        if (!regionResult.exhaustive) {
          exhaustive = false;
        }
      } catch (error) {
        errors.push({
          region,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { resources: allResources, errors, exhaustive };
  }

  private async enumerateRegion(
    region: string,
    credentials: ReturnType<typeof fromTemporaryIsbSandboxAccountCredentials>,
  ): Promise<{ resources: Resource[]; exhaustive: boolean }> {
    const client = new ResourceExplorer2Client({
      region,
      credentials,
      customUserAgent: this.props.customUserAgent,
    });

    const resources: Resource[] = [];
    let nextToken: string | undefined;
    let pageCount = 0;

    do {
      const response = await client.send(
        new SearchCommand({
          QueryString: "*",
          ...(nextToken && { NextToken: nextToken }),
        }),
      );

      if (response.Resources) {
        resources.push(...response.Resources);
      }

      nextToken = response.NextToken;
      pageCount++;

      if (pageCount >= MAX_PAGES_PER_REGION && nextToken) {
        // Safety limit reached; return partial results.
        return { resources, exhaustive: false };
      }
    } while (nextToken);

    return { resources, exhaustive: true };
  }
}
