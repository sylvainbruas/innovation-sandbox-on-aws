// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isApprovalDeniedLease,
  isExpiredLease,
  isMonitoredLease,
  isPendingLease,
  Lease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

export interface LeaseExpiryInfo {
  date?: Date | string;
  durationInHours?: number;
  durationReference?: string;
  expired?: boolean;
}

export const getLeaseExpiryInfo = (lease: Lease): LeaseExpiryInfo | null => {
  if (isPendingLease(lease) || isApprovalDeniedLease(lease)) {
    return {
      durationInHours: lease.leaseDurationInHours,
    };
  }

  if (lease.status === "Provisioning") {
    return {
      durationInHours: lease.leaseDurationInHours,
      durationReference: "from lease publish",
    };
  }

  if (isMonitoredLease(lease)) {
    return {
      date: lease.expirationDate,
    };
  }

  if (isExpiredLease(lease)) {
    return {
      date: lease.endDate,
      expired: true,
    };
  }

  return null;
};
