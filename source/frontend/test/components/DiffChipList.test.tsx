// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";

import {
  DIFF_CHIP_LIMIT,
  DiffChipList,
} from "@amzn/innovation-sandbox-frontend/components/DiffChipList";

const consequence = { singular: "One item.", plural: "Many items." };

// Zero-padded so an aria-label / text substring match on "item-01" can't also
// hit "item-010" etc. when a list crosses the show-more limit.
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => `item-${String(i).padStart(2, "0")}`);

describe("DiffChipList", () => {
  test("renders nothing when the item list is empty", () => {
    const { container } = render(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="diff"
        items={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the heading with the item count and renders each item as a chip", () => {
    render(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="diff"
        items={["beta", "alpha"]}
      />,
    );

    expect(screen.getByText("Adding (2)")).toBeInTheDocument();
    const badges = createWrapper(document.body)
      .findAllBadges()
      .map((b) => b.getElement().textContent);
    // Sorted alphabetically (case-insensitive), not in the given order.
    expect(badges).toEqual(["alpha", "beta"]);
  });

  test("sorts case-insensitively rather than by raw code point", () => {
    render(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="diff"
        items={["Banana", "apple", "Cherry"]}
      />,
    );
    const badges = createWrapper(document.body)
      .findAllBadges()
      .map((b) => b.getElement().textContent);
    // A code-point sort would put all capitals first: ["Banana","Cherry","apple"].
    expect(badges).toEqual(["apple", "Banana", "Cherry"]);
  });

  test("uses the singular consequence for one item and the plural for many", () => {
    const { rerender } = render(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="diff"
        items={["only"]}
      />,
    );
    expect(screen.getByText("One item.")).toBeInTheDocument();
    expect(screen.queryByText("Many items.")).not.toBeInTheDocument();

    rerender(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="diff"
        items={["one", "two"]}
      />,
    );
    expect(screen.getByText("Many items.")).toBeInTheDocument();
    expect(screen.queryByText("One item.")).not.toBeInTheDocument();
  });

  test("renders chips as non-interactive (no dismiss control)", () => {
    render(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="diff"
        items={["a", "b"]}
      />,
    );
    // A read-only display of a change must not look actionable.
    expect(
      screen.queryByRole("button", { name: /dismiss|remove/i }),
    ).not.toBeInTheDocument();
  });

  test("scopes the chips under the given testId", () => {
    render(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="my-diff"
        items={["a", "b"]}
      />,
    );
    const region = screen.getByTestId("my-diff");
    expect(within(region).getByText("a")).toBeInTheDocument();
    expect(within(region).getByText("b")).toBeInTheDocument();
  });

  test("shows all chips and no toggle at exactly the limit", () => {
    render(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="diff"
        items={items(DIFF_CHIP_LIMIT)}
      />,
    );
    expect(createWrapper(document.body).findAllBadges()).toHaveLength(
      DIFF_CHIP_LIMIT,
    );
    // At the limit (not over it) there is nothing hidden, so no toggle.
    expect(
      screen.queryByRole("button", { name: /show .* more/i }),
    ).not.toBeInTheDocument();
  });

  test("caps chips at the limit and expands / collapses one past it", async () => {
    const user = userEvent.setup();
    render(
      <DiffChipList
        heading="Adding"
        consequence={consequence}
        color="green"
        testId="diff"
        items={items(DIFF_CHIP_LIMIT + 1)}
      />,
    );

    // Over the limit: only DIFF_CHIP_LIMIT chips show, the rest behind the toggle.
    expect(createWrapper(document.body).findAllBadges()).toHaveLength(
      DIFF_CHIP_LIMIT,
    );

    // The label counts exactly the hidden chips.
    await user.click(screen.getByRole("button", { name: "Show 1 more" }));
    expect(createWrapper(document.body).findAllBadges()).toHaveLength(
      DIFF_CHIP_LIMIT + 1,
    );

    // Collapsing returns to the capped count.
    await user.click(screen.getByRole("button", { name: /show fewer/i }));
    expect(createWrapper(document.body).findAllBadges()).toHaveLength(
      DIFF_CHIP_LIMIT,
    );
  });
});
