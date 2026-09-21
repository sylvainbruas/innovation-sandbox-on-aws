// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";

export type CreateLeaseTemplateRequest = Omit<
  LeaseTemplateView,
  "uuid" | "createdBy" | "blueprintName" | "meta"
>;

export type UpdateLeaseTemplateRequest = Omit<
  LeaseTemplateView,
  "uuid" | "blueprintName" | "createdBy"
>;
