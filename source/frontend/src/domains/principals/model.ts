// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { IdcPrincipalSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";

/** IDC principal representation consumed by the assignment UI. */
export const IdcPrincipalViewSchema = IdcPrincipalSchema.safeExtend({
  // Smithy intentionally leaves the public ID unconstrained; the persistence-only
  // IDC pattern must not become a new response-validation requirement.
  principalId: z.string(),
  // The API may omit a cache display name; the adapter normalizes it for sorting.
  displayName: z.string(),
  // Smithy's OwnerEmail is sensitive but otherwise unconstrained. Keep the
  // persistence email validation from becoming a stricter response contract.
  email: z.string().optional(),
});

export type IdcPrincipalView = z.infer<typeof IdcPrincipalViewSchema>;

export type PrincipalSearchResponse = {
  principals: IdcPrincipalView[];
  totalMatches: number;
};
