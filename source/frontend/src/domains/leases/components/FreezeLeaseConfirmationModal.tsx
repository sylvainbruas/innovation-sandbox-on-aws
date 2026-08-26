// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Button, SpaceBetween } from "@cloudscape-design/components";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  useFreezeLease,
  useUnfreezeLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";

export type FreezeLeaseAction = "freeze" | "unfreeze";

/**
 * Per-action copy. Freeze and unfreeze are inverse, reversible operations, so
 * this is a lightweight confirmation only — no typed token and no resource
 * identifiers, unlike the destructive terminate flow.
 */
const ACTION_COPY = {
  freeze: {
    prompt:
      "Sandbox account access is suspended and account resources are preserved. You can unfreeze the lease later.",
    submitLabel: "Freeze",
    successMessage: "Lease was successfully frozen.",
    errorMessage: "Lease freeze failed, try again.",
    errorHeader: "Failed to freeze lease",
    logMessage: "Lease freeze failed",
  },
  unfreeze: {
    prompt:
      "Sandbox account access is restored and budget and duration monitoring resumes.",
    submitLabel: "Unfreeze",
    successMessage: "Lease was successfully unfrozen.",
    errorMessage: "Lease unfreeze failed, try again.",
    errorHeader: "Failed to unfreeze lease",
    logMessage: "Lease unfreeze failed",
  },
} as const;

interface FreezeLeaseConfirmationModalProps {
  action: FreezeLeaseAction;
  leaseId: string;
  onClose: () => void;
}

export const FreezeLeaseConfirmationModal = ({
  action,
  leaseId,
  onClose,
}: FreezeLeaseConfirmationModalProps) => {
  const { mutateAsync: freezeLease, isPending: isFreezePending } =
    useFreezeLease();
  const { mutateAsync: unfreezeLease, isPending: isUnfreezePending } =
    useUnfreezeLease();

  const copy = ACTION_COPY[action];
  const mutate = action === "freeze" ? freezeLease : unfreezeLease;
  const isPending = action === "freeze" ? isFreezePending : isUnfreezePending;

  const handleConfirm = async () => {
    try {
      await mutate(leaseId);
      showSuccessToast(copy.successMessage);
      onClose();
    } catch (error) {
      // Surface the underlying error to the browser console so support /
      // operators can distinguish between 403 / 409 / network failures even
      // though the user-facing toast is intentionally fixed.
      console.error(copy.logMessage, error);
      showErrorToast(copy.errorMessage, copy.errorHeader);
    }
  };

  return (
    <SpaceBetween size="m">
      <Box variant="p">{copy.prompt}</Box>
      <Box float="right">
        <SpaceBetween size="xs" direction="horizontal">
          <Button variant="link" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={isPending}
            loading={isPending}
            onClick={handleConfirm}
          >
            {copy.submitLabel}
          </Button>
        </SpaceBetween>
      </Box>
    </SpaceBetween>
  );
};
