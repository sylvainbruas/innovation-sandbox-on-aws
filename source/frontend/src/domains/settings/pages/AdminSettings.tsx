// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Badge,
  Button,
  Container,
  Header,
  Icon,
  KeyValuePairs,
  Link,
  SpaceBetween,
  Tabs,
  Tooltip,
} from "@cloudscape-design/components";
import { ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { CleanupForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CleanupForm";
import { CostReportingForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CostReportingForm";
import { LeasesForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/LeasesForm";
import { MaintenanceForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/MaintenanceForm";
import { NotificationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/NotificationForm";
import { TermsOfServiceForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/TermsOfServiceForm";
import {
  UnsavedChangesProvider,
  useDirtySections,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/UnsavedChangesGuard";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import {
  AdminConfig,
  ConfigMetadata,
  ConfigSection,
} from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

/**
 * The audit envelope every section response carries. A section that has never
 * been saved to DynamoDB has `lastSavedBy: null` and no `meta`.
 */
type SectionEnvelope = { lastSavedBy: string | null; meta?: ConfigMetadata };

/**
 * Deploy-time fields resolved from environment variables (not stored in the
 * config table and not writable via PUT), shown read-only for all roles.
 */
function ReadOnlySettings({ config }: { config: AdminConfig }) {
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Configured at deployment time and cannot be changed here."
        >
          Read-Only Settings
        </Header>
      }
    >
      <KeyValuePairs
        columns={2}
        items={[
          {
            label: "Innovation Sandbox managed regions",
            // Render each region as a read-only Badge chip (non-interactive)
            // rather than a comma-joined string, matching the cost-report-groups
            // read-only view.
            value: config.isbManagedRegions.length ? (
              <SpaceBetween direction="horizontal" size="xs">
                {config.isbManagedRegions.map((region) => (
                  <Badge key={region}>{region}</Badge>
                ))}
              </SpaceBetween>
            ) : (
              "(none)"
            ),
          },
          {
            label: "AWS access portal URL",
            value: config.awsAccessPortalUrl ? (
              <Link external href={config.awsAccessPortalUrl}>
                {config.awsAccessPortalUrl}
              </Link>
            ) : (
              "(not set)"
            ),
          },
        ]}
      />
    </Container>
  );
}

/**
 * True when EVERY editable config section is unsaved (`lastSavedBy === null`) —
 * i.e. a fresh install still on all defaults. Drives the aggregate
 * "Initial setup required" banner. Shown only when all sections are unsaved (not
 * a partial state), so it does not duplicate the per-section finish-setup alerts
 * once the admin has started saving sections.
 */
function allSectionsUnsaved(config: AdminConfig): boolean {
  const sections: SectionEnvelope[] = [
    config.leases,
    config.cleanup,
    config.maintenance,
    config.termsOfService,
    config.notification,
    config.costReporting,
  ];
  return sections.every((s) => s.lastSavedBy === null);
}

/** Tab ids — also the values used in the `/settings#<tab>` deep-link hash. */
const TAB_IDS = {
  leasesCost: "leases-cost",
  cleanup: "cleanup",
  general: "general",
  readOnly: "read-only",
} as const;

type TabId = (typeof TAB_IDS)[keyof typeof TAB_IDS];

/**
 * Help panel markdown file per tab (public/markdown/<file>.md), so the info
 * panel shows only the active tab's documentation rather than the whole page's.
 * Keyed exhaustively over TAB_IDS so adding a tab without help fails to compile.
 * Exported so tests can pin every value to an existing file.
 */
export const TAB_HELP: Record<TabId, string> = {
  [TAB_IDS.leasesCost]: "settings-leases-cost",
  [TAB_IDS.cleanup]: "settings-cleanup",
  [TAB_IDS.general]: "settings-general",
  [TAB_IDS.readOnly]: "settings-read-only",
};

/**
 * Anchor ids for the sections, used as deep-link scroll targets (e.g. the
 * maintenance banner links to `/settings#maintenance`, and each help file's
 * section headings link to sections by these anchors).
 */
const SECTION_ANCHORS = {
  leases: "lease-policies",
  costReporting: "cost-reporting",
  cleanup: "cleanup-section",
  maintenance: "maintenance",
  termsOfService: "terms-of-service",
  notification: "notification",
} as const;

/**
 * Maps a deep-link hash to the tab that should open (and, when the hash is a
 * section anchor, the section to scroll to). E.g. the maintenance banner and
 * the help panel link to `#maintenance`, which lives in the General tab.
 */
const HASH_TO_TAB: Record<string, TabId> = {
  [SECTION_ANCHORS.leases]: TAB_IDS.leasesCost,
  [SECTION_ANCHORS.costReporting]: TAB_IDS.leasesCost,
  [SECTION_ANCHORS.cleanup]: TAB_IDS.cleanup,
  [SECTION_ANCHORS.maintenance]: TAB_IDS.general,
  [SECTION_ANCHORS.termsOfService]: TAB_IDS.general,
  [SECTION_ANCHORS.notification]: TAB_IDS.general,
  // Allow linking directly to a tab by its id too.
  ...Object.fromEntries(Object.values(TAB_IDS).map((id) => [id, id])),
};

const UNSAVED_INDICATOR_LABEL = "Unsaved changes on this tab";

/**
 * Non-focusable hover-tooltip shell for the small indicators inside a tab
 * label (the amber unsaved-edits icon, the red never-saved count badge).
 * Uses Cloudscape's public `Tooltip` component (exported from
 * @cloudscape-design/components) with its public props — it is uncontrolled
 * (visibility is caller-managed), so we drive it from pointer handlers; the
 * other tooltip-like option, Popover, is click-triggered, not hover. The
 * trigger is deliberately NOT focusable (no tabIndex): it renders inside the
 * tab's own interactive element, so a nested focus stop would break the
 * tablist's roving-tabindex model. Screen readers get the meaning from
 * `role="img"` + `aria-label` (announced with the tab), matching the visible
 * tooltip text so both modalities read identically.
 */
function IndicatorTooltip({
  label,
  children,
}: Readonly<{
  label: string;
  children: ReactNode;
}>) {
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);

  return (
    <span
      ref={triggerRef}
      role="img"
      aria-label={label}
      style={{ display: "inline-flex", cursor: "default" }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <Tooltip
          getTrack={() => triggerRef.current}
          content={label}
          onEscape={() => setVisible(false)}
        />
      )}
    </span>
  );
}

/** Amber warning icon flagging unsaved edits on a tab, with a hover tooltip. */
function UnsavedIndicator() {
  return (
    <IndicatorTooltip label={UNSAVED_INDICATOR_LABEL}>
      <Icon name="status-warning" variant="warning" />
    </IndicatorTooltip>
  );
}

/**
 * Red count Badge of a tab's never-saved sections, with a hover tooltip. The
 * bare count is not self-explanatory, so the badge carries a tooltip +
 * aria-label phrased in the app's established vocabulary ("using default
 * values" — matching the per-section alerts and the initial-setup banner;
 * deliberately NOT "not configured", since the system is fully operational on
 * defaults).
 */
function NeverSavedBadge({ count }: Readonly<{ count: number }>) {
  return (
    <IndicatorTooltip
      label={`${count} ${count === 1 ? "section" : "sections"} using default values`}
    >
      <Badge color="red">{count}</Badge>
    </IndicatorTooltip>
  );
}

/**
 * Tab label with two distinct attention indicators for the tab's sections:
 *  - a red count Badge of never-saved sections (`lastSavedBy === null`) — the
 *    per-tab analogue of the side-nav SettingsBadge, flagging setup still to do;
 *  - an amber warning icon when any of the tab's sections has an edit that has
 *    not been saved yet (dirty), so switching away from a tab does not hide
 *    in-progress work.
 * A never-saved section is already covered by the red badge, so the warning
 * icon counts only saved-but-dirty sections — the two indicators never
 * double-mark one section, matching "red = never saved, warning = edited-but-
 * not-saved".
 */
function TabLabel({
  label,
  config,
  sectionKeys,
}: {
  label: string;
  config: AdminConfig;
  sectionKeys: ConfigSection[];
}) {
  const dirtySections = useDirtySections();
  const unsavedCount = sectionKeys.filter(
    (key) => config[key].lastSavedBy === null,
  ).length;
  const hasDirtyEdit = sectionKeys.some(
    (key) => config[key].lastSavedBy !== null && dirtySections.has(key),
  );

  if (unsavedCount === 0 && !hasDirtyEdit) {
    return label;
  }
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <span>{label}</span>
      {unsavedCount > 0 && <NeverSavedBadge count={unsavedCount} />}
      {hasDirtyEdit && <UnsavedIndicator />}
    </SpaceBetween>
  );
}

/**
 * Admin Settings page. Renders each configuration section as an independent
 * Container with its own form and Save button (the form components own the
 * save/409/reload and role-based read-only logic). Replaces the legacy
 * read-only Settings page.
 */
export const AdminSettings = () => {
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const {
    data: config,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useGetConfigurations();
  const location = useLocation();

  const [activeTabId, setActiveTabId] = useState<TabId>(TAB_IDS.leasesCost);
  // Each deep-link NAVIGATION is consumed once, identified by location.key
  // (unique per history entry) rather than the hash string: re-clicking a help
  // link whose hash is already in the URL is a new navigation that must still
  // switch tabs, while a re-render (e.g. the config refetch invalidated by a
  // section Save) keeps the same key and must not yank the user back.
  const consumedNavKey = useRef<string | null>(null);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Settings", href: "/settings" },
    ]);
  }, []);

  // Keep the help panel's content in sync with the active tab (including tab
  // switches driven by a deep-link hash), so an already-open panel updates too.
  useEffect(() => {
    setTools(<Markdown file={TAB_HELP[activeTabId]} />);
  }, [activeTabId]);

  // Honor a `/settings#<hash>` deep-link: select the mapped tab, then scroll to
  // the section anchor if the hash names one. Runs once per navigation.
  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (!hash || location.key === consumedNavKey.current) {
      return;
    }
    const targetTab = HASH_TO_TAB[hash];
    if (!targetTab) {
      return;
    }
    consumedNavKey.current = location.key;
    setActiveTabId(targetTab);
    // Scroll after the tab content has rendered. The section element only
    // exists once its tab is active; a rAF lets that render commit first.
    // scrollIntoView is guarded — it is absent in some environments (e.g. jsdom)
    // and is a non-essential enhancement, so its absence must not throw.
    requestAnimationFrame(() => {
      const target = document.getElementById(hash);
      if (typeof target?.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, [location.key]);

  return (
    // The provider collects each SectionForm's dirty state and guards
    // navigation (route blocker + beforeunload) while any edits are unsaved.
    <UnsavedChangesProvider>
      <ContentLayout
        header={
          <Header
            variant="h1"
            info={<InfoLink markdown={TAB_HELP[activeTabId]} />}
            description="Manage global configuration settings for Innovation Sandbox."
            actions={
              <Button
                iconName="refresh"
                ariaLabel="Refresh settings"
                disabled={isFetching}
                onClick={() => refetch()}
              />
            }
          >
            Settings
          </Header>
        }
      >
        {isLoading ? (
          <Loader />
        ) : !config ? (
          // Only blow away the page when there is no usable config at all. A
          // background refetch (e.g. the invalidation after a section Save) can
          // fail transiently while React Query still holds the last-good config —
          // in that case keep rendering the cached sections rather than replacing
          // the whole page with the error panel.
          <ErrorPanel
            description="There was a problem loading settings."
            retry={refetch}
            error={error as Error}
          />
        ) : (
          // Each tab groups one or more WHOLE config sections. A section is the
          // unit of saving (one form + Save + concurrency token per DynamoDB
          // section), so a section is never split across tabs.
          //
          // contentRenderStrategy="eager" keeps every tab's content mounted (just
          // hidden) so a section's in-progress edits survive switching tabs —
          // Cloudscape's default would unmount the inactive tab and discard the
          // unsaved form state.
          <SpaceBetween size="l">
            {allSectionsUnsaved(config) && (
              <Alert type="warning" header="Initial setup required">
                All configuration sections are using default values. Review each
                section and save to apply your preferred settings. The system is
                fully operational with these defaults in the meantime.
              </Alert>
            )}
            <Tabs
              activeTabId={activeTabId}
              // Cloudscape types activeTabId as plain string; the rendered
              // tabs below only carry TAB_IDS values, so narrowing is safe.
              onChange={({ detail }) =>
                setActiveTabId(detail.activeTabId as TabId)
              }
              tabs={[
                {
                  id: TAB_IDS.leasesCost,
                  label: (
                    <TabLabel
                      label="Leases & Cost"
                      config={config}
                      sectionKeys={["leases", "costReporting"]}
                    />
                  ),
                  contentRenderStrategy: "eager",
                  content: (
                    <SpaceBetween size="l">
                      <LeasesForm data={config.leases} />
                      <CostReportingForm data={config.costReporting} />
                    </SpaceBetween>
                  ),
                },
                {
                  id: TAB_IDS.cleanup,
                  label: (
                    <TabLabel
                      label="Cleanup"
                      config={config}
                      sectionKeys={["cleanup"]}
                    />
                  ),
                  contentRenderStrategy: "eager",
                  content: <CleanupForm data={config.cleanup} />,
                },
                {
                  id: TAB_IDS.general,
                  label: (
                    <TabLabel
                      label="General"
                      config={config}
                      sectionKeys={[
                        "maintenance",
                        "termsOfService",
                        "notification",
                      ]}
                    />
                  ),
                  contentRenderStrategy: "eager",
                  content: (
                    <SpaceBetween size="l">
                      <MaintenanceForm data={config.maintenance} />
                      <TermsOfServiceForm data={config.termsOfService} />
                      <NotificationForm data={config.notification} />
                    </SpaceBetween>
                  ),
                },
                {
                  id: TAB_IDS.readOnly,
                  label: "Read-only",
                  content: <ReadOnlySettings config={config} />,
                },
              ]}
            />
          </SpaceBetween>
        )}
      </ContentLayout>
    </UnsavedChangesProvider>
  );
};
