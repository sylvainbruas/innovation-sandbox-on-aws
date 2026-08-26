// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CopyToClipboard,
  StatusIndicator,
} from "@cloudscape-design/components";

import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

interface AccountIdProps {
  /** The AWS account ID to display, or undefined/null if no account is assigned. */
  accountId: string | undefined | null;
  /** When true, renders an inline copy-to-clipboard button alongside the account ID. */
  copyable?: boolean;
  /** Optional message shown when no account is assigned. Defaults to "No account assigned". */
  emptyText?: string;
}

/**
 * Renders an AWS account ID with role-aware linking (admin gets a link to
 * the account details page) and an optional copy button.
 * Shows a warning indicator when no account is assigned.
 */
export const AccountId = ({
  accountId,
  copyable = false,
  emptyText = "No account assigned",
}: AccountIdProps) => {
  const { isAdmin } = useUser();

  if (!accountId) {
    return <StatusIndicator type="warning">{emptyText}</StatusIndicator>;
  }

  const displayText = isAdmin ? (
    <TextLink to={`/accounts/${accountId}`}>{accountId}</TextLink>
  ) : (
    accountId
  );

  if (copyable) {
    return (
      <CopyToClipboard
        variant="inline"
        textToCopy={accountId}
        textToDisplay={displayText}
        copyButtonAriaLabel={`Copy account ID ${accountId}`}
        copySuccessText="Account ID copied"
        copyErrorText="Failed to copy"
      />
    );
  }

  return displayText;
};
