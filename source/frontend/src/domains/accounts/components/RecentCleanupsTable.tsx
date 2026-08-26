// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Header,
  StatusIndicator,
  Table,
} from "@cloudscape-design/components";

import { getCleanupStatusConfig } from "@amzn/innovation-sandbox-frontend/domains/accounts/helpers";
import { CleanupReport } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import {
  formatDuration,
  formatReason,
  renderTimePopover,
} from "./cleanup-report-helpers";

interface RecentCleanupsTableProps {
  reports: CleanupReport[];
  selectedReport: CleanupReport;
  onSelect: (report: CleanupReport) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
}

export const RecentCleanupsTable = ({
  reports,
  selectedReport,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRefresh,
}: RecentCleanupsTableProps) => {
  return (
    <Table
      variant="container"
      header={
        <Header
          counter={`(${reports.length})`}
          actions={
            <Button
              iconName="refresh"
              ariaLabel="Refresh cleanup reports"
              onClick={onRefresh}
            />
          }
        >
          Recent cleanups
        </Header>
      }
      columnDefinitions={[
        {
          id: "status",
          header: "Status",
          cell: (report: CleanupReport) => {
            if (report.status === "COMPLETED") {
              return (
                <StatusIndicator type="success">Completed</StatusIndicator>
              );
            }
            if (report.status === "FAILED") {
              return <StatusIndicator type="error">Failed</StatusIndicator>;
            }
            const config = getCleanupStatusConfig(report.cleanupStatus);
            return (
              <StatusIndicator type={config.type}>
                {config.label}
              </StatusIndicator>
            );
          },
          width: 160,
        },
        {
          id: "reason",
          header: "Cleanup reason",
          cell: (report: CleanupReport) =>
            formatReason(report.reasonForCleanup),
        },
        {
          id: "started",
          header: "Started",
          cell: (report: CleanupReport) => renderTimePopover(report.startedAt),
        },
        {
          id: "duration",
          header: "Duration",
          cell: (report: CleanupReport) => formatDuration(report),
        },
      ]}
      items={reports}
      selectedItems={[selectedReport]}
      onSelectionChange={({ detail }) => {
        if (detail.selectedItems.length > 0) {
          onSelect(detail.selectedItems[0]);
        }
      }}
      selectionType="single"
      trackBy="startedAt"
      footer={
        hasNextPage ? (
          <Box textAlign="center">
            <Button onClick={onLoadMore} loading={isFetchingNextPage}>
              Load more
            </Button>
          </Box>
        ) : undefined
      }
      empty={
        <Box textAlign="center" color="inherit" variant="p">
          No cleanup history available
        </Box>
      }
    />
  );
};
