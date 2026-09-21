// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import {
  CreateLeaseTemplateRequest,
  UpdateLeaseTemplateRequest,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/types";
import { registerApiSingletonReset } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

import {
  createLeaseTemplateClient,
  SmithyLeaseTemplateApi,
  SmithyLeaseTemplateClient,
} from "./smithy-client";

export class LeaseTemplateService {
  constructor(private readonly api: SmithyLeaseTemplateApi) {}

  async getLeaseTemplates(): Promise<LeaseTemplateView[]> {
    let allLeaseTemplates: LeaseTemplateView[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all lease templates are collected
    do {
      const response: ApiPaginatedResult<LeaseTemplateView> =
        await this.api.listLeaseTemplates(nextPageIdentifier ?? undefined);

      allLeaseTemplates = [...allLeaseTemplates, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null);

    return allLeaseTemplates;
  }

  async getLeaseTemplateById(id: string): Promise<LeaseTemplateView> {
    return this.api.getLeaseTemplate(id);
  }

  async addLeaseTemplate(
    leaseTemplate: CreateLeaseTemplateRequest,
  ): Promise<void> {
    await this.api.createLeaseTemplate(leaseTemplate);
  }

  async updateLeaseTemplate(leaseTemplate: LeaseTemplateView): Promise<void> {
    const { uuid, blueprintName, createdBy, ...rest } = leaseTemplate;
    const body: UpdateLeaseTemplateRequest = rest;
    await this.api.updateLeaseTemplate(uuid, body);
  }

  async deleteLeaseTemplates(leaseTemplateIds: string[]): Promise<void> {
    for (const id of leaseTemplateIds) {
      await this.api.deleteLeaseTemplate(id);
    }
  }
}

let leaseTemplateService: LeaseTemplateService | undefined;

// Lazily-initialized singleton.
export function getLeaseTemplateService(): LeaseTemplateService {
  leaseTemplateService ??= new LeaseTemplateService(
    new SmithyLeaseTemplateClient(createLeaseTemplateClient()),
  );
  return leaseTemplateService;
}

registerApiSingletonReset(() => {
  leaseTemplateService = undefined;
});
