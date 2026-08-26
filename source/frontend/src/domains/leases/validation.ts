// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  MAX_ASSIGNMENTS,
  MAX_USER_MANAGED_ASSIGNMENTS,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";

const AssignmentPrincipalRefSchema = z.object({
  principalId: z.string().min(1),
  principalType: z.enum(["USER", "GROUP"]),
  // Display fields kept alongside the wire-required fields so the wizard
  // step can render the staged-rows table without re-fetching. Stripped
  // from the POST body before submit.
  displayName: z.string().optional(),
  email: z.string().optional(),
});

/**
 * Validation schema for requesting a new lease
 */
export const RequestLeaseValidationSchema = z.object({
  leaseTemplateUuid: z
    .string({
      error: (issue) => (issue.input === undefined ? "Required" : undefined),
    })
    .min(1, "You must choose a lease template")
    .uuid("You must choose a valid lease template"),
  acceptTerms: z.boolean().refine((val) => val === true, {
    message: "You must accept the terms of service to continue",
  }),
  comments: z.string().optional(),
  assignments: z
    .array(AssignmentPrincipalRefSchema)
    .max(
      MAX_USER_MANAGED_ASSIGNMENTS,
      `A lease can have at most ${MAX_ASSIGNMENTS} assignments`,
    )
    .refine(
      (arr) => new Set(arr.map((a) => a.principalId)).size === arr.length,
      { message: "Each user or group can only be added once" },
    )
    .optional(),
});

export type RequestLeaseFormValues = z.infer<
  typeof RequestLeaseValidationSchema
>;

/**
 * Validation schema for assigning a lease to another user
 */
export const AssignLeaseValidationSchema = z.object({
  leaseTemplateUuid: z
    .string({
      error: (issue) => (issue.input === undefined ? "Required" : undefined),
    })
    .min(1, "You must choose a lease template")
    .uuid("You must choose a valid lease template"),
  userEmail: z
    .string({
      error: (issue) => (issue.input === undefined ? "Required" : undefined),
    })
    .min(1, "You must provide a valid user")
    .email("You must provide a valid email address"),
  // Optional display label for the picked user. Persisted in form state
  // so the "Selected: …" indicator survives wizard back/forward navigation;
  // never sent to the backend.
  userDisplayName: z.string().optional(),
  acceptTerms: z.boolean().refine((val) => val === true, {
    message: "You must accept the terms of service to continue",
  }),
  comments: z.string().optional(),
  assignments: z
    .array(AssignmentPrincipalRefSchema)
    .max(
      MAX_USER_MANAGED_ASSIGNMENTS,
      `A lease can have at most ${MAX_ASSIGNMENTS} assignments`,
    )
    .refine(
      (arr) => new Set(arr.map((a) => a.principalId)).size === arr.length,
      { message: "Each user or group can only be added once" },
    )
    .optional(),
});

export type AssignLeaseFormValues = z.infer<typeof AssignLeaseValidationSchema>;
