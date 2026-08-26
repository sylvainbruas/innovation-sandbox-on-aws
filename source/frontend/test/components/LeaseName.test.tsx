// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";

import { LeaseName } from "@amzn/innovation-sandbox-frontend/components/LeaseName";

describe("LeaseName", () => {
  const uuid = "abcdefgh-1234-5678-9012-ijklmnopqrst";
  const templateName = "Developer Sandbox";
  const leaseId = "user@example.com#abcdefgh-1234-5678-9012-ijklmnopqrst";

  test("renders display name as plain text when no leaseId", () => {
    render(
      <BrowserRouter>
        <LeaseName uuid={uuid} templateName={templateName} />
      </BrowserRouter>,
    );

    expect(
      screen.getByText("Developer Sandbox (abcdefgh)"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("renders display name as a link when leaseId is provided", () => {
    render(
      <BrowserRouter>
        <LeaseName uuid={uuid} templateName={templateName} leaseId={leaseId} />
      </BrowserRouter>,
    );

    const link = screen.getByRole("link", {
      name: "Developer Sandbox (abcdefgh)",
    });
    expect(link).toHaveAttribute("href", `/leases/${leaseId}`);
  });
});
