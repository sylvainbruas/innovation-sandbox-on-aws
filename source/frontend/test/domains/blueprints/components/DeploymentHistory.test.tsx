// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { DeploymentHistory } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/DeploymentHistory";
import { createDeploymentHistory } from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const getDeploymentIndicators = () =>
  document.querySelectorAll("svg[focusable='false']");

describe("DeploymentHistory", () => {
  test("displays '-' when no deployments provided", () => {
    renderWithQueryClient(<DeploymentHistory deployments={[]} />);

    expect(screen.getByText("-")).toBeInTheDocument();
  });

  test("displays '-' when deployments is undefined", () => {
    renderWithQueryClient(<DeploymentHistory />);

    expect(screen.getByText("-")).toBeInTheDocument();
  });

  test("displays '-' when there are no deployments and no historical count", () => {
    renderWithQueryClient(
      <DeploymentHistory deployments={[]} totalDeploymentCount={0} />,
    );

    expect(screen.getByText("-")).toBeInTheDocument();
    expect(screen.queryByText("No recent deployments")).not.toBeInTheDocument();
  });

  test("indicates aged-out history when deployments exist but no records are retained", () => {
    // count > 0 with no records must not look like a never-deployed blueprint.
    renderWithQueryClient(
      <DeploymentHistory deployments={[]} totalDeploymentCount={3} />,
    );

    expect(screen.getByText("No recent deployments")).toBeInTheDocument();
    expect(screen.queryByText("-")).not.toBeInTheDocument();
    expect(getDeploymentIndicators()).toHaveLength(0);
  });

  test("shows a 'more' marker when retained records are fewer than the total count", () => {
    // 1 retained record, 9 total → row must signal it is not the full history.
    renderWithQueryClient(
      <DeploymentHistory
        deployments={[createDeploymentHistory({ status: "SUCCEEDED" })]}
        totalDeploymentCount={9}
      />,
    );

    expect(getDeploymentIndicators()).toHaveLength(1);
    expect(screen.getByText("…")).toBeInTheDocument();
    expect(screen.queryByText("No recent deployments")).not.toBeInTheDocument();
  });

  test("does not show a 'more' marker when all deployments are shown", () => {
    renderWithQueryClient(
      <DeploymentHistory
        deployments={[
          createDeploymentHistory({ status: "SUCCEEDED", operationId: "op-1" }),
          createDeploymentHistory({ status: "SUCCEEDED", operationId: "op-2" }),
        ]}
        totalDeploymentCount={2}
      />,
    );

    expect(getDeploymentIndicators()).toHaveLength(2);
    expect(screen.queryByText("…")).not.toBeInTheDocument();
  });

  test("shows a 'more' marker when more records exist than the 10-item display cap", () => {
    // 12 retained records, 12 total: only 10 render, so the marker must still show.
    const deployments = Array.from({ length: 12 }, (_, i) =>
      createDeploymentHistory({ status: "SUCCEEDED", operationId: `op-${i}` }),
    );

    renderWithQueryClient(
      <DeploymentHistory deployments={deployments} totalDeploymentCount={12} />,
    );

    expect(getDeploymentIndicators()).toHaveLength(10);
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  test("displays deployment indicators for successful deployments", () => {
    const deployments = [
      createDeploymentHistory({ status: "SUCCEEDED" }),
      createDeploymentHistory({ status: "SUCCEEDED" }),
    ];

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(2);
  });

  test("displays deployment indicators for failed deployments", () => {
    const deployments = [
      createDeploymentHistory({
        status: "FAILED",
        errorMessage: "Deployment timed out",
      }),
    ];

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(1);
  });

  test("displays deployment indicators for running deployments", () => {
    const deployments = [
      createDeploymentHistory({
        status: "RUNNING",
        deploymentCompletedAt: undefined,
        duration: undefined,
      }),
    ];

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(1);
  });

  test("displays mixed deployment statuses", () => {
    const deployments = [
      createDeploymentHistory({ status: "SUCCEEDED" }),
      createDeploymentHistory({ status: "FAILED" }),
      createDeploymentHistory({ status: "RUNNING" }),
    ];

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(3);
  });

  test("limits display to 10 most recent deployments", () => {
    const deployments = Array.from({ length: 15 }, (_, i) =>
      createDeploymentHistory({
        status: "SUCCEEDED",
        operationId: `op-${i}`,
      }),
    );

    renderWithQueryClient(<DeploymentHistory deployments={deployments} />);

    expect(getDeploymentIndicators()).toHaveLength(10);
  });
});
