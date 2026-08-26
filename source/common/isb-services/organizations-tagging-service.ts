// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OrganizationsClient,
  TagResourceCommand,
  UntagResourceCommand,
} from "@aws-sdk/client-organizations";

import { MonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  buildLeaseTagSet,
  ISB_LEASE_TAG_SUFFIXES,
  IsbAccountTags,
  IsbAccountTagSuffix,
  IsbStatusTagValue,
  toIsbTagKey,
} from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";

export class OrganizationsTaggingService {
  readonly orgsClient: OrganizationsClient;
  readonly namespace: string;

  constructor(props: { orgsClient: OrganizationsClient; namespace: string }) {
    this.orgsClient = props.orgsClient;
    this.namespace = props.namespace;
  }

  async tagAccount(accountId: string, tags: IsbAccountTags): Promise<void> {
    await this.orgsClient.send(
      new TagResourceCommand({
        ResourceId: accountId,
        Tags: Object.entries(tags)
          .filter((entry): entry is [IsbAccountTagSuffix, string] => {
            return entry[1] !== undefined;
          })
          .map(([suffix, Value]) => ({
            Key: toIsbTagKey(this.namespace, suffix),
            Value,
          })),
      }),
    );
  }

  async untagAccount(
    accountId: string,
    tagSuffixes: IsbAccountTagSuffix[],
  ): Promise<void> {
    await this.orgsClient.send(
      new UntagResourceCommand({
        ResourceId: accountId,
        TagKeys: tagSuffixes.map((suffix) =>
          toIsbTagKey(this.namespace, suffix),
        ),
      }),
    );
  }

  async updateStatusTag(
    accountId: string,
    status: IsbStatusTagValue,
  ): Promise<void> {
    await this.tagAccount(accountId, { Status: status });
  }

  async applyLeaseTags(lease: MonitoredLease, userId: string): Promise<void> {
    await this.tagAccount(lease.awsAccountId, {
      ...buildLeaseTagSet(lease, userId),
      Status: "Active",
    });
  }

  async removeLeaseTags(accountId: string): Promise<void> {
    await this.untagAccount(accountId, ISB_LEASE_TAG_SUFFIXES);
  }
}
