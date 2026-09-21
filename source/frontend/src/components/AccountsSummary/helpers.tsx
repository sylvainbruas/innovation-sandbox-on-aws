// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PieChartProps } from "@cloudscape-design/components";
import {
  colorChartsPaletteCategorical16,
  colorChartsStatusHigh,
  colorChartsStatusInfo,
  colorChartsStatusLow,
  colorChartsStatusPositive,
} from "@cloudscape-design/design-tokens";

import { SandboxAccountView } from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import { SandboxAccountStatus } from "@amzn/innovation-sandbox-shared/types/sandbox-account";

export type AccountStatusDatum = PieChartProps.Datum & {
  status?: SandboxAccountStatus;
};

export const getColor = (status?: SandboxAccountStatus) => {
  switch (status) {
    case "Available":
      return colorChartsStatusPositive;
    case "Active":
      return colorChartsStatusInfo;
    case "Frozen":
      return colorChartsPaletteCategorical16;
    case "CleanUp":
      return colorChartsStatusLow;
    case "Quarantine":
      return colorChartsStatusHigh;
  }
};

export const convertAccountsToSummary = (accounts: SandboxAccountView[]) => {
  return Object.values(
    accounts.reduce(
      (summary, account) => {
        summary[account.status].value++;
        return summary;
      },
      {
        Available: {
          title: "Available",
          status: "Available",
          value: 0,
          color: getColor("Available"),
        },
        Active: {
          title: "Active",
          status: "Active",
          value: 0,
          color: getColor("Active"),
        },
        Frozen: {
          title: "Frozen",
          status: "Frozen",
          value: 0,
          color: getColor("Frozen"),
        },
        CleanUp: {
          title: "Clean Up",
          status: "CleanUp",
          value: 0,
          color: getColor("CleanUp"),
        },
        Quarantine: {
          title: "Quarantine",
          status: "Quarantine",
          value: 0,
          color: getColor("Quarantine"),
        },
      } as Record<string, AccountStatusDatum>,
    ),
  );
};
