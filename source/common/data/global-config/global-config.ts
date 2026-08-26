// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  CleanupValidationModeSchema,
  ConfigSchemas,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";

export const GlobalConfigSchema = z.object({
  termsOfService: z.string().meta({
    description:
      "The terms of service that must be agreed to before a lease can be requested",
  }),
  maintenanceMode: z.boolean().meta({
    description:
      "If enabled, the system will prevent the creation of new leases",
  }),
  leases: z.object({
    requireMaxBudget: z.boolean().meta({
      description: "Whether or not to require a max budget on lease templates",
    }),
    maxBudget: z.number().int().gte(0).meta({
      description:
        "Maximum budget value (in dollars) that can be created on lease templates",
    }),
    requireMaxDuration: z.boolean().meta({
      description:
        "Whether or not to require a max duration on lease templates",
    }),
    maxDurationHours: z.number().int().gte(0).meta({
      description:
        "Maximum duration (in hours) that can be specified on a lease template",
    }),
    maxLeasesPerUser: z.number().int().gte(0).meta({
      description:
        "The maximum number of active leases a user can have at any one time",
    }),
    ttl: z.number().int().nonnegative().meta({
      description:
        "The number of days the solution will store expired lease records before purging them from the database",
    }),
    leaseSharingEnabled: z.boolean().default(false).meta({
      description:
        "Controls whether the multi-user lease sharing feature is active. When disabled, lease owners cannot manage assignments.",
    }),
    allowUserLeaseTermination: z.boolean().default(true).meta({
      description:
        "Controls whether users can self-terminate their own active leases. When disabled, the terminate button is hidden from the home page and User-role termination requests are rejected. Admins and managers are unaffected.",
    }),
    leaseRequestWindowHours: z.number().int().positive().default(168).meta({
      description:
        "Rolling window duration in hours used for rate-limiting lease requests. Effective window is capped at runtime by the lease record TTL.",
    }),
    maxLeaseRequestsPerWindow: z.number().int().positive().default(10).meta({
      description:
        "Maximum number of leases a user may have created within the rolling window before further lease requests are rejected with HTTP 429.",
    }),
    enablePrincipalSearch: z.boolean().default(true).meta({
      description:
        "Controls whether the GET /principals/search API is available. When disabled, users must manually enter email addresses.",
    }),
  }),
  cleanup: z.object({
    numberOfFailedAttemptsToCancelCleanup: z.number().int().gte(0).meta({
      description: "The number of failed attempts to cleanup before giving up",
    }),
    waitBeforeRetryFailedAttemptSeconds: z.number().int().gte(0).meta({
      description:
        "The number of seconds to wait before retrying a failed attempt to cleanup",
    }),
    numberOfSuccessfulAttemptsToFinishCleanup: z.number().int().gte(0).meta({
      description: "The number of successful attempts to finish cleanup",
    }),
    waitBeforeRerunSuccessfulAttemptSeconds: z.number().int().gte(0).meta({
      description:
        "The number of seconds to wait before rerunning a successful attempt",
    }),
    validation: z
      .object({
        failureAction: CleanupValidationModeSchema.default("Silent").meta({
          description:
            "Action when post-cleanup validation detects remaining resources. " +
            "'Silent' (default) runs validation in the background but never warns " +
            "the user or quarantines the account." +
            "'Warn' surfaces remaining resources in reports/logs but still allows the " +
            "account to proceed to Available. " +
            "'Quarantine' fails the cleanup and quarantines the account.",
        }),
      })
      .default({ failureAction: "Silent" })
      .meta({
        description: "Post-cleanup Resource Explorer validation settings",
      }),
    cooldownPeriodHours: z
      .number()
      .int()
      .min(0)
      .max(8640)
      .default(0)
      .meta({
        description:
          "Hours to hold an account in the CleanUp OU after successful cleanup before returning to Available. " +
          "0 = disabled (default). Max: 8640 (360 days). Recommended: 24.",
      }),
    reportRetentionDays: z.number().int().min(14).max(3650).default(730).meta({
      description:
        "Days to retain cleanup report records in DynamoDB. Min: 14, Max: 3650 (10 years). Default: 730 (2 years).",
    }),
  }),
  notification: z.object({
    emailFrom: z
      .union([z.email(), z.literal("")])
      .optional()
      .meta({
        description:
          "The email address to send notifications from. Leave empty or remove to disable email notifications",
      }),
  }),
});

/**
 * Inferred shape of the legacy flat AppConfig configuration. Retained for the
 * AppConfig-backed store and infrastructure, which still read/write this shape
 * (removal is Track D/H).
 */
export type AppConfigGlobalConfig = z.infer<typeof GlobalConfigSchema>;

/**
 * Section-based runtime configuration assembled by `isbConfigMiddleware` from
 * the DynamoDB Config table. Replaces the old flat shape; the context property
 * name `globalConfig` is preserved. Each section's shape comes from the shared
 * `ConfigSchemas` in `data/config/config.ts`.
 */
export type GlobalConfig = {
  [Section in keyof typeof ConfigSchemas]: z.infer<
    (typeof ConfigSchemas)[Section]
  >;
};
