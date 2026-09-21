// Smithy compatibility verification: diff the current model against an explicit
// reference tip and reject incompatible changes lacking an exact, dated
// exception.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  gradleCommand,
  saveBrazilMutatedFiles,
  usesBrazilGradle,
} from "./gradle.mjs";
import { onExit } from "./lifecycle.mjs";
import { modelDir, repoRoot } from "./paths.mjs";
import { requireSuccess, run, text } from "./subprocess.mjs";

const modelPath = "source/api-model/src/main/smithy";
const exceptionsPath = join(
  modelDir,
  "scripts",
  "compatibility-exceptions.json",
);
const csvHeader =
  "severity,id,shape,file,line,column,message,hint,suppressionReason";

/** Converts an explicit branch or tag into safe remote and local refs. */
export function normalizeReference(value) {
  const input = value?.trim();
  if (!input) {
    throw new Error(
      "compatibility verification requires --reference <branch-or-tag>",
    );
  }

  const kind = input.startsWith("refs/tags/") ? "tag" : "branch";
  const name =
    kind === "tag"
      ? input.replace(/^refs\/tags\//, "")
      : input
          .replace(/^refs\/heads\//, "")
          .replace(/^refs\/remotes\/origin\//, "")
          .replace(/^origin\//, "");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ||
    name.startsWith("refs/") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name.endsWith("/") ||
    name.endsWith(".")
  ) {
    throw new Error(`invalid reference: ${value}`);
  }

  const remoteRef = kind === "tag" ? `refs/tags/${name}` : `refs/heads/${name}`;
  const localRef = kind === "tag" ? remoteRef : `refs/remotes/origin/${name}`;
  return { kind, name, remoteRef, localRef };
}

/** Parses RFC 4180-style CSV emitted by `smithy diff --format csv`. */
export function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("unterminated quoted field in Smithy CSV");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

/** Extracts structured validation events from otherwise quiet Gradle output. */
export function parseDiffEvents(output) {
  const start = output.indexOf(csvHeader);
  if (start < 0) {
    throw new Error("Smithy diff did not emit its CSV header");
  }
  // Parse the complete CSV stream so quoted fields may contain newlines.
  // Gradle appends human-readable output after the CSV; rows whose first field
  // is not a Smithy severity are ignored after parsing.
  const rows = parseCsv(output.slice(start));
  if (rows[0]?.join(",") !== csvHeader) {
    throw new Error("unexpected Smithy diff CSV header");
  }
  const severities = new Set(["NOTE", "WARNING", "DANGER", "ERROR"]);
  return rows.slice(1).flatMap((row) => {
    if (!severities.has(row[0])) return [];
    if (row.length !== 9) {
      throw new Error(
        `unexpected Smithy diff CSV row with ${row.length} fields`,
      );
    }
    return [
      {
        severity: row[0],
        id: row[1],
        shape: row[2],
        file: row[3],
        line: Number(row[4]),
        column: Number(row[5]),
        message: row[6],
        hint: row[7],
        suppressionReason: row[8],
      },
    ];
  });
}

/** Loads exact, dated compatibility exceptions and rejects stale entries. */
export function loadExceptions(file = exceptionsPath, now = new Date()) {
  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read compatibility exceptions: ${error.message}`,
    );
  }
  if (
    !document ||
    !Array.isArray(document.exceptions) ||
    Object.keys(document).some((key) => key !== "exceptions")
  ) {
    throw new Error(
      "compatibility exceptions must contain only an exceptions array",
    );
  }

  const today = now.toISOString().slice(0, 10);
  const seen = new Set();
  for (const exception of document.exceptions) {
    const keys = Object.keys(exception)
      .sort((a, b) => a.localeCompare(b))
      .join(",");
    if (keys !== "expires,id,reason,shape") {
      throw new Error(
        "each compatibility exception requires exactly id, shape, reason, expires",
      );
    }
    const expiry = new Date(`${exception.expires}T00:00:00Z`);
    if (
      typeof exception.id !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.]*$/.test(exception.id) ||
      typeof exception.shape !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_.]*#[A-Za-z_][A-Za-z0-9_$]*$/.test(
        exception.shape,
      ) ||
      typeof exception.reason !== "string" ||
      exception.reason.trim().length < 10 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires) ||
      Number.isNaN(expiry.valueOf()) ||
      expiry.toISOString().slice(0, 10) !== exception.expires
    ) {
      throw new Error(
        "compatibility exception fields are invalid or too broad",
      );
    }
    if (exception.expires < today) {
      throw new Error(
        `compatibility exception ${exception.id} / ${exception.shape} ` +
          `expired on ${exception.expires}`,
      );
    }
    const key = `${exception.id}\0${exception.shape}`;
    if (seen.has(key)) {
      throw new Error(`duplicate compatibility exception for ${exception.id}`);
    }
    seen.add(key);
  }
  return document.exceptions;
}

/**
 * Applies exact exceptions to incompatible events. Unused exceptions fail so
 * temporary approvals cannot remain after the underlying event disappears.
 */
export function evaluateCompatibility(events, exceptions) {
  const incompatible = events.filter((event) =>
    ["DANGER", "ERROR"].includes(event.severity),
  );
  const used = new Set();
  const blocked = [];
  for (const event of incompatible) {
    const index = exceptions.findIndex(
      (exception) =>
        exception.id === event.id && exception.shape === event.shape,
    );
    if (index < 0) blocked.push(event);
    else used.add(index);
  }
  const unused = exceptions.filter((_, index) => !used.has(index));
  return { incompatible, blocked, unused };
}

function materializeModel({ runner, cwd, ref, files, destination }) {
  for (const path of files) {
    if (!path.startsWith(`${modelPath}/`)) {
      throw new Error(`destination model path escaped its root: ${path}`);
    }
    const result = run(runner, "git", ["show", `${ref}:${path}`], {
      cwd,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    });
    requireSuccess(result, `materializing ${path} from ${ref}`);
    const target = join(destination, relative(modelPath, path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, result.stdout);
  }
}

export function verifyCompatibility(options = {}) {
  const cwd = options.repoRoot ?? repoRoot;
  const root = options.modelDir ?? modelDir;
  const runner = options.runner ?? spawnSync;
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const registerExit = options.onExit ?? onExit;
  const reference = normalizeReference(options.reference);
  const ref = reference.localRef;

  const fetch = run(
    runner,
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+${reference.remoteRef}:${reference.localRef}`,
    ],
    { cwd, encoding: "utf8" },
  );
  requireSuccess(fetch, `fetching reference ${reference.remoteRef}`);

  const ancestor = run(
    runner,
    "git",
    ["merge-base", "--is-ancestor", ref, "HEAD"],
    { cwd, encoding: "utf8" },
  );
  if (ancestor.status === 1) {
    throw new Error(
      `${ref} is not an ancestor of HEAD; sync with the current reference ` +
        "before running compatibility checks",
    );
  }
  requireSuccess(ancestor, "checking reference ancestry");

  const listing = run(
    runner,
    "git",
    ["ls-tree", "-r", "--name-only", ref, "--", modelPath],
    { cwd, encoding: "utf8" },
  );
  requireSuccess(listing, `reading model paths from ${ref}`);
  const files = text(listing.stdout).split(/\r?\n/).filter(Boolean);
  if (files.length === 0) {
    log(`api-model: no prior model baseline at exact reference tip ${ref}`);
    return { reference, ref, skipped: true, events: [] };
  }

  const temporary = mkdtempSync(join(tmpdir(), "isb-smithy-baseline-"));
  const oldModel = join(temporary, "model");
  const restoreMutated = usesBrazilGradle(env)
    ? saveBrazilMutatedFiles(root)
    : null;
  const cleanup = restoreMutated ? registerExit(restoreMutated) : () => {};
  try {
    materializeModel({
      runner,
      cwd,
      ref,
      files,
      destination: oldModel,
    });
    const gradle = run(
      runner,
      gradleCommand(env),
      [
        "-q",
        "smithyDiff",
        `-PoldModel=${oldModel}`,
        `-PnewModel=${join(root, "src/main/smithy")}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    requireSuccess(gradle, "running pinned Smithy compatibility diff");
    const stdout = text(gradle.stdout);
    const stderr = text(gradle.stderr);
    const diffOutput = `${stdout}\n${stderr}`;
    if (!diffOutput.includes(csvHeader)) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      throw new Error(
        "Smithy compatibility diff failed before producing CSV" +
          (detail ? `:\n${detail}` : ""),
      );
    }
    const events = parseDiffEvents(diffOutput);
    const exceptions = loadExceptions(
      options.exceptionsPath ??
        join(root, "scripts", "compatibility-exceptions.json"),
      options.now,
    );
    const result = evaluateCompatibility(events, exceptions);
    if (result.unused.length > 0) {
      throw new Error(
        "unused compatibility exceptions must be removed: " +
          result.unused.map((item) => `${item.id} / ${item.shape}`).join(", "),
      );
    }
    if (result.blocked.length > 0) {
      throw new Error(
        "incompatible Smithy changes require an exact, expiring exception:\n" +
          result.blocked
            .map(
              (event) =>
                `- ${event.severity} ${event.id} ${event.shape}: ${event.message}`,
            )
            .join("\n"),
      );
    }
    log(
      `api-model: compatibility passed against exact reference tip ${ref}` +
        (result.incompatible.length
          ? ` (${result.incompatible.length} excepted event(s))`
          : ""),
    );
    return { reference, ref, skipped: false, events, ...result };
  } finally {
    cleanup();
    rmSync(temporary, { recursive: true, force: true });
  }
}
