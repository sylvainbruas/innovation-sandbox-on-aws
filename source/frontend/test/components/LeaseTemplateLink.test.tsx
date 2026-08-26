// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { LeaseTemplateName } from "@amzn/innovation-sandbox-frontend/components/LeaseTemplateName";

const mockUseUser = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

describe("LeaseTemplateLink", () => {
  const name = "Basic Template";
  const uuid = "template-uuid-123";

  test("renders as a link for Admin users", () => {
    mockUseUser.mockReturnValue({ isAdmin: true, isManager: false });

    render(
      <BrowserRouter>
        <LeaseTemplateName name={name} uuid={uuid} />
      </BrowserRouter>,
    );

    const link = screen.getByRole("link", { name });
    expect(link).toHaveAttribute("href", `/lease_templates/${uuid}`);
  });

  test("renders as a link for Manager users", () => {
    mockUseUser.mockReturnValue({ isAdmin: false, isManager: true });

    render(
      <BrowserRouter>
        <LeaseTemplateName name={name} uuid={uuid} />
      </BrowserRouter>,
    );

    const link = screen.getByRole("link", { name });
    expect(link).toHaveAttribute("href", `/lease_templates/${uuid}`);
  });

  test("renders as plain text for regular users", () => {
    mockUseUser.mockReturnValue({ isAdmin: false, isManager: false });

    render(
      <BrowserRouter>
        <LeaseTemplateName name={name} uuid={uuid} />
      </BrowserRouter>,
    );

    expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
