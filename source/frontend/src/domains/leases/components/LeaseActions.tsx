// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Button,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import {
  isActiveLease,
  isPendingLease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { useLeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/useLeaseActions";

interface LeaseActionsProps {
  lease: LeaseWithLeaseId;
  /** Forwarded to useLeaseActions — see LeaseActionsOptions there. */
  includeElevatedActions?: boolean;
}

/**
 * Renders the lease action controls (login link, terminate button,
 * freeze/unfreeze buttons, pending indicator) shared by the home LeasePanel
 * card and the LeaseDetails page.
 *
 * Returns null when the lease has no actions so callers can gate the Cloudscape
 * Header `actions` prop on hasAnyAction and keep the no-actions styling.
 */
export const LeaseActions = ({
  lease,
  includeElevatedActions,
}: LeaseActionsProps) => {
  const {
    canTerminate,
    canFreeze,
    canUnfreeze,
    hasAnyAction,
    terminateDisabledReason,
    freezeDisabledReason,
    unfreezeDisabledReason,
    openTerminateModal,
    openFreezeModal,
    openUnfreezeModal,
  } = useLeaseActions(lease, { includeElevatedActions });

  if (!hasAnyAction) {
    return null;
  }

  // Lock-blocked actions stay visible and disabled so Cloudscape can surface
  // the reason as an accessible tooltip; hiding them would leave the operator
  // guessing why the control vanished.
  return (
    <SpaceBetween size="xs" direction="horizontal">
      {isActiveLease(lease) && (
        <AccountLoginLink accountId={lease.awsAccountId} variant="normal" />
      )}
      {canFreeze && (
        <Button
          onClick={openFreezeModal}
          disabled={!!freezeDisabledReason}
          disabledReason={freezeDisabledReason}
        >
          Freeze lease
        </Button>
      )}
      {canUnfreeze && (
        <Button
          onClick={openUnfreezeModal}
          disabled={!!unfreezeDisabledReason}
          disabledReason={unfreezeDisabledReason}
        >
          Unfreeze lease
        </Button>
      )}
      {canTerminate && (
        <Button
          onClick={openTerminateModal}
          disabled={!!terminateDisabledReason}
          disabledReason={terminateDisabledReason}
        >
          Terminate lease
        </Button>
      )}
      {isPendingLease(lease) && (
        <StatusIndicator type="info">
          Your account is pending approval
        </StatusIndicator>
      )}
    </SpaceBetween>
  );
};
