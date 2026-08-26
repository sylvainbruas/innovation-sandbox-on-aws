// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Container, Header, Table } from "@cloudscape-design/components";

import { DesiredAssignmentWithDisplay } from "@amzn/innovation-sandbox-commons/data/lease/lease";

type PendingAssignmentsListProps = {
  desiredAssignments?: DesiredAssignmentWithDisplay[];
};

// Read-only view of the pre-approval `desiredAssignments` on a pending
// lease. Used on the approval page so reviewers can see who else gets
// access if they approve. Records don't exist yet — this is intent only.
export const PendingAssignmentsList = ({
  desiredAssignments,
}: PendingAssignmentsListProps) => {
  if (!desiredAssignments || desiredAssignments.length === 0) {
    return null;
  }

  return (
    <Container
      header={
        <Header
          variant="h3"
          description="If approved, the following users and groups will receive access"
        >
          Pre-approval sharing
        </Header>
      }
    >
      <Table<DesiredAssignmentWithDisplay>
        items={desiredAssignments}
        variant="embedded"
        trackBy={(row) => row.principalId}
        empty={<Box color="text-status-inactive">No additional principals</Box>}
        columnDefinitions={[
          {
            id: "name",
            header: "Name",
            cell: (row) => row.displayName ?? row.email ?? row.principalId,
          },
          {
            id: "type",
            header: "Type",
            cell: (row) => (row.principalType === "USER" ? "User" : "Group"),
          },
          {
            id: "subtitle",
            header: "Email / Group",
            cell: (row) =>
              row.principalType === "USER" ? (row.email ?? "—") : "Group",
          },
        ]}
      />
    </Container>
  );
};
