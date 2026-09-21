# `aws isb` CLI model and installer

This folder installs the generated AWS CLI model and persists the
deployment-specific API Gateway endpoint. After installation, callers can use
normal AWS CLI credential resolution:

```bash
aws isb list-lease-templates
```

The installer uses only the Python 3 standard library and AWS CLI v2.13.0 or
later.

## TL;DR

End-to-end setup for a named M2M profile — assume the role (credentials), install
the endpoint, then call the API. Run from the repo root:

```bash
# 1. Assume the M2M role and write its credentials to a named profile.
#    (Example uses the client stack InnovationSandbox-M2mClient-Admin-example,
#     which yields the default profile isb-m2m-example.)
./scripts/m2m/assume-m2m-role.sh \
  --client-stack InnovationSandbox-M2mClient-Admin-example \
  --output profile
# -> Credentials written to profile [isb-m2m-example]
#    Use with: --profile isb-m2m-example

# 2. Install the model and configure the `aws isb` endpoint for that profile.
./scripts/m2m/aws-cli/install-aws-isb-cli.py \
  --profile isb-m2m-example \
  --client-stack InnovationSandbox-M2mClient-Admin-example \
  --region us-east-1
# -> Configured `aws isb --profile isb-m2m-example` -> https://<api-id>.execute-api.us-east-1.amazonaws.com/prod

# 3. Call the API.
aws isb list-lease-templates --profile isb-m2m-example
```

Omit `--profile` from the installer to configure the `[default]` profile instead
(for use with ambient/default credentials). The rest of this document explains
each step.

## How it works

The deployment-agnostic C2J model consists of:

- `service-2.json`, which defines operations, shapes, help descriptions, and
  SigV4 metadata;
- `paginators-1.json`, which enables AWS CLI auto-pagination.

Both files are installed under:

```text
~/.aws/models/isb/<apiVersion>/
```

The deployment endpoint remains outside the model. The installer writes a
profile-scoped AWS CLI services section:

```ini
[default]
services = isb-cli-default

[services isb-cli-default]
# Managed by install-aws-isb-cli.py
isb =
  endpoint_url = https://<api-id>.execute-api.us-east-1.amazonaws.com/prod
```

`aws configure set` cannot produce this structure. Its dotted-key model only
addresses keys **inside a profile** (`aws configure set <key> --profile <p>`),
so `aws configure set services.<name>.<svc>.endpoint_url <url>` doesn't create a
separate top-level `[services <name>]` section with a nested `<svc> = /
endpoint_url = …` block — it just collapses the whole dotted key into a
one-line `services = <url>` value under the profile (verified against AWS CLI
v2.33.x). That is a malformed pointer: the `services` key names a section, it
does not hold a URL. The installer therefore edits the file directly.

## Credentials and profiles

Endpoint discovery uses ambient AWS credentials: environment credentials,
`AWS_PROFILE`, the default profile, container or instance credentials, and the
rest of the normal AWS CLI provider chain. The installer never passes
`--profile` to its CloudFormation or SSM discovery calls.

The installer's optional `--profile` has one purpose: selecting which profile's
`services` pointer to write.

- No `--profile`: configure `[default]`.
- `--profile <name>`: configure `[profile <name>]`; the name is supplied by the operator and has no `m2m` default.

AWS CLI services pointers are profile-scoped. A named profile does not read the
pointer from `[default]`.

## Install

Resolve the endpoint from an M2M client stack:

```bash
./scripts/m2m/aws-cli/install-aws-isb-cli.py \
  --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline \
  --region us-east-1

aws isb list-lease-templates
```

Configure a named M2M profile:

```bash
./scripts/m2m/aws-cli/install-aws-isb-cli.py \
  --profile isb-m2m-deploy-pipeline \
  --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline \
  --region us-east-1

aws isb list-lease-templates --profile isb-m2m-deploy-pipeline
```

The named profile selects the eventual API caller. Stack and SSM discovery
still use ambient operator credentials. If those credentials cannot read
CloudFormation or SSM, provide the endpoint directly:

