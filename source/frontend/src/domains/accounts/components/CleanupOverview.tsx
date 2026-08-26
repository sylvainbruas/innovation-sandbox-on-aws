// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  Container,
  Header,
  SpaceBetween,
  Spinner,
  StatusIndicator,
} from "@cloudscape-design/components";
import { useState } from "react";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { CleanupDetails } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/CleanupDetails";
import { RecentCleanupsTable } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/RecentCleanupsTable";
import {
  useGetCleanupReports,
  useSkipCooldown,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/hooks";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

interface CleanupOverviewProps {
  accountId: string;
}

export const CleanupOverview = ({ accountId }: CleanupOverviewProps) => {
  const {
    reports,
    isLoading,
    isError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useGetCleanupReports(accountId);

  const { showModal, hideModal } = useModal();
  const { mutateAsync: skipCooldown, isPending: isSkipping } =
    useSkipCooldown(accountId);

  const [selectedStartedAt, setSelectedStartedAt] = useState<string | null>(
    null,
  );

  if (isLoading) {
    return (
      <Container header={<Header variant="h2">Recent cleanups</Header>}>
        <Box textAlign="center" padding="l">
          <Spinner size="large" />
        </Box>
      </Container>
    );
  }

  if (isError) {
    return (
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button
                iconName="refresh"
                ariaLabel="Refresh cleanup reports"
                onClick={() => refetch()}
              />
            }
          >
            Recent cleanups
          </Header>
        }
      >
        <Box textAlign="center">
          <StatusIndicator type="error">
            Failed to load cleanup history
          </StatusIndicator>
        </Box>
      </Container>
    );
  }

  if (reports.length === 0) {
    return (
      <Container header={<Header variant="h2">Recent cleanups</Header>}>
        <Box textAlign="center" color="inherit" variant="p">
          No cleanup history available for this account
        </Box>
      </Container>
    );
  }

  const selectedReport =
    reports.find((r) => r.startedAt === selectedStartedAt) ?? reports[0];

  // Determine if the selected report is in cooldown
  const isCoolingDown = selectedReport.cleanupStatus === "COOLING_DOWN";

  const handleSkipCooldown = () => {
    showModal({
      header: "Skip account cooldown?",
      content: (
        <SpaceBetween size="m">
          <Alert type="warning">
            This account is in a post-cleanup cooldown to allow AWS cost data to
            fully propagate. Skipping the cooldown may result in costs from the
            previous lease being attributed to the next user assigned to this
            account.
          </Alert>
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={hideModal}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await skipCooldown();
                  showSuccessToast("Cooldown skipped successfully.");
                  hideModal();
                } catch {
                  showErrorToast(
                    "Failed to skip cooldown.",
                    "Skip cooldown failed",
                  );
                }
              }}
              loading={isSkipping}
            >
              Skip cooldown
            </Button>
          </SpaceBetween>
        </SpaceBetween>
      ),
    });
  };

  return (
    <SpaceBetween size="l">
      <RecentCleanupsTable
        reports={reports}
        selectedReport={selectedReport}
        onSelect={(report) => setSelectedStartedAt(report.startedAt)}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={fetchNextPage}
        onRefresh={() => refetch()}
      />
      <CleanupDetails
        report={selectedReport}
        onSkipCooldown={isCoolingDown ? handleSkipCooldown : undefined}
        isSkipping={isSkipping}
      />
    </SpaceBetween>
  );
};
