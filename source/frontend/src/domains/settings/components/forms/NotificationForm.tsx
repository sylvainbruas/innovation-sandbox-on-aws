// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { KeyValuePairs } from "@cloudscape-design/components";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import { SectionForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/SectionForm";
import { SectionData } from "@amzn/innovation-sandbox-frontend/domains/settings/service";

export function NotificationForm({
  data,
}: {
  data: SectionData<"notification">;
}) {
  return (
    <SectionForm
      section="notification"
      title="Notification"
      anchorId="notification"
      data={data}
      renderFields={() => (
        <InputField
          controllerProps={{ name: "emailFrom" }}
          formFieldProps={{
            label: "Email from address",
            description:
              "The sender address for all email notifications. Leave empty to disable email notifications.",
          }}
          inputProps={{
            type: "email",
            placeholder: "e.g., no-reply@example.com",
          }}
        />
      )}
      renderReadOnly={(d) => (
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "Email from address",
              value: d.emailFrom ? d.emailFrom : "(notifications disabled)",
            },
          ]}
        />
      )}
    />
  );
}
