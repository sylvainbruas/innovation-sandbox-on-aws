// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from "msw";

import {
  AdminConfig,
  ConfigSection,
} from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { ConfigSchemas } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { mockConfigurationApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";

// --- Default `GET /configurations` handler ---------------------------------
// `GET /configurations` serves the section-based AdminConfig shape consumed by
// every config reader (Admin Settings, lease/leaseTemplate/blueprint pages, the
// maintenance banner). Registered as the default handler below.

export const mockConfiguration: AdminConfig = createConfiguration({
  isbManagedRegions: ["us-east-1", "us-west-2"],
});
mockConfigurationApi.returns(mockConfiguration);

export const configurationHandlers = [mockConfigurationApi.getHandler()];

// --- Section-based helpers (opt-in) ----------------------------------------
// The section GET/PUT route handlers and finish-setup fixtures below are
// exported but NOT in the default list above; tests opt in with
// `server.use(...adminConfigurationHandlers)` or the individual handlers.

const MOCK_CREATED_TIME = "2026-04-04T10:00:00.000Z";
const MOCK_LAST_EDIT_TIME = "2026-04-04T12:30:00.000Z";
const MOCK_LAST_SAVED_BY = "admin@example.com";

/** The response envelope a saved section carries: who saved it and when. */
const savedEnvelope = () => ({
  lastSavedBy: MOCK_LAST_SAVED_BY,
  meta: {
    schemaVersion: 1,
    createdTime: MOCK_CREATED_TIME,
    lastEditTime: MOCK_LAST_EDIT_TIME,
  },
});

/**
 * Builds a section-based AdminConfig mock. By default every section is rendered
 * "saved" (non-null `lastSavedBy` + `meta`). Pass `unsaved` section keys to
 * render those as never-saved (code defaults, `lastSavedBy: null`, no `meta`)
 * to exercise finish-setup alerts. Note that unsaved sections deliberately omit
 * `meta` to mirror the API: a section with `lastSavedBy: null` has never been
 * written to DynamoDB, so consumers must not assume `meta.lastEditTime` exists.
 */
export function createAdminConfig(options?: {
  unsaved?: ConfigSection[];
}): AdminConfig {
  const unsaved = new Set(options?.unsaved ?? []);
  const sections = Object.fromEntries(
    (Object.keys(ConfigSchemas) as ConfigSection[]).map((section) => {
      const fields = ConfigSchemas[section].parse({});
      const envelope = unsaved.has(section)
        ? { lastSavedBy: null }
        : savedEnvelope();
      return [section, { ...fields, ...envelope }];
    }),
  );

  return {
    ...sections,
    isbManagedRegions: ["us-east-1", "us-west-2"],
    awsAccessPortalUrl: "https://d-0000000000.awsapps.com/start",
  } as AdminConfig;
}

export const mockAdminConfig: AdminConfig = createAdminConfig();

const apiUrl = () => getConfig().ApiUrl;

/** `GET /configurations` returning the section-based AdminConfig shape. */
export const adminConfigGetHandler = (config: AdminConfig = mockAdminConfig) =>
  http.get(`${apiUrl()}/configurations`, () =>
    HttpResponse.json({ status: "success", data: config }),
  );

/** True only for the six real config section keys (not deploy-time fields). */
const isConfigSection = (value: string): value is ConfigSection =>
  Object.prototype.hasOwnProperty.call(ConfigSchemas, value);

/** `GET /configurations/{section}` returning a single section. */
export const configurationSectionGetHandler = (
  config: AdminConfig = mockAdminConfig,
) =>
  http.get(`${apiUrl()}/configurations/:section`, ({ params }) => {
    const section = params.section as string;
    // Mirror the API's path allowlist: unknown sections (and the deploy-time
    // keys isbManagedRegions/awsAccessPortalUrl, which are not sections) 404.
    if (!isConfigSection(section)) {
      return new HttpResponse(null, { status: 404 });
    }
    return HttpResponse.json({ status: "success", data: config[section] });
  });

/**
 * `PUT /configurations/{section}` echoing the submitted fields back with a
 * server-set `lastSavedBy` and `meta`.
 */
export const configurationSectionPutHandler = () =>
  http.put(`${apiUrl()}/configurations/:section`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    // Drop server-owned fields the client must not set; keep only the section
    // fields and re-stamp the envelope.
    const { lastSavedBy: _ignored, meta: _meta, ...fields } = body;
    return HttpResponse.json({
      status: "success",
      data: { ...fields, ...savedEnvelope() },
    });
  });

/** `PUT /configurations/{section}` returning a 409 optimistic-concurrency conflict. */
export const configurationSectionConflictHandler = () =>
  http.put(`${apiUrl()}/configurations/:section`, () =>
    HttpResponse.json(
      {
        status: "fail",
        data: {
          errors: [
            {
              message:
                "These settings were modified by another administrator. Reload to see the latest values.",
            },
          ],
        },
      },
      { status: 409 },
    ),
  );

/**
 * `PUT /configurations/{section}` returning a 400 field-validation error. The
 * JSend body mirrors the backend's `createHttpJSendValidationError`: an
 * `errors` array of `{ field?, message }` entries (no echoed user values).
 * `field` is the React Hook Form field name; an entry with no `field` (or the
 * `"input"` sentinel the backend emits for empty Zod paths) is a non-field
 * error. Standalone like the 409 handler — opt in per-test via `server.use`.
 */
export const configurationSectionValidationHandler = (
  errors: Array<{ field?: string; message: string }> = [
    { field: "enabled", message: "Maintenance mode must be a boolean." },
  ],
) =>
  http.put(`${apiUrl()}/configurations/:section`, () =>
    HttpResponse.json({ status: "fail", data: { errors } }, { status: 400 }),
  );

/** Success-path section handlers for Admin Settings tests to opt into. */
export const adminConfigurationHandlers = [
  adminConfigGetHandler(),
  configurationSectionGetHandler(),
  configurationSectionPutHandler(),
];
