// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  KeyValuePairs,
  SpaceBetween,
} from "@cloudscape-design/components";

import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { BooleanStatus } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/BooleanStatus";
import { SectionForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/SectionForm";
import { SectionData } from "@amzn/innovation-sandbox-frontend/domains/settings/service";

export function MaintenanceForm({
  data,
}: {
  data: SectionData<"maintenance">;
}) {
  // A never-saved section (lastSavedBy === null) is a fresh install. The schema
  // default is enabled: true (fail-closed), so the app starts in maintenance —
  // managers and users are locked out until an admin saves this section OFF.
  // Surface that explicitly; the generic "using default values" alert does not
  // convey the lockout implication.
  const isFreshInstall = data.lastSavedBy === null;

  return (
    <SectionForm
      section="maintenance"
      title="Maintenance Mode"
      anchorId="maintenance"
      data={data}
      // This section renders its own fail-closed lockout warning below, so
      // suppress SectionForm's generic "Using default values" alert to avoid
      // two stacked finish-setup alerts on a fresh install.
      suppressDefaultsAlert
      // Toggling maintenance mode is a sensitive operation (it locks managers
      // and users out, or lets them back in), so confirm before saving when
      // the toggle actually changed.
      confirmBeforeSave={(values, baseline) =>
        values.enabled !== baseline.enabled
          ? {
              header: values.enabled
                ? "Turn on maintenance mode?"
                : "Turn off maintenance mode?",
              message: values.enabled
                ? "Managers and sandbox users will lose access to the Innovation Sandbox application until maintenance mode is turned off. Their existing sandbox accounts stay available for the duration of their leases."
                : "Managers and sandbox users will regain access to the Innovation Sandbox application.",
              confirmLabel: values.enabled
                ? "Turn on maintenance mode"
                : "Turn off maintenance mode",
            }
          : null
      }
      renderFields={() => (
        <SpaceBetween size="l">
          {isFreshInstall && (
            <Alert type="warning" header="Maintenance mode is on by default">
              New deployments start with maintenance mode ON, so managers and
              sandbox users cannot access the Innovation Sandbox application
              (their existing sandbox accounts are unaffected). Save this
              section with the toggle OFF to give them access.
            </Alert>
          )}
          <ToggleField
            controllerProps={{ name: "enabled" }}
            formFieldProps={{
              label: "Maintenance mode",
              description:
                "When enabled, managers and sandbox users lose access to the Innovation Sandbox application (existing sandbox accounts are unaffected). Admins retain full access.",
            }}
            stateLabel
          />
        </SpaceBetween>
      )}
      renderReadOnly={(d) => (
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "Maintenance mode",
              value: <BooleanStatus value={d.enabled} />,
            },
          ]}
        />
      )}
    />
  );
}
