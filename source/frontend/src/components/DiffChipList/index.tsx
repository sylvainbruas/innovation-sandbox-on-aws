// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Badge, Box, Link, SpaceBetween } from "@cloudscape-design/components";
import { useState } from "react";

import { sortedCaseInsensitive } from "@amzn/innovation-sandbox-frontend/helpers/sorted-case-insensitive";

/**
 * Show at most this many chips before collapsing the rest behind a "Show N more"
 * toggle, so a large list stays compact (e.g. inside a confirmation modal).
 */
export const DIFF_CHIP_LIMIT = 10;

/**
 * One side (e.g. added or removed) of a before/after change confirmation.
 * Renders the string items as non-interactive, color-coded Badge chips, sorted
 * alphabetically (case-insensitive), capped at DIFF_CHIP_LIMIT with a
 * "Show N more" toggle so a large change does not blow out the surrounding
 * layout. `consequence` states what the change means (per Cloudscape's guidance
 * to explain the effect of a change, not just list items); the singular/plural
 * form is chosen from the item count so callers don't repeat the rule. Renders
 * nothing when empty. Badge (not a TokenGroup) is used deliberately: a read-only
 * TokenGroup still renders a non-functional dismiss "×" on every token, which
 * reads as actionable; Badge is genuinely non-interactive.
 */
export function DiffChipList({
  heading,
  consequence,
  color,
  testId,
  items,
}: Readonly<{
  heading: string;
  consequence: { singular: string; plural: string };
  color: "green" | "red";
  testId: string;
  items: string[];
}>) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return null;
  }
  const sorted = sortedCaseInsensitive(items);
  const visible = expanded ? sorted : sorted.slice(0, DIFF_CHIP_LIMIT);
  const hiddenCount = sorted.length - visible.length;

  return (
    <SpaceBetween size="xs">
      <Box variant="strong">
        {heading} ({items.length})
      </Box>
      <Box color="text-body-secondary" fontSize="body-s">
        {items.length === 1 ? consequence.singular : consequence.plural}
      </Box>
      <div data-testid={testId}>
        <SpaceBetween direction="horizontal" size="xs">
          {visible.map((item) => (
            <Badge key={item} color={color}>
              {item}
            </Badge>
          ))}
        </SpaceBetween>
      </div>
      {sorted.length > DIFF_CHIP_LIMIT && (
        // A single persistent control whose label toggles, rather than two
        // separate conditional Links — swapping which element is mounted would
        // drop keyboard/SR focus to the body on each toggle.
        <Link variant="secondary" onFollow={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
        </Link>
      )}
    </SpaceBetween>
  );
}
