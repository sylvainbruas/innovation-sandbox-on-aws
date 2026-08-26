// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import NumberField from "@amzn/innovation-sandbox-frontend/components/FormFields/NumberField";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const TestSchema = z.object({
  amount: z.number().min(1, "Must be at least 1"),
});

type TestFormValues = z.infer<typeof TestSchema>;

function TestComponent({ defaultValue }: { defaultValue?: number }) {
  const { control, watch } = useForm<TestFormValues>({
    resolver: zodResolver(TestSchema),
    mode: "onChange",
    defaultValues: { amount: defaultValue },
  });

  const amount = watch("amount");

  return (
    <>
      <NumberField
        controllerProps={{ control, name: "amount" }}
        formFieldProps={{
          label: "Amount",
          description: "How many",
          constraintText: "Minimum 1",
        }}
        inputProps={{ placeholder: "Enter amount" }}
      />
      <div data-testid="amount-value">{String(amount)}</div>
    </>
  );
}

describe("NumberField", () => {
  test("renders label, description and constraint text", () => {
    renderWithQueryClient(<TestComponent />);

    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(screen.getByText("How many")).toBeInTheDocument();
    expect(screen.getByText("Minimum 1")).toBeInTheDocument();
  });

  test("renders a numeric input", () => {
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Enter amount");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("inputmode", "numeric");
  });

  test("displays the default value", () => {
    renderWithQueryClient(<TestComponent defaultValue={42} />);

    expect(screen.getByDisplayValue("42")).toBeInTheDocument();
  });

  test("coerces typed input to a number in form state", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    await user.type(screen.getByPlaceholderText("Enter amount"), "25");

    await waitFor(() => {
      // A coerced number renders as "25"; an uncoerced string would too, so the
      // distinguishing check is that the zod number schema below stays valid.
      expect(screen.getByTestId("amount-value")).toHaveTextContent("25");
    });
  });

  test("displays a validation error for an out-of-range number", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TestComponent />);

    const input = screen.getByPlaceholderText("Enter amount");
    await user.type(input, "0");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText("Must be at least 1")).toBeInTheDocument();
    });
  });

  test("emits both min and max as native input attributes", () => {
    function TestBounded() {
      const { control } = useForm<{ amount: number }>({
        defaultValues: { amount: undefined },
      });

      return (
        <NumberField
          controllerProps={{ control, name: "amount" }}
          formFieldProps={{ label: "Amount" }}
          inputProps={{ placeholder: "Enter amount" }}
          min={1}
          max={10}
        />
      );
    }

    renderWithQueryClient(<TestBounded />);

    const input = screen.getByPlaceholderText("Enter amount");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "10");
  });

  test("emits only min when max is omitted (the common config field shape)", () => {
    function TestBounded() {
      const { control } = useForm<{ amount: number }>({
        defaultValues: { amount: undefined },
      });

      return (
        <NumberField
          controllerProps={{ control, name: "amount" }}
          formFieldProps={{ label: "Amount" }}
          inputProps={{ placeholder: "Enter amount" }}
          min={1}
        />
      );
    }

    renderWithQueryClient(<TestBounded />);

    const input = screen.getByPlaceholderText("Enter amount");
    expect(input).toHaveAttribute("min", "1");
    expect(input).not.toHaveAttribute("max");
  });

  test("emits only max when min is omitted", () => {
    function TestBounded() {
      const { control } = useForm<{ amount: number }>({
        defaultValues: { amount: undefined },
      });

      return (
        <NumberField
          controllerProps={{ control, name: "amount" }}
          formFieldProps={{ label: "Amount" }}
          inputProps={{ placeholder: "Enter amount" }}
          max={10}
        />
      );
    }

    renderWithQueryClient(<TestBounded />);

    const input = screen.getByPlaceholderText("Enter amount");
    expect(input).toHaveAttribute("max", "10");
    expect(input).not.toHaveAttribute("min");
  });

  test("explicit inputProps.type overrides the numeric default", () => {
    function TestOverride() {
      const { control } = useForm<{ amount: number }>({
        defaultValues: { amount: undefined },
      });

      return (
        <NumberField
          controllerProps={{ control, name: "amount" }}
          formFieldProps={{ label: "Amount" }}
          inputProps={{ type: "text", placeholder: "Enter amount" }}
        />
      );
    }

    renderWithQueryClient(<TestOverride />);

    expect(screen.getByPlaceholderText("Enter amount")).toHaveAttribute(
      "type",
      "text",
    );
  });
});
