// Publishes the generated client and server sources into their committed
// workspace packages, and validates the committed manifests against codegen.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { clientSrc, serverSrc } from "./domains.mjs";
import { clientDir, projections, serverDir } from "./paths.mjs";

/** The generated server runtime codegen emits, replaced with the aliased pin. */
const GENERATED_SERVER_RUNTIME = "1.0.0-alpha.10";
const ALIASED_SERVER_RUNTIME = "npm:@smithy/server-common@0.1.6";

/**
 * Rewrites the generated client manifest. Codegen drives its build through
 * `concurrently 'yarn:...'`, which fails in this npm-only repo, and does not
 * mark the package private. Replacing those scripts also makes their cleanup
 * and concurrency helpers and the unbuilt downlevel declaration mapping
 * obsolete.
 */
export function rewriteManifest(dir = clientDir) {
  const manifestPath = join(dir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read generated manifest at ${manifestPath}: ${error.message}`,
    );
  }
  manifest.license = "Apache-2.0";
  manifest.private = true;
  manifest.scripts = {
    build:
      "tsc -p tsconfig.cjs.json && tsc -p tsconfig.es.json && " +
      "tsc -p tsconfig.types.json",
  };
  for (const dependency of [
    "concurrently",
    "downlevel-dts",
    "premove",
    "rimraf",
  ]) {
    delete manifest.devDependencies?.[dependency];
  }
  delete manifest.typesVersions;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Validates the committed server manifest against what codegen actually
 * requires, instead of synthesizing it. The manifest (and the tsconfigs it
 * builds with) are ordinary committed files; generation only replaces
 * `domains/`, so drift between the committed shell and codegen output must be
 * caught here with an actionable error rather than silently shipped.
 *
 * Checks, per run:
 *  - every registered domain has an `exports["./<domain>"]` entry pointing at
 *    the conventional `dist-types`/`dist-cjs` paths (CJS + type declarations
 *    only — the server package is a private Lambda build input, not a browser
 *    library; `default` covers esbuild's `import`, Node's native `import` via
 *    CJS interop, and `require`), and no entry exists for an unregistered one;
 *  - the committed runtime dependencies are exactly the union of the domains'
 *    generated dependencies, with the generated `@aws-smithy/server-common`
 *    runtime mapped to the reviewed `npm:` alias pin; two domains pinning
 *    different versions of one dependency is codegen drift and fails.
 */
export function validateServerManifest(committed, manifests, domains) {
  const manifestHint =
    "update source/api-server/package.json (and package-lock.json)";
  validateServerExports(committed.exports ?? {}, domains, manifestHint);
  validateServerDependencies(
    committed.dependencies ?? {},
    unionGeneratedServerDeps(manifests),
    manifestHint,
  );
}

/** The exports map the committed manifest must declare for these domains. */
function expectedServerExports(domains) {
  const exports = {};
  for (const domain of [...domains].sort((a, b) => a.localeCompare(b))) {
    exports[`./${domain}`] = {
      types: `./dist-types/${domain}/index.d.ts`,
      default: `./dist-cjs/${domain}/index.js`,
    };
  }
  return exports;
}

/** Every registered domain is exported at the conventional paths, and no other. */
function validateServerExports(actualExports, domains, manifestHint) {
  const expected = expectedServerExports(domains);
  const sorted = (obj) => Object.keys(obj).sort((a, b) => a.localeCompare(b));
  const expectedKeys = sorted(expected);
  const actualKeys = sorted(actualExports);
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw new Error(
      `server manifest exports [${actualKeys.join(", ")}] do not match the ` +
        `registered domains [${expectedKeys.join(", ")}]; ${manifestHint}`,
    );
  }
  for (const [subpath, target] of Object.entries(expected)) {
    if (JSON.stringify(actualExports[subpath]) !== JSON.stringify(target)) {
      throw new Error(
        `server manifest export ${subpath} must be ` +
          `${JSON.stringify(target)}; ${manifestHint}`,
      );
    }
  }
}

/**
 * Unions the domains' generated runtime dependencies, mapping the generated
 * `@aws-smithy/server-common` to the reviewed `npm:` alias pin and failing on a
 * cross-domain version conflict (real codegen drift needing reconciliation).
 */
function unionGeneratedServerDeps(manifests) {
  const required = {};
  for (const { domain, manifest } of manifests) {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      const want = aliasServerRuntime(name, version, domain);
      if (required[name] !== undefined && required[name] !== want) {
        throw new Error(
          `server domain ${domain} pins ${name}@${want}, conflicting with ` +
            `${required[name]} from another domain; reconcile before merging`,
        );
      }
      required[name] = want;
    }
  }
  return required;
}

/** Maps the generated server runtime to its aliased pin; passes others through. */
function aliasServerRuntime(name, version, domain) {
  if (name !== "@aws-smithy/server-common") return version;
  if (version !== GENERATED_SERVER_RUNTIME) {
    throw new Error(
      `unexpected generated server runtime ${version} for ${domain}`,
    );
  }
  return ALIASED_SERVER_RUNTIME;
}

/** The committed runtime dependencies are exactly the required union. */
function validateServerDependencies(declared, required, manifestHint) {
  for (const [name, version] of Object.entries(required)) {
    if (declared[name] === undefined) {
      throw new Error(
        `codegen requires dependency ${name}@${version} that the server ` +
          `manifest does not declare; ${manifestHint}`,
      );
    }
    if (declared[name] !== version) {
      throw new Error(
        `codegen requires ${name}@${version} but the server manifest declares ` +
          `${declared[name]}; ${manifestHint}`,
      );
    }
  }
  for (const name of Object.keys(declared)) {
    if (required[name] === undefined) {
      throw new Error(
        `server manifest declares dependency ${name} that no domain's codegen ` +
          `requires; ${manifestHint}`,
      );
    }
  }
}

