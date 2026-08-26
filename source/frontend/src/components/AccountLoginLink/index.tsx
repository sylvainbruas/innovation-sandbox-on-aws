// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, ButtonProps } from "@cloudscape-design/components";

import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";

interface AccountLoginLinkProps {
  variant?: ButtonProps.Variant;
  accountId: string;
}

export const AccountLoginLink = ({
  variant = "inline-link",
  accountId,
}: AccountLoginLinkProps) => {
  const onClick = () => {
    const baseUrl = getConfig().AwsAccessPortalUrl;

    if (!baseUrl) {
      return showErrorToast(
        "AWS Access Portal URL is not configured. Please contact your administrator.",
      );
    }

    if (!baseUrl.startsWith("https://")) {
      return showErrorToast(
        "AWS Access Portal URL is not a valid URL. Please contact your administrator.",
      );
    }

    const url = `${baseUrl}/#/console?account_id=${accountId}`;
    window.open(url, "_blank");
  };

  return (
    <Button onClick={onClick} iconName="external" variant={variant}>
      Login
    </Button>
  );
};
