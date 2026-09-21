// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  GetLeaseAssignmentsResponse,
  LeaseView,
  UpdateLeaseAssignmentsResponse,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import {
  AssignmentPrincipalRef,
  LeasePatchRequest,
  NewLeaseRequest,
  SharedLeasesResponse,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { registerApiSingletonReset } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";

import {
  createLeaseClient,
  SharedLeaseQueryAccessType,
  SmithyLeaseApi,
  SmithyLeaseClient,
} from "./smithy-client";

export class LeaseService {
  constructor(private readonly api: SmithyLeaseApi) {}

  async getLeases(userEmail?: string): Promise<LeaseView[]> {
    let allLeases: LeaseView[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all leases are collected
    do {
      const response = await this.api.listLeases(
        nextPageIdentifier ?? undefined,
        userEmail,
      );
      allLeases = [...allLeases, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null);

    return allLeases;
  }

  async getLeaseById(id: string): Promise<LeaseView | undefined> {
    return this.api.getLease(id);
  }

  async requestNewLease(request: NewLeaseRequest): Promise<void> {
    await this.api.requestLease(request);
  }

  async updateLease(request: LeasePatchRequest): Promise<void> {
    await this.api.updateLease(request);
  }

  async reviewLease(leaseId: string, approve: boolean): Promise<void> {
    await this.api.reviewLease(leaseId, approve);
  }

  async terminateLease(leaseId: string): Promise<void> {
    await this.api.terminateLease(leaseId);
  }

  async freezeLease(leaseId: string): Promise<void> {
    await this.api.freezeLease(leaseId);
  }

  async unfreezeLease(leaseId: string): Promise<void> {
    await this.api.unfreezeLease(leaseId);
  }

  async getAssignments(leaseId: string): Promise<GetLeaseAssignmentsResponse> {
    return this.api.getAssignments(leaseId);
  }

  async updateAssignments(
    leaseId: string,
    assignments: AssignmentPrincipalRef[],
  ): Promise<UpdateLeaseAssignmentsResponse> {
    return this.api.updateAssignments(leaseId, assignments);
  }

  async getSharedLeases(
    userId: string,
    accessType: SharedLeaseQueryAccessType,
  ): Promise<SharedLeasesResponse> {
    const allResults: SharedLeasesResponse["result"] = [];
    let nextPageIdentifier: string | undefined;
    const maxResults = 100;
    const MAX_PAGES = 50;
    let pageCount = 0;

    do {
      const response = await this.api.listSharedLeases(
        userId,
        accessType,
        maxResults,
        nextPageIdentifier,
      );
      allResults.push(...response.result);
      nextPageIdentifier = response.nextPageIdentifier ?? undefined;
      pageCount++;
    } while (nextPageIdentifier && pageCount < MAX_PAGES);

    if (pageCount >= MAX_PAGES && nextPageIdentifier) {
      console.warn(
        `[LeaseService] getSharedLeases hit MAX_PAGES (${MAX_PAGES}) limit. Results may be incomplete.`,
      );
    }

    return {
      result: allResults,
      nextPageIdentifier: nextPageIdentifier ?? null,
    };
  }
}

let leaseService: LeaseService | undefined;

// Lazily-initialized singleton.
export function getLeaseService(): LeaseService {
  leaseService ??= new LeaseService(new SmithyLeaseClient(createLeaseClient()));
  return leaseService;
}

registerApiSingletonReset(() => {
  leaseService = undefined;
});
