// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DesiredAssignmentWithDisplay } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { PendingAssignmentsList } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PendingAssignmentsList";

describe("PendingAssignmentsList", () => {
  it("renders nothing when there are no desiredAssignments", () => {
    const { container } = render(<PendingAssignmentsList />);
    // Component returns null in the empty case; a real render would show
    // a Container header. Asserting on the absence of the header text is
    // the easiest invariant.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Pre-approval sharing")).not.toBeInTheDocument();
  });

  it("renders nothing when desiredAssignments is empty", () => {
    const { container } = render(
      <PendingAssignmentsList desiredAssignments={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders user and group rows with display fields", () => {
    const desiredAssignments: DesiredAssignmentWithDisplay[] = [
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      },
      {
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
      },
    ];

    render(<PendingAssignmentsList desiredAssignments={desiredAssignments} />);

    expect(screen.getByText("Pre-approval sharing")).toBeInTheDocument();

    // Alice's row has the display name (Name col) and email (Email/Group col).
    // alice@example.com appears in both the Name fallback and the Email/Group
    // column for users, so use findAll.
    const aliceCells = screen.getAllByText("Alice Smith");
    expect(aliceCells.length).toBeGreaterThan(0);

    // Engineering row renders the displayName and a Group label in the
    // Email / Group column. Two cells in the row match "Group" (the Type
    // column cell + the Email/Group fallback) — assert >=1 instead of
    // exactly one.
    const groupRow = screen.getByText("Engineering").closest("tr")!;
    expect(within(groupRow).getAllByText("Group").length).toBeGreaterThan(0);
  });

  it("falls back to email or principalId when displayName is missing", () => {
    const desiredAssignments: DesiredAssignmentWithDisplay[] = [
      {
        principalId: "user-with-email-only",
        principalType: "USER",
        email: "noname@example.com",
      },
      {
        principalId: "user-with-only-id",
        principalType: "USER",
      },
    ];

    render(<PendingAssignmentsList desiredAssignments={desiredAssignments} />);

    // Name falls back to email when displayName is missing. Email also
    // shows in the Email/Group column for users, so getAllByText.
    expect(screen.getAllByText("noname@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("user-with-only-id")).toBeInTheDocument();
  });
});
