// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OAuthCallback } from "@amzn/innovation-sandbox-frontend/components/OAuthCallback";
import { resetApiSingletons } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Hub.listen mock — capture the listener so tests can fire events.
// Amplify's HubCallback type is not re-exported from aws-amplify/utils.
let hubListener:
  ((data: { payload: { event: string; data?: unknown } }) => void) | null =
  null;

vi.mock("aws-amplify/utils", () => ({
  Hub: {
    listen: vi.fn((_channel: string, callback: typeof hubListener) => {
      hubListener = callback;
      return vi.fn(); // unsubscribe
    }),
  },
}));

vi.mock("@amzn/innovation-sandbox-frontend/helpers/apiSingletons", () => ({
  resetApiSingletons: vi.fn(),
  registerApiSingletonReset: vi.fn(),
}));

describe("OAuthCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hubListener = null;
    vi.useFakeTimers();
  });

  const renderComponent = () =>
    render(
      <MemoryRouter initialEntries={["/callback"]}>
        <OAuthCallback />
      </MemoryRouter>,
    );

  it("shows loading spinner initially", () => {
    renderComponent();
    expect(screen.getByText("Completing sign-in...")).toBeInTheDocument();
  });

  it("resets API singletons before navigating on successful signInWithRedirect", () => {
    renderComponent();
    expect(hubListener).not.toBeNull();

    act(() => {
      hubListener!({ payload: { event: "signInWithRedirect" } });
    });

    expect(resetApiSingletons).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    // The reset must run before navigation so the incoming user never reuses
    // the previous session's client.
    expect(
      vi.mocked(resetApiSingletons).mock.invocationCallOrder[0],
    ).toBeLessThan(mockNavigate.mock.invocationCallOrder[0]);
  });

  it("shows error alert on signInWithRedirect_failure event", () => {
    renderComponent();

    act(() => {
      hubListener!({
        payload: {
          event: "signInWithRedirect_failure",
          data: { error: new Error("Token exchange failed") },
        },
      });
    });

    expect(screen.getByText("Sign-in failed")).toBeInTheDocument();
    expect(screen.getByText("Token exchange failed")).toBeInTheDocument();
  });

  it("shows timeout error after 10 seconds", () => {
    renderComponent();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByText("Sign-in failed")).toBeInTheDocument();
    expect(
      screen.getByText("Timed out waiting for sign-in to complete."),
    ).toBeInTheDocument();
  });

  it("renders clear session button on error", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderComponent();

    act(() => {
      hubListener!({
        payload: {
          event: "signInWithRedirect_failure",
          data: { error: "Some error" },
        },
      });
    });

    const clearButton = screen.getByRole("button", {
      name: "Clear session and try again",
    });
    expect(clearButton).toBeInTheDocument();

    // Mock window.location.href setter
    const originalLocation = window.location;
    const hrefSetter = vi.fn();
    Object.defineProperty(window, "location", {
      value: { href: "/callback" },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window.location, "href", {
      set: hrefSetter,
      configurable: true,
    });

    await user.click(clearButton);
    expect(hrefSetter).toHaveBeenCalledWith("/");

    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });
});
