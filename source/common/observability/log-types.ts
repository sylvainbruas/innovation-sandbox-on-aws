// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CleanupValidationModeSchema } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { CleanupReasonSchema } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { LeaseTerminatedReasonTypeSchema } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";
import z from "zod";

export const AccountDriftLogSchema = z.object({
  logDetailType: z.literal("AccountDrift"),
  accountId: AwsAccountIdSchema,
  expectedOu: z.string().optional(),
  actualOu: z.string().optional(),
});

export const LeasePublishedLogSchema = z.object({
  logDetailType: z.literal("LeasePublished"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  maxBudget: z.number().optional(),
  maxDurationHours: z.number().optional(),
  autoApproved: z.boolean(),
  creationMethod: z.enum(["REQUESTED", "ASSIGNED"], {
    error: enumErrorMap,
  }),
  hasBlueprint: z.boolean(),
  numDesiredAssignments: z.number().nonnegative().optional(),
});

export const LeaseTerminatedLogSchema = z.object({
  logDetailType: z.literal("LeaseTerminated"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  startDate: z.string(),
  terminationDate: z.string(),
  maxBudget: z.number().optional(),
  actualSpend: z.number(),
  maxDurationHours: z.number().optional(),
  actualDurationHours: z.number(),
  reasonForTermination: LeaseTerminatedReasonTypeSchema,
});

export const LeaseUnfrozenLogSchema = z.object({
  logDetailType: z.literal("LeaseUnfrozen"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
});

export const LeaseResetLogSchema = z.object({
  logDetailType: z.literal("LeaseReset"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  blueprintId: z.string().nullish(),
  blueprintName: z.string().optional(),
  reasonForReset: z.enum(["ProvisioningFailed"], {
    error: enumErrorMap,
  }),
});

export const DeploymentSummaryLogSchema = z.object({
  logDetailType: z.literal("DeploymentSummary"),
  numM2mClients: z.number().nonnegative(),
  numLeaseTemplates: z.number().nonnegative(),
  numLeaseTemplatesWithBlueprint: z.number().nonnegative(),
  numBlueprints: z.number().nonnegative(),
  blueprintServiceCounts: z
    .record(z.string(), z.number().nonnegative())
    .optional(),
  config: z.object({
    numCostReportGroups: z.number().nonnegative(),
    requireMaxBudget: z.boolean(),
    maxBudget: z.number().nonnegative(),
    requireMaxDuration: z.boolean(),
    maxDurationHours: z.number().nonnegative(),
    maxLeasesPerUser: z.number().nonnegative(),
    requireCostReportGroup: z.boolean(),
    numberOfFailedAttemptsToCancelCleanup: z.number().nonnegative(),
    waitBeforeRetryFailedAttemptSeconds: z.number().nonnegative(),
    numberOfSuccessfulAttemptsToFinishCleanup: z.number().nonnegative(),
    waitBeforeRerunSuccessfulAttemptSeconds: z.number().nonnegative(),
    isStableTaggingEnabled: z.boolean(),
    isMultiAccountDeployment: z.boolean(),
    allowUserLeaseTermination: z.boolean(),
    leaseRequestWindowHours: z.number().nonnegative(),
    maxLeaseRequestsPerWindow: z.number().nonnegative(),
    leaseSharingEnabled: z.boolean(),
    enablePrincipalSearch: z.boolean(),
  }),
  accountPool: z.object({
    available: z.number().nonnegative(),
    active: z.number().nonnegative(),
    frozen: z.number().nonnegative(),
    cleanup: z.number().nonnegative(),
    quarantine: z.number().nonnegative(),
  }),
  additionalAllowedServicesList: z.array(z.string()).default([]),
  bedrockInferenceProfilePatternsList: z.array(z.string()).default([]),
  numTemplatesWithSharing: z.number().nonnegative(),
  numLeasesWithAssignments: z.number().nonnegative(),
  totalUserAssignments: z.number().nonnegative(),
  totalGroupAssignments: z.number().nonnegative(),
  avgAssignmentsPerLease: z.number().nonnegative(),
  maxAssignmentsPerLease: z.number().nonnegative(),
  dailyApiCallsByAuthType: z.object({
    m2m: z.number().nonnegative(),
    user: z.number().nonnegative(),
  }),
});

export const CostReportingLogSchema = z.object({
  logDetailType: z.literal("CostReporting"),
  startDate: z.string(),
  endDate: z.string(),
  sandboxAccountsCost: z.number(),
  solutionOperatingCost: z.number(),
  numAccounts: z.number(),
});

export const AccountCleanupCompletedStepSchema = z.object({
  name: z.string(),
  durationSeconds: z.number().int(),
  configuredHours: z.number().nonnegative().optional(),
  skipped: z.boolean().optional(),
});

export const AccountCleanupCompletedLogSchema = z.object({
  logDetailType: z.literal("AccountCleanupCompleted"),
  outcome: z.enum(["SUCCESS", "FAILED"], { error: enumErrorMap }),
  durationMinutes: z.number(),
  reason: CleanupReasonSchema,
  failedStep: z.string().nullable(),
  validationMode: CleanupValidationModeSchema.optional(),
  totalResourcesBefore: z.number().nonnegative(),
  totalResourcesIgnored: z.number().nonnegative(),
  resourcesBefore: z.record(z.string(), z.number().nonnegative()),
  resourcesRemaining: z.record(z.string(), z.number().nonnegative()),
  resourcesClearedDuringCooldown: z.record(
    z.string(),
    z.number().nonnegative(),
  ),
  cooldownConfiguredHours: z.number().nonnegative(),
  cooldownActualSeconds: z.number().nonnegative(),
  cooldownSkipped: z.boolean(),
  steps: z.array(AccountCleanupCompletedStepSchema),
  idcAssignmentsFound: z.number().nonnegative(),
  idcAssignmentsDeleted: z.number().nonnegative(),
  principalRecordsFound: z.number().nonnegative(),
  principalRecordsDeleted: z.number().nonnegative(),
});

export const ReasonForQuarantineSchema = z.enum(
  ["MANUAL", "DRIFT", "CLEANUP_FAILED"],
  {
    error: enumErrorMap,
  },
);
export type ReasonForQuarantine = z.infer<typeof ReasonForQuarantineSchema>;

export const AccountQuarantinedLogSchema = z.object({
  logDetailType: z.literal("AccountQuarantined"),
  accountId: AwsAccountIdSchema,
  reasonForQuarantine: ReasonForQuarantineSchema,
});

export const TagResourceFailedLogSchema = z.object({
  logDetailType: z.literal("TagResourceFailed"),
  reason: z.enum(["TagSpaceExhausted", "ApiError"], { error: enumErrorMap }),
  accountId: AwsAccountIdSchema,
  tagKeys: z.array(z.string()),
  errorName: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const UntagResourceFailedLogSchema = z.object({
  logDetailType: z.literal("UntagResourceFailed"),
  accountId: AwsAccountIdSchema,
  tagKeys: z.array(z.string()),
  errorName: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const TagActivationCheckLogSchema = z.object({
  logDetailType: z.literal("TagActivationCheck"),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  tagsActive: z.array(z.string()),
  tagsInactive: z.array(z.string()),
  tagsMissing: z.array(z.string()),
});

export const TagActivationSucceededLogSchema = z.object({
  logDetailType: z.literal("TagActivationSucceeded"),
  attempt: z.number().int().nonnegative(),
  tagsActivated: z.array(z.string()),
});

export const TagActivationFailedLogSchema = z.object({
  logDetailType: z.literal("TagActivationFailed"),
  reason: z.enum(["MaxAttemptsReached"], { error: enumErrorMap }),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  tagsInactive: z.array(z.string()),
  tagsMissing: z.array(z.string()),
});

export const AssignmentExecutionCompletedLogSchema = z.object({
  logDetailType: z.literal("AssignmentExecutionCompleted"),
  leaseId: z.string(),
  accountId: AwsAccountIdSchema,
  intent: z.enum(["TERMINATE", "FREEZE", "UPDATE", "PUBLISH", "UNFREEZE"], {
    error: enumErrorMap,
  }),
  principalsProcessed: z.number().nonnegative(),
  succeeded: z.number().nonnegative(),
  failed: z.number().nonnegative(),
});

export const SubscribableLogSchema = z.discriminatedUnion("logDetailType", [
  AccountDriftLogSchema,
  LeaseTerminatedLogSchema,
  LeasePublishedLogSchema,
  LeaseUnfrozenLogSchema,
  LeaseResetLogSchema,
  DeploymentSummaryLogSchema,
  CostReportingLogSchema,
  AccountCleanupCompletedLogSchema,
  AccountQuarantinedLogSchema,
  TagResourceFailedLogSchema,
  UntagResourceFailedLogSchema,
  TagActivationCheckLogSchema,
  TagActivationSucceededLogSchema,
  TagActivationFailedLogSchema,
  AssignmentExecutionCompletedLogSchema,
]);

export type SubscribableLog = z.infer<typeof SubscribableLogSchema>;
