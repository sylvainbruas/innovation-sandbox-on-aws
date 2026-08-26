// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Icon,
  Popover,
  SpaceBetween,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";

import { DEPLOYMENT_HISTORY_RETENTION_DAYS } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-dynamodb-keys.js";
import { getDeploymentStatusConfig } from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import { DeploymentHistory as DeploymentHistoryType } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";

interface DeploymentIndicatorProps {
  deployment: DeploymentHistoryType;
}

const DeploymentIndicator = ({ deployment }: DeploymentIndicatorProps) => {
  const config = getDeploymentStatusConfig(deployment.status);

  return (
    <Popover
      dismissButton={false}
      position="top"
      size="medium"
      triggerType="custom"
      content={
        <SpaceBetween size="xs">
          <Box key="status">
            <Box variant="awsui-key-label">Status</Box>
            <Box>{deployment.status}</Box>
          </Box>
          <Box key="started">
            <Box variant="awsui-key-label">Started</Box>
            <Box>
              {DateTime.fromISO(deployment.deploymentStartedAt).toLocaleString(
                DateTime.DATETIME_SHORT,
              )}
            </Box>
          </Box>
          {deployment.deploymentCompletedAt && (
            <Box key="completed">
              <Box variant="awsui-key-label">Completed</Box>
              <Box>
                {DateTime.fromISO(
                  deployment.deploymentCompletedAt,
                ).toLocaleString(DateTime.DATETIME_SHORT)}
              </Box>
            </Box>
          )}
          {deployment.duration && (
            <Box key="duration">
              <Box variant="awsui-key-label">Duration</Box>
              <Box>{deployment.duration} minutes</Box>
            </Box>
          )}
          {deployment.errorMessage && (
            <Box key="error">
              <Box variant="awsui-key-label">Error</Box>
              <Box color="text-status-error">{deployment.errorMessage}</Box>
            </Box>
          )}
          <Box key="account">
            <Box variant="awsui-key-label">Account</Box>
            <Box>{deployment.accountId}</Box>
          </Box>
          <Box key="lease">
            <Box variant="awsui-key-label">Lease</Box>
            <Box>{deployment.leaseId}</Box>
          </Box>
        </SpaceBetween>
      }
    >
      <Box color={config.color}>
        <Icon name={config.iconName} size="medium" />
      </Box>
    </Popover>
  );
};

interface DeploymentHistoryProps {
  deployments?: DeploymentHistoryType[];
  totalDeploymentCount?: number;
}

// Retention days come from the shared backend TTL constant so this copy can't drift.
const HISTORY_RETENTION_NOTE = `Detailed deployment history is retained for ${DEPLOYMENT_HISTORY_RETENTION_DAYS} days. Older deployments still count toward the deployment totals but are no longer listed here.`;

export const DeploymentHistory = ({
  deployments,
  totalDeploymentCount,
}: DeploymentHistoryProps) => {
  const total = totalDeploymentCount ?? 0;

  if (!deployments || deployments.length === 0) {
    // count > 0 with no records = history aged out (TTL); distinguish from a
    // never-deployed blueprint so it doesn't look like an empty/broken column.
    if (total > 0) {
      return (
        <Popover
          dismissButton={false}
          position="top"
          size="medium"
          triggerType="text"
          content={HISTORY_RETENTION_NOTE}
        >
          <Box color="text-status-inactive">No recent deployments</Box>
        </Popover>
      );
    }

    return <Box>-</Box>;
  }

  const recentDeployments = deployments.slice(0, 10).reverse();
  // Compare against what's actually rendered so the marker also appears when the
  // 10-item cap hides some, not only when older records aged out.
  const hasUnshownDeployments = total > recentDeployments.length;

  return (
    <SpaceBetween direction="horizontal" size="xxs">
      {recentDeployments.map((deployment) => (
        <DeploymentIndicator
          key={deployment.operationId}
          deployment={deployment}
        />
      ))}
      {hasUnshownDeployments && (
        <Popover
          dismissButton={false}
          position="top"
          size="medium"
          triggerType="text"
          content={HISTORY_RETENTION_NOTE}
        >
          <Box color="text-status-inactive">…</Box>
        </Popover>
      )}
    </SpaceBetween>
  );
};
