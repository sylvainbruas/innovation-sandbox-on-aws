// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Badge,
  Box,
  KeyValuePairs,
  SpaceBetween,
} from "@cloudscape-design/components";

import { DiffChipList } from "@amzn/innovation-sandbox-frontend/components/DiffChipList";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import TokenListField from "@amzn/innovation-sandbox-frontend/components/FormFields/TokenListField";
import { BooleanStatus } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/BooleanStatus";
import { SectionForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/SectionForm";
import { SectionData } from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { CONFIG_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";
import { sortedCaseInsensitive } from "@amzn/innovation-sandbox-frontend/helpers/sorted-case-insensitive";

export function CostReportingForm({
  data,
}: {
  data: SectionData<"costReporting">;
}) {
  return (
    <SectionForm
      section="costReporting"
      title="Cost Reporting"
      anchorId="cost-reporting"
      data={data}
      // Cost report groups feed lease templates, and removing a token clears it
      // from view immediately, so confirm before saving with a before/after
      // diff whenever the group list changed. Compares the submitted list to the
      // saved baseline (order-insensitive — group order is not meaningful); a
      // change to the toggle alone saves without a prompt.
      confirmBeforeSave={(values, baseline) => {
        const current = (values.costReportGroups ?? []) as string[];
        const saved = (baseline.costReportGroups ?? []) as string[];
        const removed = saved.filter((g) => !current.includes(g));
        const added = current.filter((g) => !saved.includes(g));
        if (removed.length === 0 && added.length === 0) {
          return null;
        }
        return {
          header: "Save cost report group changes?",
          confirmLabel: "Save changes",
          message: (
            <SpaceBetween size="l">
              <Box>
                Review the changes to the cost report groups before saving.
              </Box>
              <DiffChipList
                heading="Adding"
                consequence={{
                  singular:
                    "This group will become available for lease templates.",
                  plural:
                    "These groups will become available for lease templates.",
                }}
                color="green"
                testId="diff-added"
                items={added}
              />
              <DiffChipList
                heading="Removing"
                consequence={{
                  singular:
                    "This group will no longer be available for new lease templates.",
                  plural:
                    "These groups will no longer be available for new lease templates.",
                }}
                color="red"
                testId="diff-removed"
                items={removed}
              />
            </SpaceBetween>
          ),
        };
      }}
      renderFields={() => (
        <SpaceBetween size="l">
          <ToggleField
            controllerProps={{ name: "requireCostReportGroup" }}
            formFieldProps={{
              label: "Require cost report group",
              description:
                "When enabled, lease templates must specify a cost report group.",
            }}
            stateLabel
          />
          <TokenListField
            controllerProps={{ name: "costReportGroups" }}
            formFieldProps={{
              label: "Cost report groups",
              description: "Valid cost report groups for lease templates.",
            }}
            inputProps={{
              placeholder: "Enter a cost report group",
            }}
            maxItems={CONFIG_CONSTRAINTS.MAX_COST_REPORT_GROUPS}
            maxItemLength={CONFIG_CONSTRAINTS.MAX_COST_REPORT_GROUP_LENGTH}
            sorted
            itemNoun="groups"
          />
        </SpaceBetween>
      )}
      renderReadOnly={(d) => (
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "Require cost report group",
              value: <BooleanStatus value={d.requireCostReportGroup} />,
            },
            {
              label: "Cost report groups",
              // Render each group as a read-only Badge chip (matching the
              // tokenized editable view) rather than one comma-joined string.
              // Badge (not a no-dismiss TokenGroup) reads as non-interactive,
              // which is correct for a read-only value. Sorted to match the
              // editable field's alphabetical token order.
              value: d.costReportGroups.length ? (
                <SpaceBetween direction="horizontal" size="xs">
                  {sortedCaseInsensitive(d.costReportGroups).map((group) => (
                    <Badge key={group}>{group}</Badge>
                  ))}
                </SpaceBetween>
              ) : (
                "(none)"
              ),
            },
          ]}
        />
      )}
    />
  );
}
