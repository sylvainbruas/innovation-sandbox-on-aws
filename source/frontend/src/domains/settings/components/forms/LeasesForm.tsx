// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ColumnLayout, KeyValuePairs } from "@cloudscape-design/components";

import NumberField from "@amzn/innovation-sandbox-frontend/components/FormFields/NumberField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { BooleanStatus } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/BooleanStatus";
import { SectionForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/SectionForm";
import { SectionData } from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { CONFIG_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";

export function LeasesForm({ data }: { data: SectionData<"leases"> }) {
  return (
    <SectionForm
      section="leases"
      title="Lease Policies"
      anchorId="lease-policies"
      data={data}
      renderFields={() => (
        <ColumnLayout columns={2}>
          <ToggleField
            controllerProps={{ name: "requireMaxBudget" }}
            formFieldProps={{
              label: "Require max budget",
              description:
                "Require lease templates to define a maximum budget.",
            }}
            stateLabel
          />
          <NumberField
            controllerProps={{ name: "maxBudget" }}
            formFieldProps={{
              label: "Max budget",
              description: "Maximum budget (USD) for lease templates.",
              constraintText: `0 to ${CONFIG_CONSTRAINTS.MAX_BUDGET.toLocaleString()}`,
            }}
            min={0}
            max={CONFIG_CONSTRAINTS.MAX_BUDGET}
          />
          <ToggleField
            controllerProps={{ name: "requireMaxDuration" }}
            formFieldProps={{
              label: "Require max duration",
              description:
                "Require lease templates to define a maximum duration.",
            }}
            stateLabel
          />
          <NumberField
            controllerProps={{ name: "maxDurationHours" }}
            formFieldProps={{
              label: "Max lease duration",
              description: "Maximum duration (hours) for lease templates.",
              constraintText: `0 to ${CONFIG_CONSTRAINTS.MAX_DURATION_HOURS.toLocaleString()}`,
            }}
            min={0}
            max={CONFIG_CONSTRAINTS.MAX_DURATION_HOURS}
          />
          <NumberField
            controllerProps={{ name: "maxLeasesPerUser" }}
            formFieldProps={{
              label: "Max leases per user",
              description:
                "Maximum concurrent active leases (and lease requests) a single user can have.",
              constraintText: "Minimum 1",
            }}
            min={CONFIG_CONSTRAINTS.MIN_LEASES_PER_USER}
          />
          <NumberField
            controllerProps={{ name: "ttl" }}
            formFieldProps={{
              label: "Lease record TTL",
              description:
                "Days an expired lease record is retained before it is permanently deleted (deletion may take up to 48 hours).",
              constraintText: "Minimum 1",
            }}
            min={CONFIG_CONSTRAINTS.MIN_TTL_DAYS}
          />
          <ToggleField
            controllerProps={{ name: "allowUserLeaseTermination" }}
            formFieldProps={{
              label: "Allow user lease termination",
              description:
                "When enabled, users can terminate their own active leases. When disabled, only admins and managers can.",
            }}
            stateLabel
          />
          <NumberField
            controllerProps={{ name: "leaseRequestWindowHours" }}
            formFieldProps={{
              label: "Rate limit window",
              description:
                "Rolling window (hours) used to rate-limit lease requests. Capped at runtime by the lease record TTL.",
              constraintText:
                "Must not exceed the lease record TTL converted to hours (days × 24)",
            }}
            min={CONFIG_CONSTRAINTS.MIN_LEASE_REQUEST_WINDOW_HOURS}
          />
          <NumberField
            controllerProps={{ name: "maxLeaseRequestsPerWindow" }}
            formFieldProps={{
              label: "Max requests per window",
              description:
                "Maximum lease requests a user can make within the rate limit window before further requests are rejected.",
              constraintText: "Minimum 1",
            }}
            min={CONFIG_CONSTRAINTS.MIN_LEASE_REQUESTS_PER_WINDOW}
          />
          <ToggleField
            controllerProps={{ name: "leaseSharingEnabled" }}
            formFieldProps={{
              label: "Enable lease sharing",
              description:
                "When enabled, lease owners can manage assignments on leases that permit sharing. Admins and managers always retain access.",
            }}
            stateLabel
          />
          <ToggleField
            controllerProps={{ name: "enablePrincipalSearch" }}
            formFieldProps={{
              label: "Enable principal search",
              description:
                "When enabled, the user typeahead search is available. When disabled, it is unavailable to all roles.",
            }}
            stateLabel
          />
        </ColumnLayout>
      )}
      renderReadOnly={(d) => (
        <KeyValuePairs
          columns={2}
          items={[
            {
              label: "Require max budget",
              value: <BooleanStatus value={d.requireMaxBudget} />,
            },
            { label: "Max budget", value: `$${d.maxBudget} USD` },
            {
              label: "Require max duration",
              value: <BooleanStatus value={d.requireMaxDuration} />,
            },
            {
              label: "Max lease duration",
              value: `${d.maxDurationHours} hours`,
            },
            { label: "Max leases per user", value: String(d.maxLeasesPerUser) },
            { label: "Lease record TTL", value: `${d.ttl} days` },
            {
              label: "Allow user lease termination",
              value: <BooleanStatus value={d.allowUserLeaseTermination} />,
            },
            {
              label: "Rate limit window",
              value: `${d.leaseRequestWindowHours} hours`,
            },
            {
              label: "Max requests per window",
              value: String(d.maxLeaseRequestsPerWindow),
            },
            {
              label: "Enable lease sharing",
              value: <BooleanStatus value={d.leaseSharingEnabled} />,
            },
            {
              label: "Enable principal search",
              value: <BooleanStatus value={d.enablePrincipalSearch} />,
            },
          ]}
        />
      )}
    />
  );
}
