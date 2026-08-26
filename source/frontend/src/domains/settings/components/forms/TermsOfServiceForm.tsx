// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, KeyValuePairs } from "@cloudscape-design/components";

import TextareaField from "@amzn/innovation-sandbox-frontend/components/FormFields/TextareaField";
import { SectionForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/SectionForm";
import { SectionData } from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { CONFIG_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";

export function TermsOfServiceForm({
  data,
}: {
  data: SectionData<"termsOfService">;
}) {
  return (
    <SectionForm
      section="termsOfService"
      title="Terms of Service"
      anchorId="terms-of-service"
      data={data}
      renderFields={() => (
        <TextareaField
          controllerProps={{ name: "content" }}
          formFieldProps={{
            label: "Terms of service content",
            description: "Displayed to users when requesting a lease.",
          }}
          textareaProps={{ rows: 10 }}
          maxLength={CONFIG_CONSTRAINTS.MAX_TERMS_OF_SERVICE_LENGTH}
        />
      )}
      renderReadOnly={(d) => (
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "Terms of service content",
              value: <Box variant="pre">{d.content || "(not configured)"}</Box>,
            },
          ]}
        />
      )}
    />
  );
}
