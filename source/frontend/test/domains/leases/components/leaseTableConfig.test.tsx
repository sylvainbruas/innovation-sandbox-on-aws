// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import {
  getLeaseColumnDefinitions,
  LeaseTableItem,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/leaseTableConfig";
import { LeaseLoginPermissions } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  createActiveLease,
  createExpiredLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";

vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AccountLoginLink",
  () => ({
    AccountLoginLink: ({ accountId }: { accountId: string }) => (
      <span>Login to account {accountId}</span>
    ),
  }),
);

const userPermissions: LeaseLoginPermissions = {
  isAdmin: false,
  isManager: false,
};
const managerPermissions: LeaseLoginPermissions = {
  isAdmin: false,
  isManager: true,
};
const adminPermissions: LeaseLoginPermissions = {
  isAdmin: true,
  isManager: false,
};

const renderAccessCell = (
  lease: LeaseTableItem,
  permissions: LeaseLoginPermissions,
) => {
  const accessColumn = getLeaseColumnDefinitions(permissions).find(
    (column) => column.id === "access",
  );
  if (!accessColumn) {
    throw new Error("Access column is not configured");
  }

  render(<>{accessColumn.cell(lease)}</>);
};

describe("lease table Access column", () => {
  test("renders Login for a manager on a frozen lease", () => {
    renderAccessCell(
      createActiveLease({ status: "Frozen" }),
      managerPermissions,
    );

    expect(screen.getByText(/Login to account/i)).toBeInTheDocument();
  });

  test("renders Login for an admin on a provisioning lease", () => {
    renderAccessCell(
      createActiveLease({
        awsAccountId: "111122223333",
        status: "Provisioning",
      }),
      adminPermissions,
    );

    expect(
      screen.getByText("Login to account 111122223333"),
    ).toBeInTheDocument();
  });

  test("does not render Login for a user on a frozen lease", () => {
    renderAccessCell(createActiveLease({ status: "Frozen" }), userPermissions);

    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });

  test("does not render Login for an admin on an expired lease", () => {
    renderAccessCell(createExpiredLease(), adminPermissions);

    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });
});
