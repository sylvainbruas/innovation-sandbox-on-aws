// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  Container,
  Header,
  Modal,
  Popover,
  SpaceBetween,
} from "@cloudscape-design/components";
import { zodResolver } from "@hookform/resolvers/zod";
import { DateTime } from "luxon";
import { ReactNode, useEffect, useRef, useState } from "react";
import { FieldValues, FormProvider, useForm } from "react-hook-form";

import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useTrackUnsavedChanges } from "@amzn/innovation-sandbox-frontend/domains/settings/components/UnsavedChangesGuard";
import {
  useGetConfigurationSection,
  usePutConfigurationSection,
} from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import {
  ConfigSection,
  SectionData,
} from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { ConfigWriteSchemas } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

type SectionFields<T extends ConfigSection> = Omit<
  SectionData<T>,
  "lastSavedBy" | "meta"
>;

export interface SectionFormProps<T extends ConfigSection> {
  section: T;
  /** Section title shown in the Container header. */
  title: string;
  data: SectionData<T>;
  renderFields: () => ReactNode;
  renderReadOnly: (data: SectionData<T>) => ReactNode;
  /** DOM id used as a scroll target for deep-links (e.g. the maintenance banner). */
  anchorId?: string;
  /**
   * Suppress the generic "Using default values" alert for a never-saved section.
   * Set by sections that render their own, more specific finish-setup alert (e.g.
   * MaintenanceForm's fail-closed lockout warning) so the two do not stack.
   */
  suppressDefaultsAlert?: boolean;
  /**
   * Ask the user to confirm a sensitive save. Called with the values about to
   * be submitted and the form's persisted baseline (kept current through save
   * and conflict-reload, unlike the mount-time data prop); return the
   * confirmation copy (header, message, confirm button label) to show a modal
   * before saving, or null to save immediately (e.g. the sensitive field did
   * not change). `message` may be any node, so a section can render a richer
   * body (e.g. a before/after diff) rather than a plain sentence.
   */
  confirmBeforeSave?: (
    values: FieldValues,
    baseline: FieldValues,
  ) => { header: string; message: ReactNode; confirmLabel: string } | null;
}

/**
 * Human-readable provenance shown in the section footer, styled as subtle
 * metadata. Saved sections show who last edited and how long ago (relative
 * time), with the exact timestamp revealed on hover/click via a Popover; a
 * never-saved section says so (and is paired with the finish-setup alert).
 */
function LastSavedDescription({
  data,
}: {
  data: { lastSavedBy: string | null; meta?: { lastEditTime?: string } };
}) {
  if (!data.lastSavedBy) {
    return (
      <Box variant="small" color="text-body-secondary">
        Not yet saved
      </Box>
    );
  }
  // Guard against a malformed timestamp (fall back to the editor-only line
  // rather than rendering "Invalid DateTime" or a bogus "x ago").
  const dt = data.meta?.lastEditTime
    ? DateTime.fromISO(data.meta.lastEditTime)
    : undefined;
  if (!dt?.isValid) {
    return (
      <Box variant="small" color="text-body-secondary">
        {`Last edited by ${data.lastSavedBy}`}
      </Box>
    );
  }
  const relative = dt.toRelative();
  const absolute = dt.toLocaleString(DateTime.DATETIME_MED);
  return (
    <Box variant="small" color="text-body-secondary">
      {`Last edited by ${data.lastSavedBy} `}
      <Popover
        dismissButton={false}
        position="top"
        size="small"
        triggerType="text"
        content={absolute}
      >
        <Box variant="span" fontSize="body-s" color="text-body-secondary">
          {relative}
        </Box>
      </Popover>
    </Box>
  );
}

const CONFLICT_MESSAGE =
  "These settings were modified by another administrator. Reload to see the latest values.";

// The backend stamps `field: "input"` on a validation issue with an empty Zod
// path (a whole-object/non-field error); it names no registered input, so it
// is surfaced via the form-level root error rather than an inline field error.
const ROOT_ERROR_SENTINEL = "input";

