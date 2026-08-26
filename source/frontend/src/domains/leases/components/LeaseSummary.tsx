// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  ColumnLayout,
  Container,
  CopyToClipboard,
  Header,
  KeyValuePairs,
  Popover,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import {
  isExpiredLease,
  isMonitoredLease,
  isPendingLease,
  Lease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { AccountId } from "@amzn/innovation-sandbox-frontend/components/AccountId";
import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { BudgetStatus } from "@amzn/innovation-sandbox-frontend/components/BudgetStatus";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { LeaseName } from "@amzn/innovation-sandbox-frontend/components/LeaseName";
import { LeaseTemplateName } from "@amzn/innovation-sandbox-frontend/components/LeaseTemplateName";
import { SharingStatusIndicator } from "@amzn/innovation-sandbox-frontend/components/SharingStatusIndicator";
import { ThresholdDetails } from "@amzn/innovation-sandbox-frontend/components/ThresholdDetails";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import { DateTime } from "luxon";

interface LeaseSummaryProps {
  lease: Lease;
  showEditButtons?: boolean;
  showAdminFields?: boolean;
  leaseSharingEnabled?: boolean;
  onEditBudget?: () => void;
  onEditDuration?: () => void;
  onEditCostReport?: () => void;
  onEditSharing?: () => void;
}

// Helper function to render time popover
const renderTimePopover = (date: string) => (
  <Popover
    position="top"
    size="large"
    dismissButton={false}
    content={DateTime.fromISO(date).toLocaleString(DateTime.DATETIME_HUGE)}
  >
    <Box>{DateTime.fromISO(date).toRelative()}</Box>
  </Popover>
);

// Helper function to render approved by
const renderApprovedBy = (lease: Lease) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return <StatusIndicator type="info">Not approved</StatusIndicator>;
  }

  if (lease.approvedBy === "AUTO_APPROVED") {
    return <StatusIndicator type="success">Auto Approved</StatusIndicator>;
  }

  return lease.approvedBy;
};

// Helper function to render lease started
const renderLeaseStarted = (lease: Lease) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return <StatusIndicator type="info">Not started</StatusIndicator>;
  }

  return renderTimePopover(lease.startDate);
};

// Helper function to render last monitored
const renderLastMonitored = (lease: Lease) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return <StatusIndicator type="info">Not monitored</StatusIndicator>;
  }

  return renderTimePopover(lease.lastCheckedDate);
};

// Helper function to render comments
const renderComments = (comments?: string) => {
  if (!comments) {
    return <StatusIndicator type="info">No comments provided</StatusIndicator>;
  }

  return comments;
};

// Helper function to render budget status
const renderBudgetStatus = (lease: Lease) => {
  const isPending = isPendingLease(lease);
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (isPending) {
    return <BudgetStatus maxSpend={lease.maxSpend} />;
  }

  return (
    <BudgetProgressBar
      currentValue={isMonitoredOrExpired ? lease.totalCostAccrued : 0}
      maxValue={lease.maxSpend}
    />
  );
};

// Helper function to render cost report group
const renderCostReportGroup = (costReportGroup?: string) => {
  if (!costReportGroup) {
    return <StatusIndicator type="info">Not assigned</StatusIndicator>;
  }

  return costReportGroup;
};

