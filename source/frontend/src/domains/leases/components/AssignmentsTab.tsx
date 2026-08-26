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
  StatusIndicator,
  Table,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  isExpiredLease,
  isFrozenLease,
  Lease,
  type LeaseLockIntent,
  MAX_ASSIGNMENTS,
  MAX_USER_MANAGED_ASSIGNMENTS,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { PrincipalTypeahead } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead";
import {
  useGetAssignments,
  useUpdateAssignments,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import {
  AssignmentPrincipalRef,
  type AssignmentSyncStatus,
  IdcPrincipal,
  LeaseAssignment,
  PrincipalType,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";

// "restored" re-desires a principal the server no longer wants but still has an
// assignment for (a pending revoke). Distinct from "added" because the
// assignment already exists, so the backend resolves it to a NO_OP: the row
// settles back to active without re-granting.
type RowState = "current" | "added" | "removed" | "restored";

type AssignmentRow = {
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  subtitle?: string;
  addedBy?: string;
  addedDate?: string;
  state: RowState;
  isOwner: boolean;
  isDesired: boolean;
  // Only meaningful for "current" rows; staged rows get their own badge.
  syncStatus: AssignmentSyncStatus;
};

const IN_FLIGHT_MESSAGE: Record<LeaseLockIntent, string> = {
  FREEZE:
    "Freezing this lease. Account access is being revoked for everyone listed.",
  UNFREEZE:
    "Unfreezing this lease. Account access is being restored for everyone listed.",
  TERMINATE:
    "Terminating this lease. Account access is being revoked for everyone listed.",
  PUBLISH: "Setting up access for this lease.",
  UPDATE:
    "An update is being processed. Saving more changes is paused until it completes.",
};

type AssignmentsTabProps = {
  lease: Lease;
  leaseRouteId: string;
  leaseSharingEnabled: boolean;
  enablePrincipalSearch: boolean;
  isElevated: boolean;
  isOwner: boolean;
};

// addedBy/addedDate are server-stamped; the typeahead never surfaces the
// owner (already excluded), so isOwner is always false here.
function rowFromTypeaheadPick(p: IdcPrincipal): AssignmentRow {
  return {
    principalId: p.principalId,
    principalType: p.principalType,
    displayName: p.displayName,
    subtitle: p.principalType === "USER" ? p.email : "Group",
    state: "added",
    isOwner: false,
    isDesired: true,
    syncStatus: "active",
  };
}

function rowFromApi(assignment: LeaseAssignment): AssignmentRow {
  return {
    principalId: assignment.principalId,
    principalType: assignment.principalType,
    displayName: assignment.displayName,
    subtitle:
      assignment.principalType === "USER" ? assignment.assigneeEmail : "Group",
    addedBy: assignment.addedBy,
    addedDate: assignment.addedDate,
    state: "current",
    isOwner: assignment.isOwner,
    isDesired: assignment.isDesired,
    syncStatus: assignment.syncStatus,
  };
}

export const AssignmentsTab = ({
  lease,
  leaseRouteId,
  leaseSharingEnabled,
  enablePrincipalSearch,
  isElevated,
  isOwner,
}: AssignmentsTabProps) => {
  const allowOwnerToShareLease = lease.allowOwnerToShareLease ?? false;

  // Frozen and terminal leases keep their desired assignments but hold no live
  // records, so the tab is informational: on a frozen lease it shows what
  // unfreeze will restore, on a terminal one who last had access. The API
  // rejects edits on a non-active lease with 409, so editing is gated on status
  // and not just on role.
  const isFrozen = isFrozenLease(lease);
  const isTerminal = isExpiredLease(lease);
  const isReadOnly = isFrozen || isTerminal;

  const isAuthorizedToManage =
    isElevated || (isOwner && leaseSharingEnabled && allowOwnerToShareLease);
  const canManage = isAuthorizedToManage && !isReadOnly;

  const { data, isFetching, isError, refetch, error } =
    useGetAssignments(leaseRouteId);
  const update = useUpdateAssignments();

  const queryClient = useQueryClient();

  // The in-flight operation arrives on the same response as the statuses, so
  // progress, polling and row state can never fall out of step.
  const activeLockIntent = data?.operationInProgress;
  const isAwaitingBackend = !!activeLockIntent;

  // Poll while processing so individual completions (one user granted while
  // another is still pending) appear progressively.
  useEffect(() => {
    if (!isAwaitingBackend) return;
    const interval = setInterval(() => refetch(), 5_000);
    return () => clearInterval(interval);
  }, [isAwaitingBackend, refetch]);

  const [rowsById, setRowsById] = useState<Record<string, AssignmentRow>>({});

  // A projection, not a derivation — the API has already reconciled the view.
  const reconcileAssignmentRows = useCallback((): Record<
    string,
    AssignmentRow
  > => {
    if (!data) return {};
    return Object.fromEntries(
      data.assignments.map((a) => [a.principalId, rowFromApi(a)]),
    );
  }, [data]);

  useEffect(() => {
    setRowsById(reconcileAssignmentRows());
  }, [reconcileAssignmentRows]);

  const allRows = useMemo(() => Object.values(rowsById), [rowsById]);

  const isDirty = useMemo(
    () => allRows.some((r) => r.state !== "current"),
    [allRows],
  );

  // Re-submitting the current desired set is idempotent and re-dispatches the
  // processor, so these rows get an explicit Retry — otherwise the only way to
  // recover is to stage a throwaway edit, since Save is gated on isDirty.
  const hasSyncFailures = useMemo(
    () =>
      allRows.some(
        (r) =>
          r.syncStatus === "grantFailed" || r.syncStatus === "revokeFailed",
      ),
    [allRows],
  );

  const desiredRefs: AssignmentPrincipalRef[] = useMemo(
    () =>
      allRows
        .filter((r) => !r.isOwner)
        .filter((r) => {
          switch (r.state) {
            case "added":
            case "restored":
              return true;
            case "removed":
              return false;
            case "current":
              return r.isDesired;
          }
        })
        .map((r) => ({
          principalId: r.principalId,
          principalType: r.principalType,
        })),
    [allRows],
  );

  const excludePrincipalIds = useMemo(
    () =>
      new Set(
        allRows.filter((r) => r.state !== "removed").map((r) => r.principalId),
      ),
    [allRows],
  );

  const shouldExclude = useCallback(
    (p: IdcPrincipal) =>
      excludePrincipalIds.has(p.principalId) ||
      (p.principalType === "USER" && p.email === lease.userEmail),
    [excludePrincipalIds, lease.userEmail],
  );

  const isAtCapacity = desiredRefs.length >= MAX_USER_MANAGED_ASSIGNMENTS;

  const handleAdd = (p: IdcPrincipal) => {
    if (isAtCapacity) return;
    const key = p.principalId;
    setRowsById((prev) => {
      const existing = prev[key];
      // Un-remove a staged removal instead of duplicating the row.
      if (existing?.state === "removed") {
        return { ...prev, [key]: { ...existing, state: "current" } };
      }
      return { ...prev, [key]: rowFromTypeaheadPick(p) };
    });
  };

  const handleRemove = (row: AssignmentRow) => {
    const key = row.principalId;
    setRowsById((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      // Drop unsaved adds outright; stage current rows so the user sees
      // what's about to go.
      if (existing.state === "added") {
        const { [key]: _omit, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: { ...existing, state: "removed" } };
    });
  };

  const handleRestore = (row: AssignmentRow) => {
    const key = row.principalId;
    setRowsById((prev) => {
      const existing = prev[key];
      return existing?.state === "current"
        ? { ...prev, [key]: { ...existing, state: "restored" } }
        : prev;
    });
  };

  const handleUndoStagedChange = (row: AssignmentRow) => {
    const key = row.principalId;
    setRowsById((prev) => {
      const existing = prev[key];
      if (existing?.state !== "removed" && existing?.state !== "restored") {
        return prev;
      }
      return { ...prev, [key]: { ...existing, state: "current" } };
    });
  };

  const handleDiscard = () => {
    setRowsById(reconcileAssignmentRows());
  };

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        leaseId: leaseRouteId,
        assignments: desiredRefs,
      });
      // Refetch the view so it picks up operationInProgress and starts polling;
      // without this we'd keep reading the pre-save response and never poll.
      await queryClient.invalidateQueries({
        queryKey: ["assignments", leaseRouteId],
        refetchType: "all",
      });
      // The lease drives the header actions (which gate on the lock), so keep
      // it fresh for LeaseDetails too.
      await queryClient.invalidateQueries({
        queryKey: ["leases", leaseRouteId],
        refetchType: "all",
      });
      showSuccessToast("Assignments saved. Access changes will apply shortly.");
    } catch (err) {
      console.error("Failed to update assignments", err);
      showErrorToast(
        "Failed to save assignment changes. Please try again.",
        "Save failed",
      );
    }
  };

  if (isFetching && !data) {
    return <Loader />;
  }

  if (isError) {
    return (
      <ErrorPanel
        description="There was a problem loading assignments for this lease."
        retry={refetch}
        error={error as Error}
      />
    );
  }

  // Only brand-new additions move to the end; staged edits to existing rows keep
  // their place so the row doesn't jump when the user clicks.
  const stateRank: Record<RowState, number> = {
    current: 0,
    added: 1,
    removed: 0,
    restored: 0,
  };
  const sortedRows = [...allRows].sort((a, b) => {
    // Owner always first
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    // New additions at the end
    if (stateRank[a.state] !== stateRank[b.state]) {
      return stateRank[a.state] - stateRank[b.state];
    }
    return a.displayName.localeCompare(b.displayName);
  });

  return (
    <SpaceBetween size="m">
      {!leaseSharingEnabled && isElevated && (
        <Alert type="info" header="Lease sharing is disabled globally">
          Lease owners can't manage assignments while this feature is off. As an
          Admin or Manager you can still add or remove assignments.
        </Alert>
      )}

      <Container
        header={
          <Header
            variant="h3"
            counter={`(${desiredRefs.length + 1}/${MAX_ASSIGNMENTS})`}
            description={
              canManage
                ? "Pick a user or group to add to this lease."
                : undefined
            }
          >
            {canManage ? "Share access" : "Assignments"}
          </Header>
        }
      >
        <SpaceBetween size="m">
          {canManage && isAtCapacity && (
            <Alert type="warning">
              This lease has reached the maximum of {MAX_ASSIGNMENTS} assigned
              principals. Remove an existing assignment to add another.
            </Alert>
          )}

          {canManage && (
            <ColumnLayout columns={3}>
              <PrincipalTypeahead
                onSelect={handleAdd}
                shouldExclude={shouldExclude}
                enablePrincipalSearch={enablePrincipalSearch}
                disabled={isAtCapacity}
              />
            </ColumnLayout>
          )}

          <Table<AssignmentRow>
            items={sortedRows}
            loading={isFetching && !data}
            loadingText="Loading assignments"
            trackBy={(row) => row.principalId}
            variant="embedded"
            empty={
              <Box textAlign="center" color="text-status-inactive">
                <b>No assignments</b>
                <Box variant="p" color="inherit">
                  {canManage
                    ? "Use the search box above to share this lease."
                    : "This lease has not been shared with anyone yet."}
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
                    {row.isOwner && <Badge color="grey">Owner</Badge>}
                  </SpaceBetween>
                ),
              },
              {
                id: "type",
                header: "Type",
                cell: (row) =>
                  row.principalType === "USER" ? "User" : "Group",
              },
              {
                id: "status",
                header: "Status",
                cell: (row) => {
                  // A restore is an add from the user's point of view.
                  if (row.state === "added" || row.state === "restored") {
                    return (
                      <StatusIndicator type="pending">
                        Pending add
                      </StatusIndicator>
                    );
                  }
                  if (row.state === "removed") {
                    return (
                      <StatusIndicator type="pending">
                        Pending remove
                      </StatusIndicator>
                    );
                  }

                  if (row.syncStatus === "granting") {
                    return (
                      <StatusIndicator type="loading">Granting</StatusIndicator>
                    );
                  }
                  if (row.syncStatus === "revoking") {
                    return (
                      <StatusIndicator type="loading">Revoking</StatusIndicator>
                    );
                  }
                  if (row.syncStatus === "suspended") {
                    // Same server status, different words: a frozen lease can be
                    // unfrozen, a terminated one cannot.
                    return (
                      <StatusIndicator type="stopped">
                        {isTerminal ? "Access ended" : "Access suspended"}
                      </StatusIndicator>
                    );
                  }
                  if (row.syncStatus === "grantFailed") {
                    return (
                      <StatusIndicator type="error">
                        Grant failed
                      </StatusIndicator>
                    );
                  }
                  if (row.syncStatus === "revokeFailed") {
                    return (
                      <StatusIndicator type="error">
                        Revoke failed
                      </StatusIndicator>
                    );
                  }
                  return (
                    <StatusIndicator type="success">Active</StatusIndicator>
                  );
                },
              },
              {
                id: "subtitle",
                header: "Email / Group",
                cell: (row) => row.subtitle ?? "—",
              },
              {
                id: "addedBy",
                header: "Added by",
                cell: (row) => row.addedBy ?? "—",
              },
              {
                id: "addedDate",
                header: "Added",
                cell: (row) =>
                  row.addedDate
                    ? DateTime.fromISO(row.addedDate).toRelative()
                    : "—",
              },
              {
                id: "actions",
                header: "",
                cell: (row) => {
                  // The owner is auto-injected server-side and cannot be
                  // removed from the UI — they'd lock themselves out.
                  if (!canManage || row.isOwner) {
                    return null;
                  }
                  // Reverting means not-desired, which the server already wants,
                  // so discard the staged change rather than stage a removal.
                  if (row.state === "restored") {
                    return (
                      <Button
                        variant="inline-link"
                        onClick={() => handleUndoStagedChange(row)}
                        disabled={update.isPending || isAwaitingBackend}
                      >
                        Remove
                      </Button>
                    );
                  }
                  // Removal is already pending, so Remove is meaningless — but
                  // the revoke itself may be the mistake, so offer to undo it.
                  if (row.state === "current" && !row.isDesired) {
                    return (
                      <Button
                        variant="inline-link"
                        onClick={() => handleRestore(row)}
                        disabled={
                          update.isPending || isAwaitingBackend || isAtCapacity
                        }
                      >
                        Undo
                      </Button>
                    );
                  }
                  if (row.state === "removed") {
                    return (
                      <Button
                        variant="inline-link"
                        onClick={() => handleUndoStagedChange(row)}
                        disabled={
                          update.isPending || isAwaitingBackend || isAtCapacity
                        }
                      >
                        Undo
                      </Button>
                    );
                  }
                  return (
                    <Button
                      variant="inline-link"
                      onClick={() => handleRemove(row)}
                      disabled={update.isPending || isAwaitingBackend}
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

      {isAwaitingBackend && isAuthorizedToManage && (
        <Alert type="info">
          {IN_FLIGHT_MESSAGE[activeLockIntent ?? "UPDATE"]}
        </Alert>
      )}

      {isFrozen && !isAwaitingBackend && isAuthorizedToManage && (
        <Alert type="info">
          This lease is frozen, so account access is suspended for everyone
          listed. The list is kept so access is restored when the lease is
          unfrozen. Unfreeze the lease to change assignments.
        </Alert>
      )}

      {isTerminal && !isAwaitingBackend && isAuthorizedToManage && (
        <Alert type="info">
          This lease has ended, so account access is revoked for everyone
          listed. The list is kept as a record of who had access to the account.
        </Alert>
      )}

      {/* Suppressed once anything is staged: Retry submits the same desired set
          Save does, so showing both would be two buttons for one action. */}
      {canManage && !isAwaitingBackend && hasSyncFailures && !isDirty && (
        <Alert
          type="warning"
          header="Some access changes did not apply"
          action={
            <Button onClick={handleSave} loading={update.isPending}>
              Retry
            </Button>
          }
        >
          Retry to reapply the access shown below. No changes to the list are
          required.
        </Alert>
      )}

      {canManage && (
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              onClick={handleDiscard}
              disabled={!isDirty || update.isPending || isAwaitingBackend}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              loading={update.isPending || isAwaitingBackend}
              disabled={!isDirty || isAwaitingBackend}
            >
              Save changes
            </Button>
          </SpaceBetween>
        </Box>
      )}
    </SpaceBetween>
  );
};
