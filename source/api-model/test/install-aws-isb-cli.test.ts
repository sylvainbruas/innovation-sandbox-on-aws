// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolated tests for the modular `aws isb` installer.
 *
 * Every test uses a temporary HOME/config/model and a fake AWS CLI. No real
 * credentials, AWS account, or network access is used.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { awsCliModelDir } from "../scripts/lib/paths.mjs";

// Every test spawns the Python installer as a fresh subprocess. Under the
// full-repo coverage run (many parallel workers each cold-spawning python3),
// the default 5s timeout is too tight for the first spawns; give them headroom.
vi.setConfig({ testTimeout: 30_000 });

const INSTALLER = fileURLToPath(
  new URL(
    "../../../scripts/m2m/aws-cli/install-aws-isb-cli.py",
    import.meta.url,
  ),
);
const API_ID = "94j3twtjwa";
const API_URL = `https://${API_ID}.execute-api.us-east-1.amazonaws.com/prod`;

const FAKE_AWS = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_AWS_LOG"], "a") as log:
    log.write("AWS_PROFILE=" + os.environ.get("AWS_PROFILE", "") + " | " + " ".join(args) + "\\n")
if args[:1] == ["--version"]:
    print(os.environ.get("FAKE_AWS_VERSION", "aws-cli/2.15.0 Python/3.11 Linux"))
    sys.exit(0)
if args[:2] == ["cloudformation", "describe-stacks"]:
    namespace = os.environ.get("FAKE_NAMESPACE", "myisb")
    parameters = []
    if namespace:
        parameters.append({"ParameterKey": "Namespace", "ParameterValue": namespace})
    print(json.dumps({"Stacks": [{
        "Outputs": [{"OutputKey": "ApiGatewayUrl", "OutputValue": os.environ["FAKE_API_URL"]}],
        "Parameters": parameters
    }]}))
    sys.exit(0)
if args[:2] == ["ssm", "get-parameter"]:
    if os.environ.get("FAKE_SSM_FAIL"):
        sys.stderr.write("AccessDeniedException")
        sys.exit(254)
    print(json.dumps({"Parameter": {"Value": os.environ["FAKE_SSM_API_ID"]}}))
    sys.exit(0)
