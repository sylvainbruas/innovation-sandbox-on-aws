// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  CopyToClipboard,
  FormField,
  Input,
  KeyValuePairs,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useState } from "react";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useTerminateLease } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";

const CONFIRM_TOKEN = "terminate";

interface TerminateLeaseConfirmationModalProps {
  leaseId: string;
  uuid: string;
  accountId: string;
  onClose: () => void;
}

export const TerminateLeaseConfirmationModal = ({
  leaseId,
  uuid,
  accountId,
  onClose,
}: TerminateLeaseConfirmationModalProps) => {
  const [confirmationText, setConfirmationText] = useState("");
  const { mutateAsync: terminateLease, isPending } = useTerminateLease();

  const isConfirmed = confirmationText.trim().toLowerCase() === CONFIRM_TOKEN;

  const handleConfirm = async () => {
    try {
      await terminateLease(leaseId);
      showSuccessToast("Lease was successfully terminated.");
      onClose();
    } catch (error) {
      // Surface the underlying error to the browser console so support /
      // operators can distinguish between 429 / 403 / 409 / network failures
      // even though the user-facing toast is intentionally fixed per spec.
      console.error("Lease termination failed", error);
      showErrorToast(
        "Lease termination failed, try again.",
        "Failed to terminate lease",
      );
    }
  };

  return (
    <SpaceBetween size="m">
      <Alert
        type="warning"
        header="Are you sure you want to terminate this lease?"
      >
        This will immediately:
        <ul>
          <li>Revoke access to the sandbox account</li>
          <li>Trigger the account cleanup process</li>
        </ul>
        This action cannot be undone.
      </Alert>
      <KeyValuePairs
        columns={2}
        items={[
          {
            label: "AWS Account ID",
            value: (
              <CopyToClipboard
                variant="inline"
                textToCopy={accountId}
                copySuccessText="Copied AWS Account ID"
                copyErrorText="Failed to copy AWS Account ID"
              />
            ),
          },
          {
            label: "Lease ID",
            value: (
              <CopyToClipboard
                variant="inline"
                textToCopy={uuid}
                copySuccessText="Copied Lease ID"
                copyErrorText="Failed to copy Lease ID"
              />
            ),
          },
        ]}
      />
      <FormField label={`To confirm, type "${CONFIRM_TOKEN}" below:`}>
        <Input
          value={confirmationText}
          onChange={({ detail }) => setConfirmationText(detail.value)}
          disabled={isPending}
        />
      </FormField>
      <Box float="right">
        <SpaceBetween size="xs" direction="horizontal">
          <Button variant="link" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!isConfirmed || isPending}
            loading={isPending}
            onClick={handleConfirm}
          >
            Terminate Lease
          </Button>
        </SpaceBetween>
      </Box>
    </SpaceBetween>
  );
};
