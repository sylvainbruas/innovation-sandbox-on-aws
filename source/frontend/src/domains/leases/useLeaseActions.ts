// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";

import {
  FreezeLeaseAction,
  FreezeLeaseConfirmationModal,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/FreezeLeaseConfirmationModal";
import { TerminateLeaseConfirmationModal } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TerminateLeaseConfirmationModal";
import {
  canLoginToLease,
  isAssignmentLockActive,
  isCriticalAssignmentLockActive,
  isLeaseOwner,
  isTerminationLockActive,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import {
  isActiveLease,
  isFrozenLease,
  isPendingLease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

export interface LeaseActionsState {
  canLogin: boolean;
  loginAccountId?: string;
  canTerminate: boolean;
  canFreeze: boolean;
  canUnfreeze: boolean;
  hasAnyAction: boolean;
  terminateDisabledReason?: string;
  freezeDisabledReason?: string;
  unfreezeDisabledReason?: string;
  openTerminateModal: () => void;
  openFreezeModal: () => void;
  openUnfreezeModal: () => void;
}

const FREEZE_BLOCKED_REASON =
  "A freeze or termination is already in progress for this lease. Wait for it to finish before trying again.";

const TERMINATE_BLOCKED_REASON =
  "A termination is already in progress for this lease.";

const UNFREEZE_BLOCKED_REASON =
  "Assignment processing is in progress for this lease. Wait for it to finish before unfreezing.";

export interface LeaseActionsOptions {
  /**
   * Opts in to the Admin/Manager-only freeze/unfreeze controls. Off by default
   * so surfaces that show a user their own lease (the home LeasePanel card)
   * keep their existing action set.
   */
  includeElevatedActions?: boolean;
}

/**
 * Derives the lease actions that depend on user identity, configuration, and
 * the modal: whether the current user can terminate/freeze/unfreeze, and the
 * openers for each confirmation. `hasAnyAction` also folds in the status-only
 * actions (login when permitted by role and lifecycle, pending indicator for
 * pending leases) so callers can gate a Cloudscape Header `actions` prop in
 * one check.
 *
 * Tolerates an undefined lease so callers can run the hook before the lease has
 * loaded (Rules of Hooks require it run unconditionally, ahead of any
 * loading/error early return).
 */
export const useLeaseActions = (
  lease: LeaseView | undefined,
  options?: LeaseActionsOptions,
): LeaseActionsState => {
  const { user, isAdmin, isManager } = useUser();
  const { data: configurations } = useGetConfigurations();
  const { showModal, hideModal } = useModal();

  // Freeze/unfreeze/terminate are operator controls; the API authorizes
  // Admin/Manager only, matching the bulk actions on the leases list.
  const isElevated = Boolean(
    options?.includeElevatedActions && (isAdmin || isManager),
  );

  // Which intents block which action is documented on the predicates in
  // leases/helpers.ts. The API rejects a blocked attempt with 409, so gating
  // here only avoids offering an action that is bound to fail.
  const lockActive = !!lease && isAssignmentLockActive(lease);
  const criticalLockActive = !!lease && isCriticalAssignmentLockActive(lease);
  const terminationLockActive = !!lease && isTerminationLockActive(lease);

  const loginAccountId =
    lease && canLoginToLease(lease, { isAdmin, isManager })
      ? lease.awsAccountId
      : undefined;
  const canLogin = loginAccountId !== undefined;
  const canFreeze = isElevated && !!lease && isActiveLease(lease);
  const canUnfreeze = isElevated && !!lease && isFrozenLease(lease);

  const freezeDisabledReason = criticalLockActive
    ? FREEZE_BLOCKED_REASON
    : undefined;
  const unfreezeDisabledReason = lockActive
    ? UNFREEZE_BLOCKED_REASON
    : undefined;
  const terminateDisabledReason = terminationLockActive
    ? TERMINATE_BLOCKED_REASON
    : undefined;

  const canTerminateAsOwner =
    !!lease &&
    isActiveLease(lease) &&
    isLeaseOwner(lease, user) &&
    configurations?.leases?.allowUserLeaseTermination === true;

  const canTerminateAsOperator =
    isElevated && !!lease && (isActiveLease(lease) || isFrozenLease(lease));

  const canTerminate = canTerminateAsOwner || canTerminateAsOperator;

  const openTerminateModal = () => {
    if (!lease || !canTerminate || terminateDisabledReason) {
      return;
    }
    // Narrows to MonitoredLease so awsAccountId is available below.
    if (!isActiveLease(lease) && !isFrozenLease(lease)) {
      return;
    }
    showModal({
      header: "Terminate Lease",
      content: createElement(TerminateLeaseConfirmationModal, {
        leaseId: lease.leaseId,
        uuid: lease.uuid,
        accountId: lease.awsAccountId,
        onClose: hideModal,
      }),
      size: "medium",
    });
  };

  const openFreezeConfirmation = (action: FreezeLeaseAction) => {
    if (!lease) {
      return;
    }
    showModal({
      header: action === "freeze" ? "Freeze lease?" : "Unfreeze lease?",
      content: createElement(FreezeLeaseConfirmationModal, {
        action,
        leaseId: lease.leaseId,
        onClose: hideModal,
      }),
      size: "medium",
    });
  };

  const openFreezeModal = () => {
    if (!canFreeze || freezeDisabledReason) {
      return;
    }
    openFreezeConfirmation("freeze");
  };

  const openUnfreezeModal = () => {
    if (!canUnfreeze || unfreezeDisabledReason) {
      return;
    }
    openFreezeConfirmation("unfreeze");
  };

  const hasAnyAction =
    canLogin ||
    (!!lease && isPendingLease(lease)) ||
    canTerminate ||
    canFreeze ||
    canUnfreeze;

  return {
    canLogin,
    loginAccountId,
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
  };
};
