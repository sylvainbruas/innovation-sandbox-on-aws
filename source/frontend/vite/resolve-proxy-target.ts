// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import type { ProxyOptions } from "vite";
/**
 * Paths proxied to the deployed CloudFront distribution during local dev.
 * Routing through CloudFront reproduces the production path exactly: it strips
 * the /api prefix, prepends the API Gateway stage, and rewrites the Host header
 * to the API Gateway host, which is what the SigV4 signature is computed
 * against. This avoids cross-origin CORS failures without weakening signing.
 */
export const PROXIED_PATHS = ["/api", "/config.json"];

/**
 * Resolves the CloudFront URL that local dev requests should be proxied to.
 *
 * Precedence:
 *   1. VITE_API_PROXY_TARGET (explicit override)
 *   2. The `CloudFrontDistributionUrl` output of the deployed `<prefix>-Compute`
 *      stack, resolved via CloudFormation using the deployment settings from the
 *      repo-root .env (STACK_PREFIX, DEPLOY_REGION, HUB_ACCOUNT_PROFILE).
 *
 * Fails soft: returns `undefined` (and warns) if the target can't be resolved,
 * so the dev server still starts, just without API proxying.
 *
 * @param env Deployment settings (typically Vite's `loadEnv` of the repo-root .env).
 */
export async function resolveApiProxyTarget(
  env: Record<string, string>,
): Promise<string | undefined> {
  if (env.VITE_API_PROXY_TARGET) {
    return env.VITE_API_PROXY_TARGET;
  }

  const region = env.DEPLOY_REGION;
  if (!region) {
    console.warn(
      "[vite] DEPLOY_REGION not set in .env and VITE_API_PROXY_TARGET not provided; " +
        "API requests will not be proxied.",
    );
    return undefined;
  }

  const stackPrefix = env.STACK_PREFIX || "InnovationSandbox";
  const computeStackName = `${stackPrefix}-Compute`;

  // The Data/Compute stacks are deployed to the hub account; reuse that profile
  // unless the caller already exported AWS_PROFILE.
  if (env.HUB_ACCOUNT_PROFILE && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = env.HUB_ACCOUNT_PROFILE;
  }

  try {
    const cfn = new CloudFormationClient({ region });
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: computeStackName }),
    );
    const url = response.Stacks?.[0]?.Outputs?.find(
      (output) => output.OutputKey === "CloudFrontDistributionUrl",
    )?.OutputValue;

    if (!url) {
      console.warn(
        `[vite] CloudFrontDistributionUrl output not found on ${computeStackName}; ` +
          "API requests will not be proxied.",
      );
      return undefined;
    }
    return url;
  } catch (error) {
    console.warn(
      `[vite] Could not resolve the API proxy target from ${computeStackName} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "Set VITE_API_PROXY_TARGET to override. API requests will not be proxied.",
    );
    return undefined;
  }
}

/** Builds the Vite dev-server proxy map that routes PROXIED_PATHS to `target`. */
export function buildDevProxy(target: string): Record<string, ProxyOptions> {
  return Object.fromEntries(
    PROXIED_PATHS.map((proxyPath) => [
      proxyPath,
      { target, changeOrigin: true, secure: true },
    ]),
  );
}