sys.stderr.write("unexpected aws call: " + " ".join(args))
sys.exit(2)
`;

interface Context {
  home: string;
  config: string;
  log: string;
  modelDir: string;
  env: NodeJS.ProcessEnv;
}

const temporaryDirectories: string[] = [];

function context(overrides: Record<string, string> = {}): Context {
  const home = mkdtempSync(join(tmpdir(), "isb-cli-home-"));
  temporaryDirectories.push(home);

  const bin = join(home, "bin");
  mkdirSync(bin);
  const aws = join(bin, "aws");
  writeFileSync(aws, FAKE_AWS);
  chmodSync(aws, 0o755);

  const modelDir = join(home, "model");
  mkdirSync(modelDir);
  for (const file of ["service-2.json", "paginators-1.json"]) {
    cpSync(join(awsCliModelDir, file), join(modelDir, file));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    AWS_CONFIG_FILE: join(home, "config"),
    PATH: `${bin}:${process.env.PATH}`,
    PYTHONDONTWRITEBYTECODE: "1",
    FAKE_AWS_LOG: join(home, "aws.log"),
    FAKE_API_URL: API_URL,
    FAKE_SSM_API_ID: API_ID,
    ...overrides,
  };
  if (!("AWS_REGION" in overrides)) delete env.AWS_REGION;
  if (!("AWS_DEFAULT_REGION" in overrides)) {
    delete env.AWS_DEFAULT_REGION;
  }
  if (!("AWS_PROFILE" in overrides)) delete env.AWS_PROFILE;

  return {
    home,
    config: env.AWS_CONFIG_FILE!,
    log: env.FAKE_AWS_LOG!,
    modelDir,
    env,
  };
}

function run(c: Context, args: string[]) {
  const hasModelSource =
    args.includes("--model-dir") || args.includes("--model-url");
  const commandArgs =
    args.includes("--uninstall") || hasModelSource
      ? args
      : [...args, "--model-dir", c.modelDir];
  const result = spawnSync("python3", [INSTALLER, ...commandArgs], {
    env: c.env,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function install(c: Context, extra: string[] = []) {
  return run(c, ["--api-url", API_URL, "--region", "us-east-1", ...extra]);
}

function readConfig(c: Context) {
  return readFileSync(c.config, "utf8");
}

function modelFile(c: Context, name: string) {
  return join(c.home, ".aws", "models", "isb", "2026-08-25", name);
}

function modelRoot(c: Context) {
  return join(c.home, ".aws", "models", "isb");
}

function installedModelDigest(directory: string) {
  const digest = createHash("sha256");
  for (const name of ["service-2.json", "paginators-1.json"]) {
    digest.update(name);
    digest.update(readFileSync(join(directory, name)));
  }
  return digest.digest("hex");
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("profile and endpoint behavior", () => {
  it("configures [default] when --profile is omitted", () => {
    const c = context();
    const result = install(c);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Example: aws isb list-lease-templates");
    const config = readConfig(c);
    expect(config).toContain("[default]\nservices = isb-cli-default");
    expect(config).toContain("# Managed by install-aws-isb-cli.py");
    expect(config).toContain(`endpoint_url = ${API_URL}`);
    expect(config).not.toContain("[profile ");
  });

  it("configures only the optional named profile", () => {
    const c = context();
    const result = install(c, ["--profile", "m2m"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Example: aws isb list-lease-templates --profile m2m",
    );
    const config = readConfig(c);
    expect(config).toContain("[profile m2m]\nservices = isb-cli-m2m");
    expect(config).not.toContain("[default]");
  });

  it("still configures default when ambient AWS_PROFILE is set", () => {
    const c = context({ AWS_PROFILE: "operator" });
    expect(install(c).status).toBe(0);

    expect(readConfig(c)).toContain("[default]");
    expect(readConfig(c)).not.toContain("[profile operator]");
  });

  it("uses ambient credentials for stack discovery, never --profile", () => {
    const c = context({ AWS_PROFILE: "operator" });
    const result = run(c, [
      "--profile",
      "m2m",
      "--client-stack",
      "Client",
      "--region",
      "us-east-1",
    ]);

    expect(result.status).toBe(0);
    const calls = readFileSync(c.log, "utf8");
    expect(calls).toContain("AWS_PROFILE=operator");
    expect(calls).toContain("cloudformation describe-stacks");
    expect(calls).toContain("ssm get-parameter");
    expect(calls).not.toContain("--profile");
    expect(calls).not.toContain("sts ");
  });

  it("uses AWS_REGION, then AWS_DEFAULT_REGION, for discovery calls", () => {
    const c = context({ AWS_DEFAULT_REGION: "us-west-2" });
    c.env.FAKE_API_URL =
      "https://94j3twtjwa.execute-api.us-west-2.amazonaws.com/prod";
    c.env.FAKE_SSM_API_ID = API_ID;

    expect(run(c, ["--client-stack", "Client"]).status).toBe(0);
    expect(readFileSync(c.log, "utf8")).toContain("--region us-west-2");
  });

  it("omits --region so the AWS CLI resolves it when nothing is explicit", () => {
    // No --region, AWS_REGION, or AWS_DEFAULT_REGION. The AWS CLI's own
    // resolution (e.g. ~/.aws/config's profile default) must apply — forcing a
    // hardcoded default would silently issue calls against the wrong region.
    const c = context();
    c.env.FAKE_API_URL =
      "https://94j3twtjwa.execute-api.eu-west-1.amazonaws.com/prod";
    c.env.FAKE_SSM_API_ID = API_ID;

    expect(run(c, ["--client-stack", "Client"]).status).toBe(0);
    const calls = readFileSync(c.log, "utf8");
    expect(calls).toContain("cloudformation describe-stacks");
    expect(calls).not.toContain("--region ");
  });

  it("derives the region from --api-url when none is set", () => {
    const c = context(); // no --region and no AWS_REGION/AWS_DEFAULT_REGION
    const url = "https://94j3twtjwa.execute-api.eu-west-1.amazonaws.com/prod";
    const result = run(c, ["--api-url", url]);

    expect(result.status).toBe(0);
    expect(readConfig(c)).toContain(`endpoint_url = ${url}`);
  });

  it("requires exactly one endpoint source", () => {
    const c = context();
    const neither = run(c, []);
    const both = run(c, ["--api-url", API_URL, "--client-stack", "Client"]);

    expect(neither.status).toBe(1);
    expect(neither.stderr).toContain("one of --api-url or --client-stack");
    expect(both.status).toBe(2);
  });

  it("rejects the removed --endpoint-url option", () => {
    const c = context();
    const result = run(c, ["--endpoint-url", API_URL]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unrecognized arguments");
  });

  it("rejects unsafe profile names before writing", () => {
    const c = context();
    const result = install(c, ["--profile", "bad\n[default]"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid profile name");
    expect(existsSync(c.config)).toBe(false);
  });
});

describe("endpoint validation", () => {
  it.each([
    ["http", "http://94j3twtjwa.execute-api.us-east-1.amazonaws.com/prod"],
    ["host", "https://94j3twtjwa.attacker.example/prod"],
    ["stage", "https://94j3twtjwa.execute-api.us-east-1.amazonaws.com/dev"],
    ["query", `${API_URL}?x=1`],
    ["region", "https://94j3twtjwa.execute-api.us-west-2.amazonaws.com/prod"],
  ])("rejects an invalid %s API URL", (_kind, apiUrl) => {
    const c = context();
    const result = run(c, ["--api-url", apiUrl, "--region", "us-east-1"]);

    expect(result.status).toBe(1);
    expect(existsSync(c.config)).toBe(false);
  });

  it("rejects a stale client-stack API", () => {
    const c = context({ FAKE_SSM_API_ID: "oldapiid00" });
    const result = run(c, [
      "--client-stack",
      "Client",
      "--region",
      "us-east-1",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/current API|redeploy/i);
  });

  it("warns and continues when no namespace is available", () => {
    const c = context({ FAKE_NAMESPACE: "" });
    const result = run(c, [
      "--client-stack",
      "Client",
      "--region",
      "us-east-1",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/warning.*could not verify/i);
    expect(readFileSync(c.log, "utf8")).not.toContain("ssm get-parameter");
  });

  it("warns and continues when SSM drift validation is unavailable", () => {
    const c = context({ FAKE_SSM_FAIL: "1" });
    const result = run(c, [
      "--client-stack",
      "Client",
      "--region",
      "us-east-1",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(
      /warning.*could not verify.*AccessDeniedException/i,
    );
  });
});

describe("config preservation and ownership", () => {
  it("clones existing services and leaves shared configuration untouched", () => {
    const c = context();
    const original = `[default]
