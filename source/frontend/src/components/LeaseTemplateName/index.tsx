// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

interface LeaseTemplateNameProps {
  name: string;
  uuid: string;
}

/**
 * Renders a lease template name as a link for Admin/Manager users,
 * plain text for regular users.
 */
export const LeaseTemplateName = ({ name, uuid }: LeaseTemplateNameProps) => {
  const { isAdmin, isManager } = useUser();
  if (isAdmin || isManager) {
    return <TextLink to={`/lease_templates/${uuid}`}>{name}</TextLink>;
  }
  return <>{name}</>;
};
