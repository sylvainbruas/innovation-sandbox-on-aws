// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Badge,
  Box,
  Button,
  ColumnLayout,
  Container,
  Header,
  SpaceBetween,
  Table,
} from "@cloudscape-design/components";
import { useCallback, useMemo } from "react";
import { useFormContext } from "react-hook-form";

import { MAX_ASSIGNMENTS } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { PrincipalTypeahead } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead";
import {
  IdcPrincipal,
  PrincipalType,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";

// The form-state shape this step reads from. Both RequestLeaseFormValues
// and AssignLeaseFormValues happen to satisfy it (their `assignments`
// fields share this exact element shape), which is why the component is
// shape-typed instead of binding to a specific schema.
type StagedAssignment = {
  principalId: string;
  principalType: PrincipalType;
  displayName?: string;
  email?: string;
};

type AssignmentsFormShape = {
  assignments?: StagedAssignment[];
};

type AssignmentsFormProps = {
  enablePrincipalSearch?: boolean;
  /** Email of the lease owner. Shown as a permanent row in the table. */
  ownerEmail?: string;
};

export const AssignmentsForm = ({
  enablePrincipalSearch = true,
  ownerEmail,
}: AssignmentsFormProps = {}) => {
  const { setValue, watch } = useFormContext<AssignmentsFormShape>();
  const assignments = watch("assignments") ?? [];

  // Build display items: owner (if known) + staged assignments
  const ownerRow: StagedAssignment | undefined = ownerEmail
    ? {
        principalId: `owner-${ownerEmail}`,
        principalType: "USER",
        displayName: ownerEmail,
        email: ownerEmail,
      }
    : undefined;
  const displayItems = ownerRow ? [ownerRow, ...assignments] : assignments;
  const isAtCapacity = displayItems.length >= MAX_ASSIGNMENTS;

  const handleAdd = (p: IdcPrincipal) => {
    if (assignments.some((a) => a.principalId === p.principalId)) return;
    const next: StagedAssignment[] = [
      ...assignments,
      {
        principalId: p.principalId,
        principalType: p.principalType,
        displayName: p.displayName,
        email: p.email,
      },
    ];
    setValue("assignments", next, { shouldValidate: true, shouldDirty: true });
  };

  const handleRemove = (principalId: string) => {
    const next = assignments.filter((a) => a.principalId !== principalId);
    setValue("assignments", next, { shouldValidate: true, shouldDirty: true });
  };

  const excludeIds = useMemo(
    () => new Set(assignments.map((a) => a.principalId)),
    [assignments],
  );

  const shouldExclude = useCallback(
    (p: IdcPrincipal) =>
      excludeIds.has(p.principalId) ||
      (!!ownerEmail && p.principalType === "USER" && p.email === ownerEmail),
    [excludeIds, ownerEmail],
  );

  return (
    <Container
      header={
        <Header
          variant="h3"
          description="Optional. Pick users and groups that should access this lease as soon as it is approved."
          counter={`(${displayItems.length}/${MAX_ASSIGNMENTS})`}
        >
          Share access
        </Header>
      }
    >
      <SpaceBetween size="m">
        {isAtCapacity && (
          <Alert type="warning">
            This lease has reached the maximum of {MAX_ASSIGNMENTS} assigned
            users. Remove an existing assignment to add another.
          </Alert>
        )}

        <ColumnLayout columns={3}>
          <PrincipalTypeahead
            onSelect={handleAdd}
            shouldExclude={shouldExclude}
            enablePrincipalSearch={enablePrincipalSearch}
            disabled={isAtCapacity}
          />
        </ColumnLayout>

        <Table<StagedAssignment>
          items={displayItems}
          variant="embedded"
          trackBy={(row) => row.principalId}
          empty={
            <Box textAlign="center" color="text-status-inactive">
              <b>No one added yet</b>
              <Box variant="p" color="inherit">
                Use the search box above to share this lease at approval.
              </Box>
            </Box>
          }
          columnDefinitions={[
            {
              id: "name",
              header: "Name",
              cell: (row) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <span>{row.displayName}</span>
                  {row === ownerRow && <Badge color="grey">Owner</Badge>}
                </SpaceBetween>
              ),
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
            {
              id: "actions",
              header: "",
              cell: (row) => {
                if (row === ownerRow) return null;
                return (
                  <Button
                    variant="inline-link"
                    onClick={() => handleRemove(row.principalId)}
                  >
                    Remove
                  </Button>
                );
              },
            },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
};
