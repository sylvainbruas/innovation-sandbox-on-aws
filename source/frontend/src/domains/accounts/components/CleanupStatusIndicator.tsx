// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ActiveCleanup } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account";
import { StatusIndicator } from "@cloudscape-design/components";

import { getCleanupStatusConfig } from "@amzn/innovation-sandbox-frontend/domains/accounts/helpers";

interface CleanupStatusIndicatorProps {
  activeCleanup?: ActiveCleanup;
}

export const CleanupStatusIndicator = ({
  activeCleanup,
}: CleanupStatusIndicatorProps) => {
  if (!activeCleanup) {
    return null;
  }

  const config = getCleanupStatusConfig(activeCleanup.status);

  return <StatusIndicator type={config.type}>{config.label}</StatusIndicator>;
};