function toFormValues<T extends ConfigSection>(
  data: SectionData<T>,
): SectionFields<T> {
  const { lastSavedBy: _l, meta: _m, ...fields } = data;
  return fields as SectionFields<T>;
}

export function SectionForm<T extends ConfigSection>({
  section,
  title,
  data,
  renderFields,
  renderReadOnly,
  anchorId,
  suppressDefaultsAlert,
  confirmBeforeSave,
}: SectionFormProps<T>) {
  const { isAdmin, isLoading: isUserLoading } = useUser();
  const needsSetup = data.lastSavedBy === null;
  const [conflict, setConflict] = useState(false);
  // A save awaiting user confirmation (set when confirmBeforeSave returns
  // copy for the submitted values); null when no confirmation is pending.
  const [pendingSave, setPendingSave] = useState<{
    values: FieldValues;
    header: string;
    message: ReactNode;
    confirmLabel: string;
  } | null>(null);
  // The concurrency token is seeded once from the mount-time `data` prop and
  // thereafter advanced only by a successful save or an explicit Reload. It is
  // deliberately NOT re-seeded from later `data` props: a background refetch
  // (e.g. the admin-config query invalidated by another section's save, or a
  // window-refocus refetch) can deliver a newer token while the form fields
  // still show the user's unsaved values. Re-seeding then would let Save submit
  // stale values under a fresh token, silently overwriting a concurrent edit.
  // Letting the stale token ride means such a save hits a 409 and surfaces the
  // Reload flow instead — per the design (§4.1, "Do NOT auto-refetch").
  const [lastEditTime, setLastEditTime] = useState(data.meta?.lastEditTime);
  const putMutation = usePutConfigurationSection(section);
  const reloadQuery = useGetConfigurationSection(section, { enabled: false });

  const methods = useForm<FieldValues>({
    resolver: zodResolver(ConfigWriteSchemas[section] as never),
    mode: "all",
    defaultValues: toFormValues(data) as FieldValues,
  });

  useTrackUnsavedChanges(section, methods.formState.isDirty);

  // A form-level (root) server error from a prior 400 is normally cleared by the
  // next submit. But once Save is disabled on a pristine form (nothing to save),
  // the user can no longer submit — so if they revert their edit back to the
  // saved baseline, the stale alert would strand with no way to dismiss it.
  // Clear it when the form returns to pristine. (Field-level `type: "server"`
  // errors already clear on the next edit, so only the root alert needs this.)
  const isDirty = methods.formState.isDirty;
  useEffect(() => {
    if (!isDirty) {
      methods.clearErrors("root");
    }
  }, [isDirty, methods]);

  // Re-seed the form when a refresh (or another admin's save) delivers newer
  // server data via the `data` prop — but ONLY when this section has no unsaved
  // edits. A dirty section keeps the user's in-progress values (and still
  // surfaces the explicit per-section Reload / 409 conflict flow), preserving
  // the "do not clobber unsaved edits" rule that governs the mount-time seeding.
  //
  // We track the last edit time SEEN ON THE PROP (not the concurrency token in
  // `lastEditTime` state): a local Save or explicit Reload advances the token
  // ahead of the prop while the parent query is still catching up, and keying
  // off the token would wrongly re-seed the form backward to the stale prop.
  const seenPropEditTimeRef = useRef(data.meta?.lastEditTime);
  useEffect(() => {
    const propEditTime = data.meta?.lastEditTime;
    if (propEditTime === seenPropEditTimeRef.current) {
      return; // parent delivered no genuinely new data
    }
    if (isDirty) {
      return; // keep the user's unsaved edits
    }
    seenPropEditTimeRef.current = propEditTime;
    methods.reset(toFormValues(data) as FieldValues);
    setLastEditTime(propEditTime);
  }, [data, isDirty, methods]);

  const container = (body: ReactNode, footer: ReactNode) => (
    <div id={anchorId}>
      <Container header={<Header variant="h2">{title}</Header>} footer={footer}>
        {body}
      </Container>
    </div>
  );

  // Wait for the role to resolve before choosing a view. Without this, the
  // loading state (roles === [], so isAdmin is false) is indistinguishable from
  // a real Manager, so an Admin briefly sees the read-only summary flash before
  // the editable form swaps in.
  if (isUserLoading) {
    return container(<Loader />, <LastSavedDescription data={data} />);
  }

  // Manager (read-only): footer shows provenance only (no Save button).
  if (!isAdmin) {
    return container(
      renderReadOnly(data),
      <LastSavedDescription data={data} />,
    );
  }

  // Maps a 400 validation response onto the form. Each error entry is a
  // `{ field, message }` pair (see ConfigWriteSchemas / the backend's
  // createHttpJSendValidationError) carrying no echoed user value. A `field`
  // that names a registered input gets an inline field error; an entry with no
  // field, the `"input"` sentinel the backend emits for an empty Zod path, or a
  // field this form does not render falls back to the form-level root error so
  // it is never swallowed. An empty/garbage body toasts so the save failure is
  // never silent.
  const applyValidationErrors = (error: ApiError) => {
    const errors = (error.data?.errors ?? []) as Array<{
      field?: string;
      message: string;
    }>;
    const registered = new Set(Object.keys(methods.getValues()));
    // Field errors map onto their inputs; non-field errors (no field, the
    // `"input"` sentinel, or a field this form does not render) are collected
    // and surfaced together in the single form-level alert. Aggregating avoids
    // each `setError("root.serverError", ...)` overwriting the previous one,
    // which would silently drop all but the last non-field message.
    const rootMessages: string[] = [];
    for (const { field, message } of errors) {
      if (field && field !== ROOT_ERROR_SENTINEL && registered.has(field)) {
        methods.setError(field, { type: "server", message });
      } else {
        rootMessages.push(message);
      }
    }
    if (rootMessages.length) {
      methods.setError("root.serverError", {
        type: "server",
        message: rootMessages.join("; "),
      });
    }
    if (errors.length === 0) {
      showErrorToast(
        "Failed to save settings: validation error",
        "Save Failed",
      );
    }
  };

  const performSave = async (values: FieldValues) => {
    setConflict(false);
    // A stale root error from a prior 400 is cleared by handleSubmit, which
    // unsets `root` on every submit — the submit that calls this directly, or
    // the one that opened the confirmation modal (nothing can re-set `root`
    // between open and confirm) — so a later success or a different 400 starts
    // from a clean form-level alert.
    try {
      const updated = await putMutation.mutateAsync({
        ...values,
        meta: lastEditTime ? { lastEditTime } : undefined,
      });
      setLastEditTime(updated.meta?.lastEditTime);
      methods.reset(values);
      showSuccessToast("Settings saved.");
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 409) {
        setConflict(true);
        return;
      }
      if (error instanceof ApiError && error.statusCode === 400) {
        applyValidationErrors(error);
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      showErrorToast(`Failed to save settings: ${message}`, "Save Failed");
    }
  };

  const onSubmit = async (values: FieldValues) => {
    // Compare against the form's reset baseline, not the mount-time `data`
    // prop: the baseline is re-seeded by every successful save and conflict
    // Reload, so the "did the sensitive field change" check stays accurate
    // where the prop can be stale.
    const confirmation = confirmBeforeSave?.(
      values,
      methods.formState.defaultValues as FieldValues,
    );
    if (confirmation) {
      setPendingSave({ values, ...confirmation });
      return;
    }
    await performSave(values);
  };

  const onReload = async () => {
    // Branch on the refetch error, not on `data`: a refetch that fails after a
    // prior successful load resolves with `data` still set to the last success,
    // so checking only `data` would silently reset the form to stale values and
    // clear the conflict instead of surfacing the failure.
    const { data: latest, error } = await reloadQuery.refetch();
    if (error || !latest) {
      showErrorToast("Failed to reload the latest settings.", "Reload Failed");
      return;
    }
    methods.reset(toFormValues(latest) as FieldValues);
    setLastEditTime(latest.meta?.lastEditTime);
    setConflict(false);
  };

  // True only when a registered field has a CLIENT-side (resolver) error.
  // Server-injected errors carry `type: "server"` (set by applyValidationErrors)
  // and the form-level alert lives under the `root` key — both are excluded so a
  // server 400 never locks Save and `root` is never treated as a field.
  const fieldErrors = methods.formState.errors;
  const hasClientValidationError = Object.entries(fieldErrors).some(
    ([name, error]) => name !== "root" && error && error.type !== "server",
  );

  // Disable Save when a saved section is pristine (nothing to save). A
  // never-saved section (needsSetup) stays enabled even when pristine so the
  // finish-setup flow can persist the defaults. Server errors (a 400 mapped to
  // the form) do not set isDirty, so they never gate Save here — they clear on
  // the next submit / field edit, and hasClientValidationError handles the rest.
  const nothingToSave = !needsSetup && !methods.formState.isDirty;

  const saveButton = (
    <Button
      variant="primary"
      formAction="submit"
      loading={putMutation.isPending}
      // Disable on CLIENT-side (resolver) validation failures or when there is
      // nothing to save (see `nothingToSave` above for why server errors do not
      // gate Save). `mode: "all"` keeps validation live as the user types.
      disabled={hasClientValidationError || nothingToSave}
      // Keep the disabled button focusable and announce WHY it is disabled
      // (Cloudscape renders disabledReason as an accessible tooltip), so the
      // reason is discoverable by keyboard/screen-reader users and the
      // offending field is findable even when scrolled out of view. Matches the
      // disabledReason convention used elsewhere (e.g. ListLeases). Validation
      // takes priority over nothing-to-save (an invalid edit is also dirty).
      disabledReason={
        hasClientValidationError
          ? "Fix the highlighted fields before saving."
          : nothingToSave
            ? "No changes to save."
            : undefined
      }
    >
      Save
    </Button>
  );

  // The <form> wraps the whole Container so the footer's Save button still
  // submits it. The footer holds provenance (left) and Save (right); the
  // Container renders a top border above the footer, giving the divider.
  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)}>
        {container(
          <SpaceBetween size="l">
            {needsSetup && !suppressDefaultsAlert && (
              <Alert type="info" header="Using default values">
                This section has not been saved yet. The values shown are
                defaults — review and save to apply them to your deployment.
              </Alert>
            )}
            {conflict && (
              <Alert
                type="error"
                header="Conflict"
                action={
                  // formAction="none" renders type="button" so clicking Reload
                  // does not also submit the form (Cloudscape Buttons default to
                  // type="submit", which would fire a stale-token save).
                  <Button
                    formAction="none"
                    onClick={onReload}
                    loading={reloadQuery.isFetching}
                  >
                    Reload
                  </Button>
                }
              >
                {CONFLICT_MESSAGE}
              </Alert>
            )}
            {methods.formState.errors.root?.serverError && (
              <Alert type="error" header="Validation error">
                {methods.formState.errors.root.serverError.message}
              </Alert>
            )}
            {renderFields()}
          </SpaceBetween>,
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            {<LastSavedDescription data={data} />}
            {saveButton}
          </div>,
        )}
        {pendingSave && (
          <Modal
            visible
            onDismiss={() => setPendingSave(null)}
            header={pendingSave.header}
            closeAriaLabel="Close"
            footer={
              <Box float="right">
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    formAction="none"
                    variant="link"
                    onClick={() => setPendingSave(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    formAction="none"
                    variant="primary"
                    onClick={async () => {
                      const { values } = pendingSave;
                      setPendingSave(null);
                      await performSave(values);
                    }}
                  >
                    {pendingSave.confirmLabel}
                  </Button>
                </SpaceBetween>
              </Box>
            }
          >
            {pendingSave.message}
          </Modal>
        )}
      </form>
    </FormProvider>
  );
}
