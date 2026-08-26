// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";

function mockMarkdownFetch(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Markdown", () => {
  it("renders the title as the panel header and the body as content", async () => {
    mockMarkdownFetch("---\ntitle: Test Title\n---\n\nSome body content.");

    render(
      <MemoryRouter>
        <Markdown file="test" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Some body content.")).toBeInTheDocument();
    const panel = createWrapper().findHelpPanel();
    expect(panel?.findHeader()?.getElement().textContent).toContain(
      "Test Title",
    );
  });

  it("ignores a stale fetch that resolves after the file prop changed", async () => {
    // The settings page swaps the help file on tab switch, reconciling into
    // the SAME mounted Markdown instance — so a slow fetch for the previous
    // file can resolve after the new file already rendered and must not
    // clobber it.
    let resolveSlow: (response: {
      ok: boolean;
      text: () => Promise<string>;
    }) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("slow")) {
          return new Promise((resolve) => {
            resolveSlow = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("---\ntitle: Fast\n---\n\nFast content."),
        });
      }),
    );

    const { rerender } = render(
      <MemoryRouter>
        <Markdown file="slow" />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <Markdown file="fast" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Fast content.")).toBeInTheDocument();

    // The superseded request resolves late; flush its promise chain.
    await act(async () => {
      resolveSlow!({
        ok: true,
        text: () => Promise.resolve("---\ntitle: Slow\n---\n\nSlow content."),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText("Slow content.")).not.toBeInTheDocument();
    expect(screen.getByText("Fast content.")).toBeInTheDocument();
  });

  it("ignores a stale non-OK response so it cannot overwrite the new file with an error", async () => {
    // A superseded request that resolves as a FAILURE (e.g. 404) must not clear
    // the newer file's content by setting the error state — this exercises the
    // isCurrent guard that sits before the !response.ok branch.
    let resolveSlow: (response: {
      ok: boolean;
      status: number;
      text: () => Promise<string>;
    }) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("slow")) {
          return new Promise((resolve) => {
            resolveSlow = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("---\ntitle: Fast\n---\n\nFast content."),
        });
      }),
    );

    const { rerender } = render(
      <MemoryRouter>
        <Markdown file="slow" />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <Markdown file="fast" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Fast content.")).toBeInTheDocument();

    // The superseded request fails late; the error must be discarded.
    await act(async () => {
      resolveSlow!({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      screen.queryByText(/failed to load markdown content/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Fast content.")).toBeInTheDocument();
  });

  it("shows an error panel when the fetch responds non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
      }),
    );

    render(
      <MemoryRouter>
        <Markdown file="missing" />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(/failed to load markdown content/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/404/)).toBeInTheDocument();
  });

  it("ignores a stale response whose body resolves after the file prop changed", async () => {
    // Variant of the race above: the superseded fetch RESPONDS before the
    // prop change, but its text() body is still pending when the new file
    // renders — the late body must also be discarded (second guard point).
    let resolveSlowText: (body: string) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("slow")) {
          return Promise.resolve({
            ok: true,
            text: () =>
              new Promise<string>((resolve) => {
                resolveSlowText = resolve;
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("---\ntitle: Fast\n---\n\nFast content."),
        });
      }),
    );

    const { rerender } = render(
      <MemoryRouter>
        <Markdown file="slow" />
      </MemoryRouter>,
    );
    // Let the slow fetch resolve (its text() now pending) before superseding.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    rerender(
      <MemoryRouter>
        <Markdown file="fast" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Fast content.")).toBeInTheDocument();

    await act(async () => {
      resolveSlowText!("---\ntitle: Slow\n---\n\nSlow content.");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText("Slow content.")).not.toBeInTheDocument();
    expect(screen.getByText("Fast content.")).toBeInTheDocument();
  });

  it("clears the previous file's content while the new file is loading", async () => {
    // On a file change (e.g. a settings tab switch), the panel must not keep
    // rendering the old tab's help during the new fetch window — it shows the
    // loading state until the new content resolves.
    let resolveSecond: (body: string) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("second")) {
          return Promise.resolve({
            ok: true,
            text: () =>
              new Promise<string>((resolve) => {
                resolveSecond = resolve;
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve("---\ntitle: First\n---\n\nFirst content."),
        });
      }),
    );

    const { rerender } = render(
      <MemoryRouter>
        <Markdown file="first" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("First content.")).toBeInTheDocument();

    // Switch files; the new fetch's body is still pending.
    rerender(
      <MemoryRouter>
        <Markdown file="second" />
      </MemoryRouter>,
    );

    // During the load window the stale content is gone and the loader shows.
    await waitFor(() =>
      expect(screen.queryByText("First content.")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    // Once the new file resolves, its content renders.
    await act(async () => {
      resolveSecond!("---\ntitle: Second\n---\n\nSecond content.");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("Second content.")).toBeInTheDocument();
  });
});