region = us-east-1
services = shared

[profile other]
services = shared

[services shared]
s3 =
  endpoint_url = https://s3.example
`;
    writeFileSync(c.config, original);

    expect(install(c).status).toBe(0);
    const config = readConfig(c);
    expect(config).toContain("[profile other]\nservices = shared");
    expect(config).toContain(
      "[services shared]\ns3 =\n  endpoint_url = https://s3.example",
    );
    expect(config).toMatch(/\[default\][\s\S]*services = isb-cli-default/);
    expect(config).toContain("region = us-east-1");
    expect(config).toMatch(
      /\[services isb-cli-default\][\s\S]*s3 =[\s\S]*isb =/,
    );
  });

  it("clones and replaces an unowned isb entry without modifying its source", () => {
    const c = context();
    writeFileSync(
      c.config,
      `[default]
services = user

[services user]
isb =
  endpoint_url = https://old.execute-api.us-east-1.amazonaws.com/prod
`,
    );

    expect(install(c).status).toBe(0);
    const config = readConfig(c);
    expect(config).toContain(
      "endpoint_url = https://old.execute-api.us-east-1.amazonaws.com/prod",
    );
    expect(config).toContain(`endpoint_url = ${API_URL}`);
    expect(config).toContain("services = isb-cli-default");
  });

  it("rejects an obsolete suffixed managed section", () => {
    const c = context();
    const original = `[profile m2m]
services = isb-cli-m2m-deadbeef

