// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime } from "luxon";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { RequestLease } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/RequestLease";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  adminConfigGetHandler,
  createAdminConfig,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import {
  mockAdvancedLeaseTemplate,
  mockBasicLeaseTemplate,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  ApiPaginatedResult,
  ApiResponse,
} from "@amzn/innovation-sandbox-frontend/types";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockShowErrorToast = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", async () => {
  const actual = await vi.importActual(
    "@amzn/innovation-sandbox-frontend/components/Toast",
  );
  return {
    ...actual,
    showErrorToast: (...args: unknown[]) => mockShowErrorToast(...args),
  };
});

const TERMS_CONTENT = "Please follow these sandbox rules.";

// Build a section-based config carrying known terms-of-service content, so the
// terms step renders real content rather than the "not configured" fallback.
const configWithTerms = (content: string) => {
  const config = createAdminConfig();
  return {
    ...config,
    termsOfService: { ...config.termsOfService, content },
  };
};

describe("RequestLease", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <RequestLease />
      </Router>,
    );

  beforeEach(() => {
    server.use(adminConfigGetHandler(configWithTerms(TERMS_CONTENT)));
  });

  test("renders the request lease form with correct title", async () => {
    renderComponent();
    expect(await screen.findByText("Request lease")).toBeInTheDocument();
  });

  test("correctly renders the wizard", async () => {
    renderComponent();
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(1, "active")).not.toBeNull();
      expect(wizard?.findMenuNavigationLink(2, "active")).toBeNull();
      expect(wizard?.findMenuNavigationLink(3, "active")).toBeNull();
    });
  });

  test("displays the lease templates", async () => {
    renderComponent();
    await waitFor(() => {
      const cards = createWrapper().findCards();
      expect(cards?.findItems()).toHaveLength(2);

      const cardHeaders = cards
        ?.findItems()
        .map((item) => item.findCardHeader()?.getElement().textContent);
      expect(cardHeaders).toContain(mockBasicLeaseTemplate.name);
      expect(cardHeaders).toContain(mockAdvancedLeaseTemplate.name);
    });
  });

  test("submits the form successfully and navigates", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${getConfig().ApiUrl}/leases`, async ({ request }) => {
        const body = (await request.json()) as {
          userEmail: string;
          originalLeaseTemplateUuid: string;
        };
        return HttpResponse.json({
          status: "success",
          data: {
            uuid: "new-lease-uuid",
            userEmail: body.userEmail,
            status: "Active",
            awsAccountId: "123456789012",
          },
        });
      }),
    );
    renderComponent();

    // Select a lease template
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);

    // Navigate to Terms of Service
    const nextButton = await screen.findByRole("button", { name: /next/i });
    await user.click(nextButton);

    // Accept Terms of Service
    const termsCheckbox = await screen.findByLabelText(
      "I accept the above terms of service.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Submit the form
    const submitButtons = await screen.findAllByRole("button", {
      name: /submit/i,
    });
    const submitButton = submitButtons[submitButtons.length - 1];
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
  });

  test("shows the configured terms of service content", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Select a lease template, then advance to the terms step.
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    await user.click(screen.getByText(mockBasicLeaseTemplate.name));
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // The configured terms content renders (not the "not configured" fallback).
    expect(await screen.findByText(TERMS_CONTENT)).toBeInTheDocument();
    expect(
      screen.queryByText(/terms of service have not been configured yet/i),
    ).not.toBeInTheDocument();
  });

  test("shows the not-configured warning when terms of service is empty", async () => {
    const user = userEvent.setup();
    // Fresh-install path: no terms saved yet, so content is empty.
    server.use(adminConfigGetHandler(configWithTerms("")));
    renderComponent();

    // Select a lease template, then advance to the terms step.
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    await user.click(screen.getByText(mockBasicLeaseTemplate.name));
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // The empty-content fallback warning renders instead of terms text.
    expect(
      await screen.findByText(/terms of service have not been configured yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(TERMS_CONTENT)).not.toBeInTheDocument();
  });

  test("handles form submission error", async () => {
    vi.clearAllMocks();
    const user = userEvent.setup();

    server.use(
      http.post(`${getConfig().ApiUrl}/leases`, () => {
        return HttpResponse.json(
          { status: "error", message: "API Error" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    // Select a lease template
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);

    // Navigate to Terms of Service
    const nextButton = await screen.findByRole("button", { name: /next/i });
    await user.click(nextButton);

    // Accept Terms of Service
    const termsCheckbox = await screen.findByLabelText(
      "I accept the above terms of service.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Submit the form
    const submitButtons = await screen.findAllByRole("button", {
      name: /submit/i,
    });
    const submitButton = submitButtons[submitButtons.length - 1];
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  // Walks the wizard from template selection through to clicking Submit.
  const stepThroughAndSubmit = async (
    user: ReturnType<typeof userEvent.setup>,
  ) => {
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    await user.click(screen.getByText(mockBasicLeaseTemplate.name));

    await user.click(await screen.findByRole("button", { name: /next/i }));

    const termsCheckbox = await screen.findByLabelText(
      "I accept the above terms of service.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const submitButtons = await screen.findAllByRole("button", {
      name: /submit/i,
    });
    await user.click(submitButtons[submitButtons.length - 1]);
  };

  test("shows retry-time message on 429 with retryAt", async () => {
    vi.clearAllMocks();
    const user = userEvent.setup();
    const retryAt = "2026-06-09T14:32:00.000Z";

    server.use(
      http.post(`${getConfig().ApiUrl}/leases`, () =>
        HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [{ message: "Rate limit exceeded" }],
              retryAt,
            },
          },
          { status: 429 },
        ),
      ),
    );

    renderComponent();
    await stepThroughAndSubmit(user);

    const expectedRetryTime = DateTime.fromISO(retryAt).toLocaleString(
      DateTime.DATETIME_SHORT,
    );
    await waitFor(() => {
      expect(mockShowErrorToast).toHaveBeenCalledWith(
        `You've reached the lease request limit. You can request another lease after ${expectedRetryTime}.`,
      );
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test("falls back to generic limit message on rate-limit 429 with a malformed retryAt", async () => {
    vi.clearAllMocks();
    const user = userEvent.setup();

    server.use(
      http.post(`${getConfig().ApiUrl}/leases`, () =>
        HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [{ message: "Rate limit exceeded" }],
              retryAt: "not-a-real-timestamp",
            },
          },
          { status: 429 },
        ),
      ),
    );

    renderComponent();
    await stepThroughAndSubmit(user);

    // A truthy-but-unparseable retryAt must not render "Invalid DateTime".
    await waitFor(() => {
      expect(mockShowErrorToast).toHaveBeenCalledWith(
        "You've reached the lease request limit. Try again later.",
      );
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test("shows the server message on a 429 throttle that has no retryAt", async () => {
    vi.clearAllMocks();
    const user = userEvent.setup();

    server.use(
      http.post(`${getConfig().ApiUrl}/leases`, () =>
        HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [
                { message: "Too many requests. Please try again later." },
              ],
            },
          },
          { status: 429 },
        ),
      ),
    );

    renderComponent();
    await stepThroughAndSubmit(user);

    await waitFor(() => {
      expect(mockShowErrorToast).toHaveBeenCalledWith(
        "Too many requests. Please try again later.",
      );
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test("displays error when no lease templates are available", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
        const response: ApiResponse<ApiPaginatedResult<LeaseTemplate>> = {
          status: "success",
          data: {
            result: [],
            nextPageIdentifier: null,
          },
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("No lease templates configured."),
      ).toBeInTheDocument();
    });
  });

  test("shows Share access step when leaseSharingEnabled and allowOwnerToShareLease are both true", async () => {
    const user = userEvent.setup();

    // Override config to enable sharing
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            leases: {
              leaseSharingEnabled: true,
              enablePrincipalSearch: true,
            },
          },
        }),
      ),
    );

    // Override templates list with one that has allowOwnerToShareLease: true
    const sharingTemplate: LeaseTemplate = {
      ...mockBasicLeaseTemplate,
      allowOwnerToShareLease: true,
    };
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            result: [sharingTemplate],
            nextPageIdentifier: null,
          },
        }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/:id`, () =>
        HttpResponse.json({
          status: "success",
          data: sharingTemplate,
        }),
      ),
    );

    renderComponent();

    // Step 1: select the template
    await waitFor(() => {
      expect(screen.getByText(sharingTemplate.name)).toBeInTheDocument();
    });
    await user.click(screen.getByText(sharingTemplate.name));
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Step 2 should be "Share access"
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(2, "active")).not.toBeNull();
      expect(
        wizard?.findMenuNavigationLink(2)?.getElement().textContent,
      ).toContain("Share access");
    });
  });

  test("hides Share access step when allowOwnerToShareLease is false", async () => {
    const user = userEvent.setup();

    // Template explicitly without sharing
    const nonSharingTemplate: LeaseTemplate = {
      ...mockBasicLeaseTemplate,
      allowOwnerToShareLease: false,
    };

    // Enable sharing globally but not on the template
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            leases: {
              leaseSharingEnabled: true,
              enablePrincipalSearch: true,
            },
          },
        }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            result: [nonSharingTemplate],
            nextPageIdentifier: null,
          },
        }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/:id`, () =>
        HttpResponse.json({
          status: "success",
          data: nonSharingTemplate,
        }),
      ),
    );

    renderComponent();

    // Step 1: select the template
    await waitFor(() => {
      expect(screen.getByText(nonSharingTemplate.name)).toBeInTheDocument();
    });
    await user.click(screen.getByText(nonSharingTemplate.name));
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Step 2 should be "Terms of Service" (no Share access step)
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(2, "active")).not.toBeNull();
      expect(
        wizard?.findMenuNavigationLink(2)?.getElement().textContent,
      ).toContain("Terms of Service");
    });
  });
});