/**
 * Ensures the checked-in installation manifest remains identical to codegen
 * output. npm ci reads the checked-in copy before generation, so accepting
 * dependency drift here would recreate a package with missing modules.
 */
export function assertManifestMatchesBootstrap(bootstrap, dir = clientDir) {
  const generated = readFileSync(join(dir, "package.json"), "utf8");
  if (generated !== bootstrap) {
    throw new Error(
      "generated manifest differs from the checked-in bootstrap; " +
        `update ${join(dir, "package.json")} and package-lock.json`,
    );
  }
}

/**
 * Publishes the client projection via a staging directory and an atomic rename,
 * so an interrupted run cannot leave the workspace member truncated. node_modules
 * is carried across because npm links dependencies there.
 */
export function publish(from = clientSrc(), to = clientDir) {
  const staging = `${to}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    cpSync(from, staging, { recursive: true });
    const deps = join(to, "node_modules");
    if (existsSync(deps)) {
      renameSync(deps, join(staging, "node_modules"));
    }
    rmSync(to, { recursive: true, force: true });
    renameSync(staging, to);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Publishes every domain's generated server *sources* into the committed server
 * package: only the generated `src/` trees land, as `domains/<domain>/`. The
 * package shell — manifest and tsconfigs — is committed and never written by
 * generation; `validateServerManifest` holds it to what codegen requires. Only
 * the `domains/` subtree is replaced (atomically, via a staging directory), so
 * `node_modules` and the committed files are never touched. Compiled `dist-*`
 * output is cleared so a removed domain's stale output cannot ship; the
 * workspace build recompiles it.
 */
export function publishServer(domains, root = projections, to = serverDir) {
  if (domains.length === 0) {
    throw new Error(
      "publishServer: no server domains — expected at least one `server-<name>` " +
        "projection in smithy-build.json",
    );
  }
  const committedPath = join(to, "package.json");
  let committed;
  try {
    committed = JSON.parse(readFileSync(committedPath, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read the committed server manifest at ${committedPath}: ` +
        `${error.message}`,
    );
  }
  const target = join(to, "domains");
  const staging = `${target}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging, { recursive: true });
    const manifests = [];
    for (const domain of domains) {
      const from = serverSrc(domain, root);
      if (!existsSync(join(from, "src"))) {
        throw new Error(
          `api-model: expected generated server sources for ${domain} at ` +
            `${join(from, "src")}`,
        );
      }
      const manifestPath = join(from, "package.json");
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (error) {
        throw new Error(
          `could not read generated server manifest for ${domain} at ` +
            `${manifestPath}: ${error.message}`,
        );
      }
      manifests.push({ domain, manifest });
      cpSync(join(from, "src"), join(staging, domain), { recursive: true });
    }
    validateServerManifest(committed, manifests, domains);
    rmSync(join(to, "dist-cjs"), { recursive: true, force: true });
    rmSync(join(to, "dist-types"), { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
