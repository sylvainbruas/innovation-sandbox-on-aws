// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";

import {
  Container,
  Header,
  SpaceBetween,
  Wizard,
  WizardProps,
} from "@cloudscape-design/components";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import TextareaField from "@amzn/innovation-sandbox-frontend/components/FormFields/TextareaField";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AssignmentsForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/AssignmentsForm";
import { PendingAssignmentsList } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PendingAssignmentsList";
import { ReviewForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ReviewForm";
import { TemplateSelectionForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TemplateSelectionForm";
import { TermsOfServiceForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TermsOfServiceForm";
import { UserSelectionForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/UserSelectionForm";
import { toAssignmentRefs } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useRequestNewLease } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { NewLeaseRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  AssignLeaseFormValues,
  AssignLeaseValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/validation";
import { useGetLeaseTemplateById } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const AssignLease = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const { mutateAsync: requestNewLease, isPending: isSubmitting } =
    useRequestNewLease();

  const [activeStepIndex, setActiveStepIndex] = useState(0);

  // Initialize form with React Hook Form
  const methods = useForm<AssignLeaseFormValues>({
    resolver: zodResolver(AssignLeaseValidationSchema),
    mode: "all",
    defaultValues: {
      leaseTemplateUuid: "",
      userEmail: "",
      acceptTerms: false,
      comments: "",
    },
  });

  const { trigger, getFieldState, getValues, clearErrors, watch } = methods;

  // Reset acceptTerms whenever the request changes
  const leaseTemplateUuid = watch("leaseTemplateUuid");
  const assignmentsKey = (watch("assignments") ?? [])
    .map((a) => a.principalId)
    // Opaque IDC principal IDs: sort by code point for a deterministic,
    // locale-independent key. This value only feeds the effect dependency
    // below, so stable ordering matters, not human-readable collation.
    .sort((a, b) => Number(a > b) - Number(a < b))
    .join(",");
  useEffect(() => {
    methods.resetField("acceptTerms");
  }, [leaseTemplateUuid, assignmentsKey, methods]);

  const { data: globalConfig } = useGetConfigurations();
  const { isLoading: isTemplateLoading } = useGetLeaseTemplateById(
    leaseTemplateUuid || undefined,
  );

  const stepFields: Array<Array<keyof AssignLeaseFormValues>> = [
    ["leaseTemplateUuid"], // Template selection
    ["userEmail"], // User selection
    ["assignments"], // Share access (always available for admin/manager)
    ["acceptTerms"], // Terms of service
    [], // Review (no validation needed)
  ];

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Assign lease", href: "/assign" },
    ]);
    setTools(<Markdown file="assign-lease" />);
  }, []);

  const handleNavigate = async ({
    detail,
  }: {
    detail: WizardProps.NavigateDetail;
  }) => {
    await trigger(); // Validate all fields

    const { requestedStepIndex } = detail;

    // Only validate when moving forward
    if (requestedStepIndex > activeStepIndex) {
      const currentStepFields = stepFields[activeStepIndex];
      const currentStepHasErrors = currentStepFields.some(
        (field) => getFieldState(field).error !== undefined,
      );

      if (currentStepHasErrors) {
        return; // Block navigation
      }
    }

    clearErrors(); // clear errors so that the page being navigated to is fresh
    setActiveStepIndex(requestedStepIndex);
  };

  const handleSubmit = async () => {
    const isValid = await trigger();
    if (!isValid) {
      // ToS is always the second-to-last step (Review is last). Deriving
      // from stepFields.length keeps this correct if new steps are added.
      setActiveStepIndex(stepFields.length - 2);
      showErrorToast("Please correct validation errors", "Validation Failed");
      return;
    }

    const values = getValues();

    const assignments = toAssignmentRefs(values.assignments);

    const request: NewLeaseRequest = {
      leaseTemplateUuid: values.leaseTemplateUuid,
      comments: values.comments,
      userEmail: values.userEmail,
      ...(assignments ? { assignments } : {}),
    };

    try {
      await requestNewLease(request);
      navigate("/");
      showSuccessToast(`Lease has been assigned to ${values.userEmail}.`);
    } catch (error) {
      if (error instanceof Error) {
        showErrorToast(`Failed to submit lease assignment: ${error.message}`);
      }
    }
  };

  const onCancel = () => {
    navigate("/");
  };

  const steps = [
    {
      title: "Select lease template",
      content: (
        <TemplateSelectionForm label="What lease template would you like to use for this assignment?" />
      ),
    },
    {
      title: "Select user",
      content: (
        <UserSelectionForm
          enablePrincipalSearch={
            globalConfig?.leases?.enablePrincipalSearch ?? false
          }
        />
      ),
    },
    {
      title: "Share access",
      isOptional: true,
      content: (
        <AssignmentsForm
          enablePrincipalSearch={
            globalConfig?.leases?.enablePrincipalSearch ?? false
          }
          ownerEmail={watch("userEmail")}
        />
      ),
    },
    {
      title: "Terms of Service",
      content: (
        <TermsOfServiceForm checkboxText="I accept the above terms of service on behalf of the assigned user." />
      ),
    },
    {
      title: "Review & Submit",
      content: isTemplateLoading ? (
        <Loader label="Loading review..." />
      ) : (
        <SpaceBetween direction="vertical" size="l">
          <ReviewForm
            data={{
              leaseTemplateUuid: methods.watch("leaseTemplateUuid"),
              userEmail: methods.watch("userEmail"),
            }}
          />
          <PendingAssignmentsList
            desiredAssignments={methods.watch("assignments")}
          />
          <Container>
            <TextareaField
              controllerProps={{
                control: methods.control,
                name: "comments",
              }}
              formFieldProps={{
                label: "Comments",
                description:
                  "Optional - add additional comments about this assignment",
              }}
              textareaProps={{
                placeholder: "Enter any additional comments...",
                rows: 3,
              }}
            />
          </Container>
        </SpaceBetween>
      ),
    },
  ];

  return (
    <FormProvider {...methods}>
      <ContentLayout
        header={
          <Header
            variant="h1"
            description="Create a lease assignment for another user."
          >
            Assign lease
          </Header>
        }
      >
        <Wizard
          steps={steps}
          activeStepIndex={activeStepIndex}
          onNavigate={handleNavigate}
          onCancel={onCancel}
          onSubmit={handleSubmit}
          isLoadingNextStep={isSubmitting}
          allowSkipTo
          i18nStrings={{
            stepNumberLabel: (stepNumber) => `Step ${stepNumber}`,
            collapsedStepsLabel: (stepNumber, stepsCount) =>
              `Step ${stepNumber} of ${stepsCount}`,
            skipToButtonLabel: (step) => `Skip to ${step.title}`,
            navigationAriaLabel: "Steps",
            cancelButton: "Cancel",
            previousButton: "Previous",
            nextButton: "Next",
            submitButton: "Assign lease",
            optional: "optional",
          }}
        />
      </ContentLayout>
    </FormProvider>
  );
};
