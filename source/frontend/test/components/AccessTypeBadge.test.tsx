// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { AccessTypeBadge } from "@amzn/innovation-sandbox-frontend/components/AccessTypeBadge";

describe("AccessTypeBadge", () => {
  test("renders 'Owner' badge for owner access type", () => {
    render(<AccessTypeBadge accessType="owner" />);
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  test("renders 'Direct' badge for direct access type", () => {
    render(<AccessTypeBadge accessType="direct" />);
    expect(screen.getByText("Direct")).toBeInTheDocument();
  });

  test("renders 'Group' badge for group access type", () => {
    render(<AccessTypeBadge accessType="group" />);
    expect(screen.getByText("Group")).toBeInTheDocument();
  });

  test("renders 'Global' badge for global access type", () => {
    render(<AccessTypeBadge accessType="global" />);
    expect(screen.getByText("Global")).toBeInTheDocument();
  });
});
