// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  isMonitoredLease,
  Lease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { DateTime } from "luxon";

export class ValidationException extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "ValidationException";
  }
}

export function validateLeaseCompliesWithGlobalConfig(
  lease: Lease,
  globalConfig: GlobalConfig,
  options?: { previous: Lease },
) {
  validateLeaseSharingEnabled(lease.allowOwnerToShareLease, globalConfig);
  validateMaxSpend(
    lease.maxSpend,
    globalConfig,
    options && { previous: options.previous.maxSpend },
  );

  if (isMonitoredLease(lease)) {
    //monitored leases consider expirationDate to be authoritative over leaseDuration, so this is the field we must validate
    validateMaxDuration(
      leaseDurationInHours(lease),
      globalConfig,
      options && { previous: leaseDurationInHours(options.previous) },
    );
  } else {
    validateMaxDuration(
      lease.leaseDurationInHours,
      globalConfig,
      options && { previous: options.previous.leaseDurationInHours },
    );
  }
}

export function validateLeaseTemplateCompliesWithGlobalConfig(
  leaseTemplate: Pick<
    LeaseTemplate,
    "maxSpend" | "leaseDurationInHours" | "allowOwnerToShareLease"
  >,
  globalConfig: GlobalConfig,
  options?: {
    previous: Pick<LeaseTemplate, "maxSpend" | "leaseDurationInHours">;
  },
) {
  validateLeaseSharingEnabled(
    leaseTemplate.allowOwnerToShareLease,
    globalConfig,
  );
  validateMaxSpend(
    leaseTemplate.maxSpend,
    globalConfig,
    options && { previous: options.previous.maxSpend },
  );
  validateMaxDuration(
    leaseTemplate.leaseDurationInHours,
    globalConfig,
    options && { previous: options.previous.leaseDurationInHours },
  );
}

/**
 * Duration in hours for a lease, using expirationDate (authoritative for
 * monitored leases) when present, else the configured leaseDurationInHours.
 */
function leaseDurationInHours(lease: Lease): number | undefined {
  if (isMonitoredLease(lease)) {
    const start = DateTime.fromISO(lease.startDate, { zone: "utc" });
    const expiration = lease.expirationDate
      ? DateTime.fromISO(lease.expirationDate, { zone: "utc" })
      : undefined;
    return computeDurationBetweenInHours(start, expiration);
  }
  return lease.leaseDurationInHours;
}

function validateLeaseSharingEnabled(
  allowOwnerToShareLease: boolean | undefined,
  globalConfig: GlobalConfig,
) {
  // Only block enabling sharing — setting to false is always permitted as a security-positive action
  if (
    allowOwnerToShareLease === true &&
    !globalConfig.leases.leaseSharingEnabled
  ) {
    throw new ValidationException(
      "Cannot enable allowOwnerToShareLease because lease sharing is not available.",
    );
  }
}

function computeDurationBetweenInHours(
  startDate: DateTime,
  expirationDate?: DateTime,
) {
  if (!expirationDate) return undefined;
  return expirationDate.diff(startDate, "hours").hours;
}

function validateMaxSpend(
  maxSpend: number | undefined,
  globalConfig: GlobalConfig,
  options?: { previous?: number },
) {
  //maxSpend must be within global settings when used
  if (maxSpend && maxSpend > globalConfig.leases.maxBudget) {
    throw new ValidationException(
      `Max budget cannot be greater than the global max budget (${globalConfig.leases.maxBudget}).`,
    );
  }

  // On updates that leave the value unchanged, don't retroactively block edits
  // to unrelated fields just because a required max budget is missing. Only
  // enforce the requirement on create, or when the value is actually changed.
  const isUnchangedUpdate =
    options !== undefined && maxSpend === options.previous;

  //unlimited spend is not allowed if not enabled in global config
  if (!maxSpend && globalConfig.leases.requireMaxBudget && !isUnchangedUpdate) {
    throw new ValidationException(
      "A max budget must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a max budget.",
    );
  }
}

function validateMaxDuration(
  durationInHours: number | undefined,
  globalConfig: GlobalConfig,
  options?: { previous?: number },
) {
  if (
    durationInHours &&
    durationInHours > globalConfig.leases.maxDurationHours
  ) {
    throw new ValidationException(
      `Duration cannot be greater than the global max duration (${globalConfig.leases.maxDurationHours}).`,
    );
  }

  // See validateMaxSpend: unchanged updates must not be blocked retroactively.
  const isUnchangedUpdate =
    options !== undefined && durationInHours === options.previous;

  if (
    !durationInHours &&
    globalConfig.leases.requireMaxDuration &&
    !isUnchangedUpdate
  ) {
    throw new ValidationException(
      "A duration must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a duration.",
    );
  }
}