export const LeaseSummary = ({
  lease,
  showEditButtons = false,
  showAdminFields = false,
  leaseSharingEnabled = false,
  onEditBudget,
  onEditDuration,
  onEditCostReport,
  onEditSharing,
}: LeaseSummaryProps) => {
  return (
    <SpaceBetween size="l">
      {/* Basic Details */}
      <Container header={<Header variant="h2">Lease Details</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: "Name",
                value: (
                  <LeaseName
                    uuid={lease.uuid}
                    templateName={lease.originalLeaseTemplateName}
                  />
                ),
              },
              {
                label: "UUID",
                value: (
                  <CopyToClipboard
                    variant="inline"
                    textToCopy={lease.uuid}
                    copyButtonAriaLabel="Copy lease UUID"
                    copySuccessText="UUID copied"
                    copyErrorText="Failed to copy"
                  />
                ),
              },
              {
                label: "AWS Account ID",
                value: (
                  <AccountId
                    accountId={
                      isMonitoredLease(lease) || isExpiredLease(lease)
                        ? lease.awsAccountId
                        : undefined
                    }
                    copyable
                  />
                ),
              },
              {
                label: "Lease Template",
                value: (
                  <LeaseTemplateName
                    uuid={lease.originalLeaseTemplateUuid}
                    name={lease.originalLeaseTemplateName}
                  />
                ),
              },
              {
                label: "Blueprint Name",
                value: <BlueprintName blueprintName={lease.blueprintName} />,
              },
              {
                label: "Owner",
                value: lease.userEmail,
              },
            ]}
          />
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: "Status",
                value: <LeaseStatusBadge lease={lease} />,
              },
              {
                label: "Created By",
                value: lease.createdBy ?? lease.userEmail,
              },
              {
                label: "Approved By",
                value: renderApprovedBy(lease),
              },
              {
                label: "Lease Started",
                value: renderLeaseStarted(lease),
              },
              ...(showAdminFields
                ? [
                    {
                      label: "Last Monitored",
                      value: renderLastMonitored(lease),
                    },
                  ]
                : []),
              {
                label: "Comments from Requester",
                value: renderComments(lease.comments),
              },
            ]}
          />
        </ColumnLayout>
      </Container>

      {/* Budget Settings */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditBudget ? (
                <Button iconName="edit" onClick={onEditBudget}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Budget Settings
          </Header>
        }
      >
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: <Box variant="h3">Budget Status</Box>,
                value: renderBudgetStatus(lease),
              },
            ]}
          />
          {showAdminFields && (
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: <Box variant="h3">Budget Thresholds</Box>,
                  value: (
                    <ThresholdDetails
                      thresholds={lease.budgetThresholds}
                      valueLabel="Cost Accrued"
                      renderValue={(threshold) =>
                        `$${threshold.dollarsSpent.toFixed(2)}`
                      }
                    />
                  ),
                },
              ]}
            />
          )}
        </ColumnLayout>
      </Container>

      {/* Duration Settings */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditDuration ? (
                <Button iconName="edit" onClick={onEditDuration}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Duration Settings
          </Header>
        }
      >
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: <Box variant="h3">Lease Expiry</Box>,
                value: <DurationStatus {...getLeaseExpiryInfo(lease)} />,
              },
            ]}
          />
          {showAdminFields && (
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: <Box variant="h3">Duration Thresholds</Box>,
                  value: (
                    <ThresholdDetails
                      thresholds={lease.durationThresholds}
                      valueLabel="Hours Remaining"
                      renderValue={(threshold) =>
                        `${threshold.hoursRemaining} hours`
                      }
                    />
                  ),
                },
              ]}
            />
          )}
        </ColumnLayout>
      </Container>

      {/* Cost Report Settings */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditCostReport ? (
                <Button iconName="edit" onClick={onEditCostReport}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Cost Report Settings
          </Header>
        }
      >
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "Cost Report Group",
              value: renderCostReportGroup(lease.costReportGroup),
            },
          ]}
        />
      </Container>

      {/* Sharing Settings */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditSharing && leaseSharingEnabled ? (
                <Button iconName="edit" onClick={onEditSharing}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Sharing Settings
          </Header>
        }
      >
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "Sharing",
              value: (
                <SharingStatusIndicator
                  allowOwnerToShareLease={lease.allowOwnerToShareLease}
                  leaseSharingEnabled={leaseSharingEnabled}
                />
              ),
            },
          ]}
        />
      </Container>
    </SpaceBetween>
  );
};