```bash
./scripts/m2m/aws-cli/install-aws-isb-cli.py \
  --profile isb-m2m-deploy-pipeline \
  --api-url https://<api-id>.execute-api.us-east-1.amazonaws.com/prod \
  --region us-east-1
```

Exactly one of `--client-stack` and `--api-url` is required.

Region resolves in this order:

1. `--region`;
2. `AWS_REGION`;
3. `AWS_DEFAULT_REGION`;
4. the AWS CLI's own resolution (e.g. the profile default in `~/.aws/config`).

The installer never falls back to a hardcoded region. If none of the above
supplies one, the AWS CLI's default-region error surfaces from the discovery
call itself.

Client-stack drift validation is best-effort. A confirmed mismatch with the
Compute RestApi ID fails installation. Missing namespace or SSM read access
emits a warning and continues with the validated client-stack URL.

`--dry-run` makes no persistent changes, but still performs endpoint discovery
and downloads `--model-url` files to a temporary directory so every input can
be validated. The temporary download is removed before exit.

## Config editing

The installer performs one locked, atomic replacement of the AWS config file.
It does not create a backup, sidecar ownership file, or config transaction
journal. The conventional `${AWS_CONFIG_FILE}.lock` flock file remains beside
the config; it contains no state and must not be deleted while an installer may
be running.

To avoid modifying user-owned services sections, the installer creates
`[services isb-cli-<profile>]` for the selected profile. If that profile
already uses other service endpoints, their configuration is cloned and the
original is left unchanged. If the exact managed section name already exists
unexpectedly, installation aborts with a cleanup message instead of choosing
an opaque suffix. Reruns update the selected marked section in place.

Uninstall removes only an `isb` endpoint from an exclusively referenced
marked section. If another profile was manually pointed at that section,
uninstall aborts rather than changing the other profile's endpoint. When cloned
unrelated services remain, the selected profile stays pointed at that private
section after the marker and `isb` entry are removed.

The model installation is global rather than profile-specific. It retains a
lock, atomic directory replacement, and forward recovery for interrupted model
replacement.

## Flags

| Flag                    | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `--profile <name>`      | Config profile whose services pointer is written; default is `[default]`.   |
| `--api-url <url>`       | Canonical HTTPS API Gateway URL ending in `/prod`.                          |
| `--client-stack <name>` | Resolve `ApiGatewayUrl` with ambient credentials.                           |
| `--namespace <name>`    | Namespace for the current-RestApi SSM check; otherwise read from the stack. |
| `--region <region>`     | Discovery and endpoint-validation region.                                   |
| `--model-dir <dir>`     | Directory containing `service-2.json` and `paginators-1.json`.              |
| `--model-url <url>`     | HTTPS base URL to download the model files from (https only).               |
| `--force`               | Replace differing installed model files.                                    |
| `--uninstall`           | Remove the marked endpoint for the selected/default profile.                |
| `--purge-model --yes`   | Also remove every globally installed ISB model version.                     |
| `--dry-run`             | Print intended changes without writing.                                     |

## Pagination

Modeled list operations auto-paginate. `--page-size` controls each request and
`--max-items` caps total output:

```bash
aws isb list-lease-templates --page-size 20 --max-items 100
```

## Manual fallback

Copy both model files. `aws configure add-model` installs only the service model
and omits paginators:

```bash
mkdir -p ~/.aws/models/isb/<apiVersion>/
cp docs/aws-cli-model/service-2.json docs/aws-cli-model/paginators-1.json ~/.aws/models/isb/<apiVersion>/
```

Then pass `--endpoint-url` to each command or add the profile-scoped services
configuration manually.

## Testing

The tests use temporary homes/configs and a fake AWS executable:

```bash
npm test --workspace @amzn/innovation-sandbox-api-model -- \
  --run test/install-aws-isb-cli.test.ts
```

## Distribution files

The installer is modular. Any standalone onboarding bundle must keep these
files together:

- `install-aws-isb-cli.py`
- `installer_common.py`
- `endpoint_resolver.py`
- `aws_config_editor.py`
- `model_installer.py`
- `service-2.json`
- `paginators-1.json`

The source archive already preserves this layout. Any standalone S3 onboarding
bundle must stage all five Python files together with the model files.
