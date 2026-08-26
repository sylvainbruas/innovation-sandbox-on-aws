// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";

import {
  BasicDetailsForm,
  BasicDetailsFormValues,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/BasicDetailsForm";
import { BasicDetailsValidationSchema } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";

function TestWrapper({
  leaseSharingEnabled = false,
  defaultValues,
}: {
  leaseSharingEnabled?: boolean;
  defaultValues?: Partial<BasicDetailsFormValues>;
}) {
  const methods = useForm<BasicDetailsFormValues>({
    resolver: zodResolver(BasicDetailsValidationSchema),
    mode: "all",
    defaultValues: {
      name: "",
      description: "",
      requiresApproval: true,
      visibility: "PRIVATE",
      allowOwnerToShareLease: false,
      ...defaultValues,
    },
  });

  return (
    <FormProvider {...methods}>
      <BasicDetailsForm leaseSharingEnabled={leaseSharingEnabled} />
    </FormProvider>
  );
}

describe("BasicDetailsForm", () => {
  describe("allowOwnerToShareLease toggle", () => {
    it("renders the toggle as disabled when leaseSharingEnabled is false", () => {
      render(<TestWrapper leaseSharingEnabled={false} />);

      expect(
        screen.getByText("Allow owner to share lease"),
      ).toBeInTheDocument();

      const toggle = screen.getByRole("checkbox", {
        name: /sharing disabled/i,
      });
      expect(toggle).toBeDisabled();
    });

    it("shows globally disabled message when leaseSharingEnabled is false", () => {
      render(<TestWrapper leaseSharingEnabled={false} />);

      expect(
        screen.getByText(/Lease sharing is globally disabled/i),
      ).toBeInTheDocument();
    });

    it("renders the toggle as enabled when leaseSharingEnabled is true", () => {
      render(<TestWrapper leaseSharingEnabled={true} />);

      expect(
        screen.getByText("Allow owner to share lease"),
      ).toBeInTheDocument();

      const toggle = screen.getByRole("checkbox", {
        name: /sharing disabled/i,
      });
      expect(toggle).not.toBeDisabled();
    });

    it("shows the normal description when leaseSharingEnabled is true", () => {
      render(<TestWrapper leaseSharingEnabled={true} />);

      expect(
        screen.getByText(
          /the lease owner can share sandbox access with additional users and groups/i,
        ),
      ).toBeInTheDocument();
    });

    it("displays 'Sharing enabled' when toggle value is true", () => {
      render(
        <TestWrapper
          leaseSharingEnabled={true}
          defaultValues={{ allowOwnerToShareLease: true }}
        />,
      );

      expect(screen.getByText("Sharing enabled")).toBeInTheDocument();
    });

    it("toggles from disabled to enabled on user click", async () => {
      const user = userEvent.setup();
      render(<TestWrapper leaseSharingEnabled={true} />);

      expect(screen.getByText("Sharing disabled")).toBeInTheDocument();

      const toggle = screen.getByRole("checkbox", {
        name: /sharing disabled/i,
      });
      await user.click(toggle);

      expect(screen.getByText("Sharing enabled")).toBeInTheDocument();
    });

    it("cannot be toggled when leaseSharingEnabled is false", async () => {
      const user = userEvent.setup();
      render(<TestWrapper leaseSharingEnabled={false} />);

      const toggle = screen.getByRole("checkbox", {
        name: /sharing disabled/i,
      });
      await user.click(toggle);

      // Should remain disabled — click has no effect
      expect(screen.getByText("Sharing disabled")).toBeInTheDocument();
    });

    it("preserves existing true value when globally disabled (edit scenario)", () => {
      render(
        <TestWrapper
          leaseSharingEnabled={false}
          defaultValues={{ allowOwnerToShareLease: true }}
        />,
      );

      // Toggle shows as checked (preserving the stored value) but disabled
      const toggle = screen.getByRole("checkbox", {
        name: /sharing enabled/i,
      });
      expect(toggle).toBeDisabled();
      expect(toggle).toBeChecked();
    });
  });

  describe("existing fields", () => {
    it("renders name, description, requiresApproval, and visibility fields", () => {
      render(<TestWrapper leaseSharingEnabled={false} />);

      expect(screen.getByLabelText("Name")).toBeInTheDocument();
      expect(screen.getByLabelText(/Description/i)).toBeInTheDocument();
      expect(screen.getByText("Requires Approval")).toBeInTheDocument();
      expect(screen.getByLabelText("Visibility")).toBeInTheDocument();
    });
  });
});
