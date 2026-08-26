// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Header, Tabs } from "@cloudscape-design/components";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  isActiveLease,
  isExpiredLease,
  isFrozenLease,
  isMonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { getUserEmail } from "@amzn/innovation-sandbox-commons/utils/auth-utils";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { AssignmentsTab } from "@amzn/innovation-sandbox-frontend/domains/leases/components/AssignmentsTab";
import { LeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseActions";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import {
  generateBreadcrumb,
  getLeaseDisplayName,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { MonitoredLeaseWithLeaseId } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useLeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/useLeaseActions";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

export const LeaseDetails = () => {
  const { leaseId } = useParams();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const { isAdmin, isManager, user } = useUser();

  // Poll while a lock is held so the lock-gated header actions re-enable on
  // their own once the Assignment Processor finishes.
  const query = useGetLeaseById(leaseId, { pollWhileLocked: true });
  const { data: lease, isLoading, isError, refetch, error } = query;

  const {
    isLoading: isLoadingConfig,
    isError: isConfigError,
    data: config,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();

  const isAdminOrManager = isAdmin || isManager;

  // Details page is the operator surface for a single lease, so it opts in to
  // the Admin/Manager-only freeze/unfreeze controls.
  const { hasAnyAction } = useLeaseActions(lease, {
    includeElevatedActions: true,
  });

  // Update breadcrumb with lease details
  useEffect(() => {
    const breadcrumb = generateBreadcrumb(query, {
      isUserView: !isAdminOrManager,
    });
    setBreadcrumb(breadcrumb);
    setTools(<Markdown file="lease-details" />);
  }, [query.isLoading, setBreadcrumb, isAdminOrManager]);

  if (isLoading || isLoadingConfig) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  if (isError || !lease) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading this lease."
          retry={refetch}
          error={error as Error}
        />
      </ContentLayout>
    );
  }

  if (isConfigError) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading global configuration settings."
          retry={refetchConfig}
          error={configError as Error}
        />
      </ContentLayout>
    );
  }

  const leaseSharingEnabled = config?.leases.leaseSharingEnabled || false;
  const enablePrincipalSearch = config?.leases.enablePrincipalSearch ?? false;
  const viewerEmail = user ? getUserEmail(user) : undefined;

  return (
    <LeaseDetailsView
      lease={lease}
      leaseId={leaseId}
      isAdminOrManager={isAdminOrManager}
      hasAnyAction={hasAnyAction}
      viewerEmail={viewerEmail}
      leaseSharingEnabled={leaseSharingEnabled}
      enablePrincipalSearch={enablePrincipalSearch}
    />
  );
};

// Presentational view for a successfully-loaded lease; the parent handles data
// fetching and loading/error states.
const LeaseDetailsView = ({
  lease,
  leaseId,
  isAdminOrManager,
  hasAnyAction,
  viewerEmail,
  leaseSharingEnabled,
  enablePrincipalSearch,
}: {
  lease: MonitoredLeaseWithLeaseId;
  leaseId: string | undefined;
  isAdminOrManager: boolean;
  hasAnyAction: boolean;
  viewerEmail: string | undefined;
  leaseSharingEnabled: boolean;
  enablePrincipalSearch: boolean;
}) => {
  const navigate = useNavigate();

  // Edit controls route to admin-only pages, so only managers/admins get them.
  // They also only apply to monitored (Active/Frozen) leases.
  const showEditButtons = isAdminOrManager && isMonitoredLease(lease);
  const isOwner = !!viewerEmail && viewerEmail === lease.userEmail;
  // Frozen and terminal leases render the tab read-only. Both retain their
  // desired set — a freeze so unfreeze can restore access, a termination because
  // nothing clears it — so the list still answers "who had access to this
  // account", which is the audit question. Pending/denied leases never had an
  // account, so there is nothing to show.
  const showAssignmentsTab =
    (isActiveLease(lease) || isFrozenLease(lease) || isExpiredLease(lease)) &&
    (isAdminOrManager || isOwner);

  // All four edit controls share the same show/hide rule; only the target
  // route differs.
  const makeEditHandler = (path: string) =>
    showEditButtons ? () => navigate(path) : undefined;

  const summary = (
    <LeaseSummary
      lease={lease}
      showEditButtons={showEditButtons}
      showAdminFields={isAdminOrManager}
      leaseSharingEnabled={leaseSharingEnabled}
      onEditBudget={makeEditHandler(`/leases/${leaseId}/edit/budget`)}
      onEditDuration={makeEditHandler(`/leases/${leaseId}/edit/duration`)}
      onEditCostReport={makeEditHandler(`/leases/${leaseId}/edit/cost-report`)}
      onEditSharing={makeEditHandler(`/leases/${leaseId}/edit/sharing`)}
    />
  );

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            hasAnyAction ? (
              <LeaseActions lease={lease} includeElevatedActions />
            ) : undefined
          }
        >
          {getLeaseDisplayName(lease)}
        </Header>
      }
    >
      {showAssignmentsTab ? (
        <Tabs
          tabs={[
            { id: "summary", label: "Summary", content: summary },
            {
              id: "assignments",
              label: "Assignments",
              content: (
                <AssignmentsTab
                  lease={lease}
                  leaseRouteId={leaseId!}
                  leaseSharingEnabled={leaseSharingEnabled}
                  enablePrincipalSearch={enablePrincipalSearch}
                  isElevated={isAdminOrManager}
                  isOwner={isOwner}
                />
              ),
            },
          ]}
        />
      ) : (
        summary
      )}
    </ContentLayout>
  );
};
