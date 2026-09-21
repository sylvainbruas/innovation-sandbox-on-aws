// The registered server domains and the generated-projection paths derived from
// them. smithy-build.json's `server-<name>` projections are the single source of
// truth for the domain list.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { modelDir, projections } from "./paths.mjs";

/**
 * The registered domains, derived from smithy-build.json's `server-<name>`
 * projections — the single source of truth. Each name maps to that projection
 * (SSDK for its service) and to the subpath export
 * `@amzn/innovation-sandbox-api-server/<name>`.
 */
export function serverDomains(root = modelDir) {
  const config = JSON.parse(
    readFileSync(join(root, "smithy-build.json"), "utf8"),
  );
  return Object.keys(config.projections ?? {})
    .filter((name) => name.startsWith("server-"))
    .map((name) => {
      const domain = name.slice("server-".length);
      // The domain becomes a directory name and an exports subpath, so an
      // empty or path-unsafe token must fail here, not misbehave downstream.
      if (!/^[a-z0-9][a-z0-9-]*$/.test(domain)) {
        throw new Error(
          `invalid server projection name "${name}" in smithy-build.json: ` +
            "the part after server- must match [a-z0-9][a-z0-9-]*",
        );
      }
      return domain;
    })
    .sort((a, b) => a.localeCompare(b));
}

/** Absolute path to a projection's directory under the build output. */
export function projectionDir(name, root = projections) {
  return join(root, name);
}

/** Absolute path to the aggregate projection's generated client sources. */
export function clientSrc(root = projections) {
  return join(projectionDir("aggregate", root), "typescript-client-codegen");
}

/** Absolute path to a domain's generated server sources. */
export function serverSrc(domain, root = projections) {
  return join(
    projectionDir(`server-${domain}`, root),
    "typescript-ssdk-codegen",
  );
}
