// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@cloudscape-design/components";

import { SharedLeaseAccessType } from "@amzn/innovation-sandbox-frontend/domains/leases/types";

interface AccessTypeBadgeProps {
  accessType: SharedLeaseAccessType;
}

/**
 * Renders a colored badge indicating the user's access type for a lease.
 */
export const AccessTypeBadge = ({ accessType }: AccessTypeBadgeProps) => {
  switch (accessType) {
    case "owner":
      return <Badge color="blue">Owner</Badge>;
    case "direct":
      return <Badge color="green">Direct</Badge>;
    case "group":
      return <Badge color="green">Group</Badge>;
    case "global":
      return <Badge color="grey">Global</Badge>;
  }
};
