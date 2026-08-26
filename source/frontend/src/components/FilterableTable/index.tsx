// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
  Box,
  Button,
  CollectionPreferences,
  Header,
  Pagination,
  PropertyFilter,
  SpaceBetween,
  Table,
  TableProps,
} from "@cloudscape-design/components";
import { PropertyFilterProps } from "@cloudscape-design/components/property-filter";
import { ReactNode, useState } from "react";

/** Column definition with required `id` field (FilterableTable needs it for visibility preferences). */
export type FilterableColumnDefinition<T> = TableProps.ColumnDefinition<T> & {
  id: string;
};

export interface FilterableTableProps<T> {
  /** Table title displayed in the header */
  title: string;
  /** Optional description below the header title */
  description?: string;
  /** Items to display (may still be loading) */
  items: T[];
  /** Column definitions for the table (id is required) */
  columnDefinitions: FilterableColumnDefinition<T>[];
  /** Property filter definitions for the property filter component */
  filteringProperties: PropertyFilterProps.FilteringProperty[];
  /** Whether data is currently being fetched */
  loading?: boolean;
  /** Loading text */
  loadingText?: string;
  /** Unique key for each item */
  trackBy: keyof T & string;
  /** Whether to show selection checkboxes */
  selectionType?: "single" | "multi";
  /** Currently selected items */
  selectedItems?: T[];
  /** Selection change handler */
  onSelectionChange?: (items: T[]) => void;
  /** Callback when refresh button is clicked */
  onRefresh?: () => void;
  /** Additional action buttons to render in the header */
  headerActions?: ReactNode;
  /** Content to display when the table is empty and no error */
  emptyContent?: ReactNode;
  /** Content to display when an error occurred */
  errorContent?: ReactNode;
  /** Whether an error occurred */
  isError?: boolean;
  /** Default visible columns (by id) */
  defaultVisibleColumns?: string[];
  /** Default page size */
  defaultPageSize?: number;
  /** Whether to show the counter in the header */
  showCounter?: boolean;
  /** Default property filter query applied on mount (user-adjustable) */
  defaultFilteringQuery?: PropertyFilterProps.Query;
}

const PAGE_SIZE_OPTIONS = [
  { value: 10, label: "10 rows" },
  { value: 25, label: "25 rows" },
  { value: 50, label: "50 rows" },
  { value: 100, label: "100 rows" },
];

/**
 * Reusable table component built on Cloudscape Table with:
 * - Property filter for filtering
 * - Sortable columns
 * - Pagination
 * - Collection preferences (page size, visible columns)
 * - Refresh button
 * - Error and empty states
 */
