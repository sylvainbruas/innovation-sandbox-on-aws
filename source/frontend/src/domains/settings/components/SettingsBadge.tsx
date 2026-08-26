// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@cloudscape-design/components";

import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { ConfigSection } from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { ConfigSchemas } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";

/** The six real config section keys (excludes deploy-time fields). */
const SECTION_KEYS = Object.keys(ConfigSchemas) as ConfigSection[];

/**
 * Side-navigation attention indicator for the Settings item. Shows the count of
 * configuration sections that have never been saved (`lastSavedBy === null`),
 * matching the finish-setup alerts on the Admin Settings page. Renders nothing
 * when every section has been saved (or while the config is still loading), so
 * the nav item carries no badge in the steady state.
 */
export const SettingsBadge = () => {
  const { data: config } = useGetConfigurations();

  if (!config) {
    return null;
  }

  const needsAttention = SECTION_KEYS.filter(
    (section) => config[section].lastSavedBy === null,
  ).length;

  if (needsAttention === 0) {
    return null;
  }

  return <Badge color="red">{needsAttention}</Badge>;
};
