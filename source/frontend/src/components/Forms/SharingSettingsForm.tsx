// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useFormContext, useWatch } from "react-hook-form";

import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { SharingSettingsFormValues } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";

/**
 * Reusable form component for the allowOwnerToShareLease toggle.
 * Used by both the lease template wizard/edit and the lease edit page.
 * Reads form state via useFormContext — must be wrapped in a FormProvider
 * whose schema includes `allowOwnerToShareLease: z.boolean()`.
 */
export function SharingSettingsForm({
  leaseSharingEnabled = false,
}: {
  leaseSharingEnabled?: boolean;
}) {
  const { control } = useFormContext<SharingSettingsFormValues>();

  const allowOwnerToShareLease = useWatch({
    control,
    name: "allowOwnerToShareLease",
  });

  return (
    <ToggleField
      controllerProps={{ control, name: "allowOwnerToShareLease" }}
      formFieldProps={{
        label: "Allow owner to share lease",
        description: leaseSharingEnabled
          ? "When enabled, the lease owner can share sandbox access with additional users and groups"
          : "Lease sharing is globally disabled. Enable it in the global configuration to allow owners to share leases.",
      }}
      toggleProps={{
        disabled: !leaseSharingEnabled,
        children: allowOwnerToShareLease
          ? "Sharing enabled"
          : "Sharing disabled",
      }}
    />
  );
}
