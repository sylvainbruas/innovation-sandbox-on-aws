// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ColumnLayout, KeyValuePairs } from "@cloudscape-design/components";

import NumberField from "@amzn/innovation-sandbox-frontend/components/FormFields/NumberField";
import RadioGroupField from "@amzn/innovation-sandbox-frontend/components/FormFields/RadioGroupField";
import { SectionForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/SectionForm";
import { SectionData } from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { CONFIG_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";

export function CleanupForm({ data }: { data: SectionData<"cleanup"> }) {
  return (
    <SectionForm
      section="cleanup"
      title="Cleanup"
      anchorId="cleanup-section"
      data={data}
      renderFields={() => (
        <ColumnLayout columns={2}>
          <NumberField
            controllerProps={{ name: "numberOfFailedAttemptsToCancelCleanup" }}
            formFieldProps={{
              label: "Failed attempts before quarantine",
              description:
                "Total failed AWS Nuke attempts before an account fails cleanup and is sent to quarantine.",
              constraintText: "Minimum 1",
            }}
            min={CONFIG_CONSTRAINTS.MIN_CLEANUP_VALUE}
          />
          <NumberField
            controllerProps={{ name: "waitBeforeRetryFailedAttemptSeconds" }}
            formFieldProps={{
              label: "Wait before retry (seconds)",
              description: "Delay between failed AWS Nuke attempts.",
              constraintText: "Minimum 1",
            }}
            min={CONFIG_CONSTRAINTS.MIN_CLEANUP_VALUE}
          />
          <NumberField
            controllerProps={{
              name: "numberOfSuccessfulAttemptsToFinishCleanup",
            }}
            formFieldProps={{
              label: "Successful attempts to finish",
              description:
                "Total successful AWS Nuke attempts before an account finishes cleanup and is returned to available.",
              constraintText: "Minimum 1",
            }}
            min={CONFIG_CONSTRAINTS.MIN_CLEANUP_VALUE}
          />
          <NumberField
            controllerProps={{
              name: "waitBeforeRerunSuccessfulAttemptSeconds",
            }}
            formFieldProps={{
              label: "Wait before rerun (seconds)",
              description: "Delay between successful AWS Nuke attempts.",
              constraintText: "Minimum 1",
            }}
            min={CONFIG_CONSTRAINTS.MIN_CLEANUP_VALUE}
          />
          <NumberField
            controllerProps={{ name: "cooldownPeriodHours" }}
            formFieldProps={{
              label: "Account cooldown (hours)",
              description:
                "Hours an account waits after cleanup before it can be leased again. Set to 0 for no cooldown.",
              constraintText: `0 to ${CONFIG_CONSTRAINTS.MAX_COOLDOWN_PERIOD_HOURS}`,
            }}
            min={CONFIG_CONSTRAINTS.MIN_COOLDOWN_PERIOD_HOURS}
            max={CONFIG_CONSTRAINTS.MAX_COOLDOWN_PERIOD_HOURS}
          />
          <NumberField
            controllerProps={{ name: "reportRetentionDays" }}
            formFieldProps={{
              label: "Cleanup report retention (days)",
              description:
                "Days a cleanup report is retained before it is deleted.",
              constraintText: `${CONFIG_CONSTRAINTS.MIN_REPORT_RETENTION_DAYS} to ${CONFIG_CONSTRAINTS.MAX_REPORT_RETENTION_DAYS}`,
            }}
            min={CONFIG_CONSTRAINTS.MIN_REPORT_RETENTION_DAYS}
            max={CONFIG_CONSTRAINTS.MAX_REPORT_RETENTION_DAYS}
          />
          <RadioGroupField
            controllerProps={{ name: "validation.failureAction" }}
            formFieldProps={{
              label: "On validation failure (experimental)",
              description:
                "What happens when post-cleanup Resource Explorer validation finds remaining resources. " +
                "When selecting Warn or Quarantine, set the account cooldown to at least 168 hours " +
                "(7 days) to allow the Resource Explorer index to reconcile stale resources and avoid false positives.",
            }}
            radioGroupProps={{
              items: [
                {
                  value: "Silent",
                  label: "Silent",
                  description:
                    "Skip the Resource Explorer validation step. Accounts " +
                    "return to available without an additional post-cleanup " +
                    "resource check.",
                },
                {
                  value: "Warn",
                  label: "Warn",
                  description:
                    "Log a warning and surface remaining resources, but return the account to available.",
                },
                {
                  value: "Quarantine",
                  label: "Quarantine",
                  description:
                    "Move the account to quarantine for manual review.",
                },
              ],
            }}
          />
        </ColumnLayout>
      )}
      renderReadOnly={(d) => (
        <KeyValuePairs
          columns={2}
          items={[
            {
              label: "Failed attempts before quarantine",
              value: String(d.numberOfFailedAttemptsToCancelCleanup),
            },
            {
              label: "Wait before retry (seconds)",
              value: String(d.waitBeforeRetryFailedAttemptSeconds),
            },
            {
              label: "Successful attempts to finish",
              value: String(d.numberOfSuccessfulAttemptsToFinishCleanup),
            },
            {
              label: "Wait before rerun (seconds)",
              value: String(d.waitBeforeRerunSuccessfulAttemptSeconds),
            },
            {
              label: "Account cooldown (hours)",
              value: String(d.cooldownPeriodHours),
            },
            {
              label: "Cleanup report retention (days)",
              value: String(d.reportRetentionDays),
            },
            {
              label: "On validation failure",
              value: d.validation.failureAction,
            },
          ]}
        />
      )}
    />
  );
}