[services isb-cli-m2m-deadbeef]
# Managed by install-aws-isb-cli.py
isb =
  endpoint_url = ${API_URL}
`;
    writeFileSync(c.config, original);

    const result = install(c, ["--profile", "m2m"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("obsolete managed section");
    expect(result.stderr).toContain("--uninstall");
    expect(readConfig(c)).toBe(original);
  });

  it("aborts when the exact managed section name already exists", () => {
    const c = context();
    const original = `[services isb-cli-m2m]
s3 =
  endpoint_url = https://s3.example
`;
    writeFileSync(c.config, original);

    const result = install(c, ["--profile", "m2m"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[services isb-cli-m2m] already exists");
    expect(readConfig(c)).toBe(original);
  });

  it("updates its marked section and is byte-idempotent", () => {
    const c = context();
    expect(install(c).status).toBe(0);
    const first = readConfig(c);
    expect(install(c).status).toBe(0);

    expect(readConfig(c)).toBe(first);
  });

  it("updates a shared managed section in place instead of erroring", () => {
    const c = context();
    expect(install(c, ["--profile", "a"]).status).toBe(0);
    // A second profile is manually pointed at profile a's managed section.
    writeFileSync(
      c.config,
      `${readConfig(c)}\n[profile b]\nservices = isb-cli-a\n`,
    );

    const result = install(c, ["--profile", "a"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("already exists");
    expect(readConfig(c)).toContain("[profile b]\nservices = isb-cli-a");
  });

  it("preserves CRLF line endings when editing", () => {
    const c = context();
    writeFileSync(c.config, "[default]\r\nregion = us-east-1\r\n");

    expect(install(c).status).toBe(0);
    const config = readConfig(c);
    expect(config).toContain("region = us-east-1\r\n");
    expect(config).toContain("\r\nservices = isb-cli-default\r\n"); // inserted line is CRLF too
    expect(config).not.toMatch(/[^\r]\n/); // no bare LF -> not mixed
  });

  it("does not create a config backup, sidecar state, or config journal", () => {
    const c = context();
    writeFileSync(c.config, "[default]\nregion = us-east-1\n");

    expect(install(c).status).toBe(0);
    const names = readdirSync(c.home);
    expect(names.some((name) => name.includes("isb-bak"))).toBe(false);
    expect(names.some((name) => name.includes("isb-cli-state"))).toBe(false);
    expect(names.some((name) => name.includes("isb-txn"))).toBe(false);
    expect(existsSync(`${c.config}.lock`)).toBe(true);
  });

  it("preserves the config file mode", () => {
    const c = context();
    writeFileSync(c.config, "[default]\nregion = us-east-1\n", {
      mode: 0o640,
    });

    expect(install(c).status).toBe(0);
    expect(statSync(c.config).mode & 0o777).toBe(0o640);
  });

  it("dry-run writes no config or model", () => {
    const c = context();
    const result = install(c, ["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(existsSync(c.config)).toBe(false);
    expect(existsSync(modelFile(c, "service-2.json"))).toBe(false);
  });
});

describe("uninstall", () => {
  it("removes an installer-created default endpoint", () => {
    const c = context();
    expect(install(c).status).toBe(0);

    const result = run(c, ["--uninstall"]);
    expect(result.status).toBe(0);
    expect(readConfig(c)).toBe("");
    expect(existsSync(modelFile(c, "service-2.json"))).toBe(true);
  });

  it("leaves cloned unrelated services configured", () => {
    const c = context();
    writeFileSync(
      c.config,
      `[default]
services = original

[services original]
s3 =
  endpoint_url = https://s3.example
`,
    );
    expect(install(c).status).toBe(0);
    expect(run(c, ["--uninstall"]).status).toBe(0);

    const config = readConfig(c);
    expect(config).toContain("endpoint_url = https://s3.example");
    expect(config).not.toContain(`endpoint_url = ${API_URL}`);
    expect(config).not.toContain("Managed by");
  });

  it("reinstalls after an uninstall that left cloned services behind", () => {
    const c = context();
    writeFileSync(
      c.config,
      `[default]
services = shared

[services shared]
s3 =
  endpoint_url = https://s3.example