export function FilterableTable<T>({
  title,
  description,
  items,
  columnDefinitions,
  filteringProperties,
  loading = false,
  loadingText = "Loading...",
  trackBy,
  selectionType,
  selectedItems,
  onSelectionChange,
  onRefresh,
  headerActions,
  emptyContent,
  errorContent,
  isError = false,
  defaultVisibleColumns,
  defaultPageSize = 25,
  showCounter = true,
  defaultFilteringQuery,
}: FilterableTableProps<T>) {
  const [preferences, setPreferences] = useState({
    pageSize: defaultPageSize,
    visibleContent:
      defaultVisibleColumns ?? columnDefinitions.map((col) => col.id),
  });

  const {
    items: paginatedItems,
    actions,
    filteredItemsCount,
    collectionProps,
    propertyFilterProps,
    paginationProps,
  } = useCollection(items, {
    propertyFiltering: {
      filteringProperties,
      defaultQuery: defaultFilteringQuery,
      empty: emptyContent ?? (
        <Box textAlign="center" color="inherit" variant="p">
          No items found
        </Box>
      ),
      noMatch: (
        <Box textAlign="center" color="inherit">
          <SpaceBetween size="s">
            <Box variant="p">No matches</Box>
            <Button
              onClick={() =>
                actions.setPropertyFiltering({ tokens: [], operation: "and" })
              }
            >
              Clear filter
            </Button>
          </SpaceBetween>
        </Box>
      ),
    },
    pagination: { pageSize: preferences.pageSize },
    sorting: {},
    selection: {},
  });

  const counter =
    showCounter && !loading
      ? filteredItemsCount !== items.length
        ? `(${filteredItemsCount}/${items.length})`
        : `(${items.length})`
      : undefined;

  return (
    <Table
      variant="container"
      stripedRows
      resizableColumns
      trackBy={trackBy}
      loading={loading}
      loadingText={loadingText}
      selectionType={selectionType}
      selectedItems={selectedItems}
      onSelectionChange={
        onSelectionChange
          ? ({ detail }) => onSelectionChange(detail.selectedItems)
          : undefined
      }
      sortingColumn={collectionProps.sortingColumn}
      sortingDescending={collectionProps.sortingDescending}
      onSortingChange={collectionProps.onSortingChange}
      columnDisplay={columnDefinitions.map((col) => ({
        id: col.id,
        visible: preferences.visibleContent.includes(col.id),
      }))}
      items={paginatedItems}
      columnDefinitions={columnDefinitions}
      empty={
        isError
          ? (errorContent ?? (
              <Box textAlign="center" color="inherit" variant="p">
                An error occurred while loading data.
              </Box>
            ))
          : collectionProps.empty
      }
      filter={
        <PropertyFilter
          {...propertyFilterProps}
          i18nStrings={{
            filteringAriaLabel: `Filter ${title.toLowerCase()}`,
            filteringPlaceholder: `Filter ${title.toLowerCase()}`,
            groupValuesText: "Values",
            groupPropertiesText: "Properties",
            operatorsText: "Operators",
            operationAndText: "and",
            operationOrText: "or",
            operatorLessText: "Less than",
            operatorLessOrEqualText: "Less than or equal",
            operatorGreaterText: "Greater than",
            operatorGreaterOrEqualText: "Greater than or equal",
            operatorContainsText: "Contains",
            operatorDoesNotContainText: "Does not contain",
            operatorEqualsText: "Equals",
            operatorDoesNotEqualText: "Does not equal",
            editTokenHeader: "Edit filter",
            propertyText: "Property",
            operatorText: "Operator",
            valueText: "Value",
            cancelActionText: "Cancel",
            applyActionText: "Apply",
            clearFiltersText: "Clear filters",
            removeTokenButtonAriaLabel: (token) =>
              `Remove filter: ${token.propertyLabel} ${token.operator} ${token.value}`,
            enteredTextLabel: (text) => `Use: "${text}"`,
          }}
          countText={`${filteredItemsCount} ${filteredItemsCount === 1 ? "match" : "matches"}`}
          expandToViewport
        />
      }
      header={
        <Header
          variant="h2"
          counter={counter}
          description={description}
          actions={
            <SpaceBetween direction="horizontal" size="s">
              {onRefresh && (
                <Button
                  iconName="refresh"
                  ariaLabel="Refresh"
                  onClick={onRefresh}
                  disabled={loading}
                />
              )}
              {headerActions}
            </SpaceBetween>
          }
        >
          {title}
        </Header>
      }
      pagination={<Pagination {...paginationProps} />}
      preferences={
        <CollectionPreferences
          title="Preferences"
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          preferences={{
            pageSize: preferences.pageSize,
            visibleContent: preferences.visibleContent,
          }}
          onConfirm={({ detail }) =>
            setPreferences({
              pageSize: detail.pageSize ?? preferences.pageSize,
              visibleContent: detail.visibleContent
                ? [...detail.visibleContent]
                : preferences.visibleContent,
            })
          }
          pageSizePreference={{
            title: "Page size",
            options: PAGE_SIZE_OPTIONS,
          }}
          visibleContentPreference={{
            title: "Select visible columns",
            options: [
              {
                label: "Properties",
                options: columnDefinitions.map((col) => ({
                  id: col.id,
                  label: typeof col.header === "string" ? col.header : col.id,
                  editable: true,
                })),
              },
            ],
          }}
        />
      }
    />
  );
}
