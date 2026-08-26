// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const lease: MonitoredLease = createActiveLease({
  costReportGroup: "engineering-team",
  budgetThresholds: [{ dollarsSpent: 50, action: "FREEZE_ACCOUNT" }],
  durationThresholds: [{ hoursRemaining: 24, action: "ALERT" }],
});

describe("LeaseSummary admin-field visibility", () => {
  describe("admin view (showAdminFields={true})", () => {
    it("shows Cost Report Settings, Last Monitored, and threshold sections", () => {
      renderWithQueryClient(
        <LeaseSummary lease={lease} showAdminFields={true} />,
      );

      expect(screen.getByText("Cost Report Settings")).toBeInTheDocument();
      expect(screen.getByText("Last Monitored")).toBeInTheDocument();
      expect(screen.getByText("Budget Thresholds")).toBeInTheDocument();
      expect(screen.getByText("Duration Thresholds")).toBeInTheDocument();
    });
  });

  describe("default (no showAdminFields prop)", () => {
    it("hides admin fields, failing safe when a consumer forgets the prop", () => {
      renderWithQueryClient(<LeaseSummary lease={lease} />);
      expect(screen.queryByText("Last Monitored")).not.toBeInTheDocument();
      expect(screen.queryByText("Budget Thresholds")).not.toBeInTheDocument();
      expect(screen.queryByText("Duration Thresholds")).not.toBeInTheDocument();
    });
  });

  describe("user view (showAdminFields={false})", () => {
    it("hides the Last Monitored row", () => {
      renderWithQueryClient(
        <LeaseSummary lease={lease} showAdminFields={false} />,
      );

      expect(screen.queryByText("Last Monitored")).not.toBeInTheDocument();
    });

    it("hides the Budget and Duration Thresholds sections", () => {
      renderWithQueryClient(
        <LeaseSummary lease={lease} showAdminFields={false} />,
      );

      expect(screen.queryByText("Budget Thresholds")).not.toBeInTheDocument();
      expect(screen.queryByText("Duration Thresholds")).not.toBeInTheDocument();
    });

    it("still shows Budget Status and Lease Expiry", () => {
      renderWithQueryClient(
        <LeaseSummary lease={lease} showAdminFields={false} />,
      );

      expect(screen.getByText("Budget Status")).toBeInTheDocument();
      expect(screen.getByText("Lease Expiry")).toBeInTheDocument();
    });
  });
});
