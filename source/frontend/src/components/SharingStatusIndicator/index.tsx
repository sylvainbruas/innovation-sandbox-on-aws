// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Popover, StatusIndicator } from "@cloudscape-design/components";

/**
 * Shared component for rendering the allowOwnerToShareLease status.
 * Handles three states:
 * - Enabled (feature globally on + per-lease/template on)
 * - Enabled but globally disabled (per-lease on, global off — shows popover with explanation)
 * - Disabled
 */
export function SharingStatusIndicator({
  allowOwnerToShareLease,
  leaseSharingEnabled = true,
}: {
  allowOwnerToShareLease?: boolean;
  leaseSharingEnabled?: boolean;
}) {
  if (leaseSharingEnabled && allowOwnerToShareLease) {
    return <StatusIndicator type="success">Enabled</StatusIndicator>;
  }

  if (allowOwnerToShareLease) {
    return (
      <Popover
        dismissButton={false}
        position="top"
        size="small"
        content="Sharing is enabled on this resource but the feature is globally disabled. Enable it in global configuration for this setting to take effect."
      >
        <StatusIndicator type="stopped">Enabled (overridden)</StatusIndicator>
      </Popover>
    );
  }

  return <StatusIndicator type="stopped">Disabled</StatusIndicator>;
}
