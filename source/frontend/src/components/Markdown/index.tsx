// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { HelpPanel } from "@cloudscape-design/components";
import fm from "front-matter";
import { useEffect, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";

import { MarkdownLink } from "@amzn/innovation-sandbox-frontend/components/Markdown/MarkdownLink";

interface MarkdownProps {
  file: string;
}

interface MarkdownData {
  attributes: {
    title: string;
  };
  markdown: string;
}

const markdownComponents: Components = {
  a: (props: any) => <MarkdownLink {...props} />,
};

export const Markdown = ({ file }: MarkdownProps) => {
  const [markdown, setMarkdown] = useState<MarkdownData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `isCurrent` guards against out-of-order responses: when `file` changes
  // while a fetch is in flight (e.g. the settings page swaps the help file on
  // tab switch, reconciling into this same mounted instance), the superseded
  // request must not overwrite the newer file's content or error state.
  const init = async (isCurrent: () => boolean) => {
    setError(null);
    const response = await fetch(`/markdown/${file}.md`);
    if (!isCurrent()) {
      return;
    }
    if (!response.ok) {
      setError(`Failed to load markdown file: ${response.status}`);
      return;
    }

    const rawMarkdown = await response.text();
    if (!isCurrent()) {
      return;
    }
    const parsed = fm<{ title?: string }>(rawMarkdown);

    setMarkdown({
      attributes: {
        title: parsed.attributes.title || file,
      },
      markdown: parsed.body,
    });
  };

  useEffect(() => {
    let current = true;
    // Clear stale content so the panel shows its loading state instead of the
    // previous file's help while the new file is fetched (e.g. on a tab switch).
    setMarkdown(null);
    init(() => current);
    return () => {
      current = false;
    };
  }, [file]);

  if (error) {
    return (
      <HelpPanel header="Error">
        <p>Failed to load markdown content: {error}</p>
      </HelpPanel>
    );
  }

  if (markdown) {
    return (
      <HelpPanel header={markdown.attributes.title}>
        <ReactMarkdown components={markdownComponents}>
          {markdown.markdown}
        </ReactMarkdown>
      </HelpPanel>
    );
  }

  return <HelpPanel header="Loading..." />;
};
