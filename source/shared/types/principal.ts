// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { enumErrorMap } from "../utils/zod.js";

/** Values shared by IDC services, persistence, API adapters, and the frontend. */
export const PrincipalTypeSchema = z.enum(["USER", "GROUP"], {
  error: enumErrorMap,
});

const IDC_PRINCIPAL_ID_PATTERN =
  "([0-9a-f]{10}-)?[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}";

/** An IDC principal ID: a UUID, optionally prefixed by ten hexadecimal characters. */
export const IdcPrincipalIdSchema = z
  .string()
  .regex(
    new RegExp(`^${IDC_PRINCIPAL_ID_PATTERN}$`),
    "Must be a valid IDC principal ID",
  );

/** Neutral IDC principal fields; storage keys and UI normalization belong elsewhere. */
export const IdcPrincipalSchema = z.strictObject({
  principalId: IdcPrincipalIdSchema,
  principalType: PrincipalTypeSchema,
  displayName: z.string().min(1).optional(),
  email: z.email().optional(),
});

/** Public query filter accepted by `GET /principals/search`. */
export const PrincipalSearchTypeSchema = z.enum(["users", "groups", "all"], {
  error: enumErrorMap,
});

export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;
export type IdcPrincipal = z.infer<typeof IdcPrincipalSchema>;
export type PrincipalSearchType = z.infer<typeof PrincipalSearchTypeSchema>;