`,
    );
    expect(install(c).status).toBe(0); // clones shared -> isb-cli-default (s3 + isb)
    expect(run(c, ["--uninstall"]).status).toBe(0); // drops isb + marker, keeps s3
    expect(readConfig(c)).not.toContain(`endpoint_url = ${API_URL}`);

    // Reinstall must re-adopt the now-unmanaged isb-cli-default section, not
    // dead-end with "already exists".
    const result = install(c);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("already exists");
    expect(readConfig(c)).toContain(`endpoint_url = ${API_URL}`);
    expect(readConfig(c)).toContain("endpoint_url = https://s3.example"); // clone preserved
  });

  it("refuses uninstall when another profile shares the managed section", () => {
    const c = context();
    expect(install(c, ["--profile", "m2m"]).status).toBe(0);
    const original = `${readConfig(c)}
[profile other]
services = isb-cli-m2m
`;
    writeFileSync(c.config, original);

    const result = run(c, ["--uninstall", "--profile", "m2m"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("also referenced by profile(s) other");
    expect(readConfig(c)).toBe(original);
  });

  it("refuses to uninstall an unmarked user endpoint", () => {
    const c = context();
    writeFileSync(
      c.config,
      `[default]
services = user

[services user]
isb =
  endpoint_url = ${API_URL}
`,
    );

    const result = run(c, ["--uninstall"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not managed");
    expect(readConfig(c)).toContain(`endpoint_url = ${API_URL}`);
  });

  it("requires confirmation before purging all global model versions", () => {
    const c = context();
    expect(install(c).status).toBe(0);

    expect(run(c, ["--uninstall", "--purge-model"]).status).toBe(1);
    expect(existsSync(modelFile(c, "service-2.json"))).toBe(true);

    // Endpoint present + purge: both actions happen and both are reported.
    const result = run(c, ["--uninstall", "--purge-model", "--yes"]);
    expect(result.status).toBe(0);
    expect(existsSync(modelFile(c, "service-2.json"))).toBe(false);
    expect(result.stdout).toContain("Removed the `isb` endpoint");
    expect(result.stdout).toContain("Purged the global ISB model.");
  });

  it("still purges the global model when the profile has no endpoint", () => {
    const c = context();
    expect(install(c).status).toBe(0);
    // Remove the endpoint first; the model stays installed globally.
    expect(run(c, ["--uninstall"]).status).toBe(0);
    expect(existsSync(modelFile(c, "service-2.json"))).toBe(true);

    // A follow-up purge must not abort on the now-missing endpoint.
    const result = run(c, ["--uninstall", "--purge-model", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("no configured `isb` endpoint");
    expect(existsSync(modelFile(c, "service-2.json"))).toBe(false);
  });
});

describe("model integrity", () => {
  it("installs both model files", () => {
    const c = context();
    expect(install(c).status).toBe(0);

    expect(existsSync(modelFile(c, "service-2.json"))).toBe(true);
    expect(existsSync(modelFile(c, "paginators-1.json"))).toBe(true);
  });

  it("rejects an old AWS CLI", () => {
    const c = context({
      FAKE_AWS_VERSION: "aws-cli/2.11.0 Python/3.11 Linux",
    });
    const result = install(c);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("2.13.0");
    expect(existsSync(c.config)).toBe(false);
  });

  it("rejects a non-https model URL before downloading", () => {
    const c = context();
    const result = run(c, [
      "--api-url",
      API_URL,
      "--region",
      "us-east-1",
      "--model-url",
      "http://models.example/isb",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--model-url must be https");
  });

  it("downloads an HTTPS model file through the guarded opener", () => {
    const c = context();
    const destination = join(c.home, "downloaded-model.json");
    const program = `
import io
import sys

import model_installer

class Response(io.BytesIO):
    url = "https://models.example/service-2.json"

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

class Opener:
    def open(self, url, timeout):
        if url != Response.url:
            raise SystemExit("unexpected URL")
        if timeout != model_installer.DOWNLOAD_TIMEOUT:
            raise SystemExit("unexpected timeout")
        return Response(b'{"model": true}')

