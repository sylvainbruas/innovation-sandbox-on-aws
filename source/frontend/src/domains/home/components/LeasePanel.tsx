// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Badge,
  ColumnLayout,
  Container,
  Header,
  KeyValuePairs,
  SpaceBetween,
} from "@cloudscape-design/components";

import {
  isExpiredLease,
  isMonitoredLease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { AccountId } from "@amzn/innovation-sandbox-frontend/components/AccountId";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { LeaseName } from "@amzn/innovation-sandbox-frontend/components/LeaseName";
import { LeaseTemplateName } from "@amzn/innovation-sandbox-frontend/components/LeaseTemplateName";
import { LeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseActions";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import { isLeaseOwner } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useLeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/useLeaseActions";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

interface LeasePanelProps {
  lease: LeaseWithLeaseId;
}

export const LeasePanel = ({ lease }: LeasePanelProps) => {
  const { hasAnyAction } = useLeaseActions(lease);
  const { user } = useUser();
  const isOwner = isLeaseOwner(lease, user);

  return (
    <Container data-shadow>
      <SpaceBetween size="l">
        <Header
          variant="h3"
          actions={hasAnyAction ? <LeaseActions lease={lease} /> : undefined}
        >
          <LeaseName
            uuid={lease.uuid}
            templateName={lease.originalLeaseTemplateName}
            leaseId={lease.leaseId}
            fontSize="heading-m"
          />
        </Header>
        <ColumnLayout columns={3} variant="text-grid">
          <KeyValuePairs
            items={[
              { label: "Status", value: <LeaseStatusBadge lease={lease} /> },
              {
                label: "Owner",
                value: (
                  <SpaceBetween direction="horizontal" size="xs">
                    <span>{lease.userEmail}</span>
                    {isOwner ? (
                      <Badge>You</Badge>
                    ) : (
                      <Badge color="blue">Shared</Badge>
                    )}
                  </SpaceBetween>
                ),
              },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: "Lease Template",
                value: (
                  <LeaseTemplateName
                    name={lease.originalLeaseTemplateName}
                    uuid={lease.originalLeaseTemplateUuid}
                  />
                ),
              },
              {
                label: "AWS Account",
                value: (
                  <AccountId
                    accountId={
                      isMonitoredLease(lease) ? lease.awsAccountId : undefined
                    }
                    copyable
                    emptyText={`No account assigned${lease.status === "PendingApproval" ? " yet" : ""}`}
                  />
                ),
              },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: "Expiry",
                value: <DurationStatus {...getLeaseExpiryInfo(lease)} />,
              },
              {
                label: "Budget",
                value: (
                  <BudgetProgressBar
                    currentValue={
                      isMonitoredLease(lease) || isExpiredLease(lease)
                        ? lease.totalCostAccrued
                        : 0
                    }
                    maxValue={lease.maxSpend}
                  />
                ),
              },
            ]}
          />
        </ColumnLayout>
      </SpaceBetween>
    </Container>
  );
};
