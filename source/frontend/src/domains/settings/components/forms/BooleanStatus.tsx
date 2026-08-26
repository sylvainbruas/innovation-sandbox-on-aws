// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { StatusIndicator } from "@cloudscape-design/components";

/**
 * Renders a boolean config value as a human-readable status for the read-only
 * (Manager) views, instead of the raw "true"/"false" string. Uses Cloudscape's
 * StatusIndicator — the app's convention for read-only on/off state (e.g.
 * SharingStatusIndicator) — with a green "Enabled" / grey "Disabled" treatment
 * matching the inline toggle labels shown in the editable view.
 */
export function BooleanStatus({ value }: { value: boolean }) {
  return value ? (
    <StatusIndicator type="success">Enabled</StatusIndicator>
  ) : (
    <StatusIndicator type="stopped">Disabled</StatusIndicator>
  );
}
