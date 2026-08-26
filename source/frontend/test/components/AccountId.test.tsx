// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { AccountId } from "@amzn/innovation-sandbox-frontend/components/AccountId";

const mockUseUser = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

describe("AccountId", () => {
  const accountId = "123456789012";

  test("renders as a link for Admin users", () => {
    mockUseUser.mockReturnValue({ isAdmin: true, isManager: false });

    render(
      <BrowserRouter>
        <AccountId accountId={accountId} />
      </BrowserRouter>,
    );

    const link = screen.getByRole("link", { name: accountId });
    expect(link).toHaveAttribute("href", `/accounts/${accountId}`);
  });

  test("renders as plain text for non-admin users", () => {
    mockUseUser.mockReturnValue({ isAdmin: false, isManager: true });

    render(
      <BrowserRouter>
        <AccountId accountId={accountId} />
      </BrowserRouter>,
    );

    expect(screen.getByText(accountId)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("renders warning indicator when accountId is undefined", () => {
    mockUseUser.mockReturnValue({ isAdmin: false, isManager: false });

    render(
      <BrowserRouter>
        <AccountId accountId={undefined} />
      </BrowserRouter>,
    );

    expect(screen.getByText("No account assigned")).toBeInTheDocument();
  });

  test("renders custom empty text when accountId is null", () => {
    mockUseUser.mockReturnValue({ isAdmin: false, isManager: false });

    render(
      <BrowserRouter>
        <AccountId accountId={null} emptyText="Pending assignment" />
      </BrowserRouter>,
    );

    expect(screen.getByText("Pending assignment")).toBeInTheDocument();
  });

  test("renders CopyToClipboard when copyable is true", () => {
    mockUseUser.mockReturnValue({ isAdmin: false, isManager: false });

    render(
      <BrowserRouter>
        <AccountId accountId={accountId} copyable />
      </BrowserRouter>,
    );

    // CopyToClipboard inline variant shows the text and a copy button
    expect(screen.getByText(accountId)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  test("renders admin link inside CopyToClipboard when copyable + admin", () => {
    mockUseUser.mockReturnValue({ isAdmin: true, isManager: false });

    render(
      <BrowserRouter>
        <AccountId accountId={accountId} copyable />
      </BrowserRouter>,
    );

    const link = screen.getByRole("link", { name: accountId });
    expect(link).toHaveAttribute("href", `/accounts/${accountId}`);
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  test("does not render copy button when copyable is false", () => {
    mockUseUser.mockReturnValue({ isAdmin: false, isManager: false });

    render(
      <BrowserRouter>
        <AccountId accountId={accountId} />
      </BrowserRouter>,
    );

    expect(screen.getByText(accountId)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy/i }),
    ).not.toBeInTheDocument();
  });
});
