// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Container,
  FormField,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useFormContext } from "react-hook-form";

import { PrincipalTypeahead } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead";

// Form-state shape this component touches. Both AssignLeaseFormValues and
// any other parent schema with these fields satisfy it. userDisplayName is
// persisted alongside userEmail so the "Selected: …" indicator survives
// wizard back/forward navigation.
type UserSelectionFormShape = {
  userEmail: string;
  userDisplayName?: string;
};

export type UserSelectionFormProps = {
  enablePrincipalSearch?: boolean;
};

export const UserSelectionForm = ({
  enablePrincipalSearch = true,
}: UserSelectionFormProps = {}) => {
  const { setValue, watch } = useFormContext<UserSelectionFormShape>();

  const userDisplayName = watch("userDisplayName");
  const userEmail = watch("userEmail");

  return (
    <Container>
      <SpaceBetween direction="vertical" size="m">
        <FormField
          label="User"
          description="Search by name or email, or type an email and click Add to resolve."
        >
          <PrincipalTypeahead
            type="users"
            placeholder="Search or enter user email"
            ariaLabel="Search users"
            enablePrincipalSearch={enablePrincipalSearch}
            onSelect={(p) => {
              if (!p.email) return;
              setValue("userEmail", p.email, {
                shouldValidate: true,
                shouldDirty: true,
              });
              setValue("userDisplayName", p.displayName, {
                shouldDirty: true,
              });
            }}
          />
        </FormField>
        {userDisplayName && (
          <Box variant="small">
            Selected: <strong>{userDisplayName}</strong>
            {userEmail ? ` (${userEmail})` : ""}
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
};
