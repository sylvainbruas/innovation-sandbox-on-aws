// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditDurationSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditDurationSettings";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { mockAdvancedLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockUuid = mockAdvancedLeaseTemplate.uuid;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ uuid: mockUuid }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

describe("EditDurationSettings", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditDurationSettings />
      </Router>,
    );

  test("renders form with existing duration settings", async () => {
    renderComponent();

    await waitFor(() => {
      const durationInput = screen.getByLabelText("Maximum Duration (Hours)");
      expect(durationInput).toBeInTheDocument();
      // Just verify the field exists and has some value
      if (mockAdvancedLeaseTemplate.leaseDurationInHours) {
        expect(durationInput).toHaveValue(
          mockAdvancedLeaseTemplate.leaseDurationInHours,
        );
      }
    });
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
  });

  test("submits form successfully", async () => {
    const submitSpy = vi.fn();
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          const data = await request.json();
          submitSpy(data);
          return HttpResponse.json({ status: "success", data });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const durationInput = screen.getByLabelText("Maximum Duration (Hours)");
    await user.tripleClick(durationInput);
    await user.keyboard("240");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Duration settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
    });
  });

  test("displays error toast on submission failure", async () => {
    server.use(
      http.put(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Update failed" },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const durationInput = screen.getByLabelText("Maximum Duration (Hours)");
    await user.tripleClick(durationInput);
    await user.keyboard("240");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update duration settings"),
        "Update Failed",
      );
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
  });

  test("assigns a duration when required and none was previously set", async () => {
    // Regression: with a required duration and none set, the enable toggle is
    // forced-on-but-disabled, so maxDurationEnabled stays false. Entering a
    // value must still submit it (not undefined).
    const configRequired = createConfiguration({
      leases: {
        maxDurationHours: 8760,
        requireMaxDuration: true,
      },
    });

    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: configRequired }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            leaseDurationInHours: undefined,
            durationThresholds: undefined,
          },
        }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const durationInput = screen.getByLabelText("Maximum Duration (Hours)");
    await user.tripleClick(durationInput);
    await user.keyboard("240");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData?.leaseDurationInHours).toBe(240));
  });
});
