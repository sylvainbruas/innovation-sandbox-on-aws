// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Link } from "@cloudscape-design/components";
import { ReactNode } from "react";

import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";

interface MarkdownLinkProps {
  href?: string;
  children?: ReactNode;
}

export const MarkdownLink = ({ href, children }: MarkdownLinkProps) => {
  if (!href) {
    return children;
  }

  const isInternal = href.startsWith("/") || href.startsWith("#");

  // fontSize="inherit" so a link inside a markdown heading keeps the heading's
  // size instead of dropping to the Link default body size.
  if (isInternal) {
    return (
      <TextLink to={href} fontSize="inherit">
        {children}
      </TextLink>
    );
  }

  return (
    <Link external variant="primary" fontSize="inherit" href={href}>
      {children}
    </Link>
  );
};