model_installer.urllib.request.build_opener = lambda *args: Opener()
model_installer._download(Response.url, sys.argv[1])
`;
    const result = spawnSync("python3", ["-c", program, destination], {
      env: {
        ...c.env,
        PYTHONPATH: dirname(INSTALLER),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(destination, "utf8")).toBe('{"model": true}');
  });

  it("rejects a model download redirect to HTTP", () => {
    const c = context();
    const program = `
from model_installer import _HttpsOnlyRedirect
from installer_common import InstallerError

try:
    _HttpsOnlyRedirect().redirect_request(
        None, None, 302, "redirect", {}, "http://models.example/model"
    )
except InstallerError:
    raise SystemExit(0)
raise SystemExit(1)
`;
    const result = spawnSync("python3", ["-c", program], {
      env: {
        ...c.env,
        PYTHONPATH: dirname(INSTALLER),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  it("completes a valid staged model transaction forward", () => {
    const c = context();
    expect(install(c).status).toBe(0);
    const destination = join(modelRoot(c), "2026-08-25");
    const staged = join(modelRoot(c), ".staging-recovery");
    renameSync(destination, staged);
    writeFileSync(
      join(modelRoot(c), ".model-txn.json"),
      JSON.stringify({
        dest: destination,
        staged,
        new_sha: installedModelDigest(staged),
      }),
    );

    expect(install(c).status).toBe(0);
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(join(modelRoot(c), ".model-txn.json"))).toBe(false);
  });

  it("keeps an already-installed new model and clears its marker", () => {
    const c = context();
    expect(install(c).status).toBe(0);
    const destination = join(modelRoot(c), "2026-08-25");
    writeFileSync(
      join(modelRoot(c), ".model-txn.json"),
      JSON.stringify({
        dest: destination,
        staged: join(modelRoot(c), ".staging-already-finished"),
        new_sha: installedModelDigest(destination),
      }),
    );

    expect(install(c).status).toBe(0);
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(join(modelRoot(c), ".model-txn.json"))).toBe(false);
  });

  it("fails closed on an unsafe model transaction marker", () => {
    const c = context();
    expect(install(c).status).toBe(0);
    const destination = join(modelRoot(c), "2026-08-25");
    const originalConfig = readConfig(c);
    writeFileSync(
      join(modelRoot(c), ".model-txn.json"),
      JSON.stringify({
        dest: destination,
        staged: "/tmp/escaped-model-stage",
        new_sha: installedModelDigest(destination),
      }),
    );

    const result = install(c);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe values");
    expect(readConfig(c)).toBe(originalConfig);
    expect(existsSync(join(modelRoot(c), ".model-txn.json"))).toBe(true);
  });

  it("restores the prior model when a directory swap fails", () => {
    const c = context();
    const program = `
import os
from pathlib import Path

import model_installer

root = model_installer.models_root()
root.mkdir(parents=True)
destination = root / "2026-08-25"
staged = root / ".staging-test"
destination.mkdir()
staged.mkdir()
(destination / "old").write_text("old")
(staged / "new").write_text("new")

real_replace = os.replace
calls = 0

def fail_new_model(source, target):
    global calls
    calls += 1
    if calls == 2:
        raise OSError("simulated swap failure")
    return real_replace(source, target)

model_installer.os.replace = fail_new_model
try:
    model_installer._replace_directory(destination, staged)
except OSError:
    pass
else:
    raise SystemExit("swap unexpectedly succeeded")

if not (destination / "old").is_file():
    raise SystemExit("old model was not restored")
if not staged.is_dir():
    raise SystemExit("staged model was unexpectedly removed")
`;
    const result = spawnSync("python3", ["-c", program], {
      env: {
        ...c.env,
        PYTHONPATH: dirname(INSTALLER),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  it("rejects a non-date model apiVersion", () => {
    const c = context();
    const path = join(c.modelDir, "service-2.json");
    const model = JSON.parse(readFileSync(path, "utf8"));
    model.metadata.apiVersion = "../escape";
    writeFileSync(path, JSON.stringify(model));

    const result = install(c);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not YYYY-MM-DD");
    expect(existsSync(c.config)).toBe(false);
  });
});
