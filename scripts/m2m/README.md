# M2M Authentication — SigV4 with Per-Client IAM Roles

## Contents

- [TL;DR](#tldr)
- [Concepts](#concepts-quick-reference)
- [Operations](#operations)
- [Scripts](#scripts)
- Reference
  - [`deploy-client.sh`](#deploy-clientsh)
  - [Discovery via tags](#discovery-via-tags)
  - [`assume-m2m-role`](#assume-m2m-role)
  - [`call-api`](#call-api)
  - [`smoke-test`](#smoke-test)
  - [`list-clients`](#list-clients)
  - [`revoke-m2m-role`](#revoke-m2m-role)
- [How It Works](#how-it-works)

Machine-to-machine (M2M) clients call the ISB API by assuming an IAM role (one role per client) and signing requests with SigV4.

## TL;DR

Two AWS accounts are involved (often — they CAN be the same account for testing or local automation):

- **Hub account** — where the ISB Compute / Data stacks live. The M2M client stack is also deployed here; it creates the role that calls the API.
- **Client account** — where the automation runs. Holds a "bootstrap" principal (an IAM role, IAM user, or just the root account number) trusted by the M2M role. That principal needs `sts:AssumeRole` permission targeting the M2M role's ARN.

Three commands:

```bash
# (1) ON THE HUB ACCOUNT — create a client stack. This deploys an IAM role
#     that trusts <trusted-principal> (a principal in the client account).
./scripts/m2m/deploy-client.sh \
  --namespace myisb \
  --client-name deploy-pipeline \
  --role Admin \
  --trusted-principal arn:aws:iam::123456789012:role/codebuild-deploy-pipeline
  # (or --trusted-principal 123456789012 to trust the whole client account)
# Note the M2MRoleArn + M2MExternalId outputs that print at the end —
# step (2) needs them when running cross-account.

# (2) ON THE CLIENT ACCOUNT (as the trusted principal) — assume the M2M role
#     and write its short-lived creds to a separate AWS profile.
#     The trusted principal must have an IAM policy allowing
#     sts:AssumeRole on the M2M role ARN; the script doesn't grant it.
#
#     SAME-ACCOUNT (hub == client): describe-stacks works, so just point at
#     the stack and let the script resolve the role ARN + ExternalId.
./scripts/m2m/assume-m2m-role.sh \
  --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline \
  --output profile
#
#     CROSS-ACCOUNT: the client account can't read the hub account's stack,
#     so pass the role ARN + ExternalId explicitly (copy them from the
#     deploy-client.sh output above, or from the hub-account CFN console).
./scripts/m2m/assume-m2m-role.sh \
  --role-arn arn:aws:iam::111111111111:role/myisb-isb-m2m-admin-deploy-pipeline \
  --external-id <copy-from-stack-output> \
  --output profile \
  --write-profile isb-m2m-deploy-pipeline
# → "Credentials written to profile [isb-m2m-deploy-pipeline]"

# (3) Call the API using that profile.
#     Same-account: --client-stack works (describe-stacks resolves the API URL).
#     Cross-account: pass --api-url instead (also from the deploy output).
./scripts/m2m/call-api.sh \
  --path /leases \
  --api-url https://abc123.execute-api.us-east-1.amazonaws.com/prod \
  --profile isb-m2m-deploy-pipeline
```

That's the whole flow. Read on for the details of each command, troubleshooting, and incident response.

**Step (1) without the script.** If you don't have the source repo on the hub-account host, you can deploy the M2M client stack from the published template directly via the CloudFormation console or AWS CLI. The template is hosted at:

```
https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-M2mClient.template
```

Pass the same parameters (`Namespace`, `ClientName`, `Role`, `TrustedPrincipal`, `RestApiId`) and use the same stack name (`<stackPrefix>-M2mClient-<Role>-<clientName>`) so the discovery scripts find it. Steps (2) and (3) are unchanged.

## Concepts (quick reference)

**Per-client stack.** One CFN stack per automation client. Stack name `<stackPrefix>-M2mClient-<Role>-<clientName>` (e.g. `InnovationSandbox-M2mClient-Admin-deploy-pipeline`). The IAM role inside the stack is named `<namespace>-isb-m2m-<role>-<clientName>` (lowercased role) — the middleware uses this shape to recognize M2M callers.

**TrustedPrincipal.** Who's allowed to assume the role:
- IAM ARN — pins to a specific principal (e.g. `arn:aws:iam::123:role/codebuild-pipeline`)
- 12-digit account ID — trusts any principal in that account with `sts:AssumeRole` permission (looser; gated by per-client ExternalId)

**Two profiles, two purposes.** Don't confuse the two:
- **Source profile** = creds that match the `TrustedPrincipal`. Used to call `sts:AssumeRole`. Pass via `--profile` to `assume-m2m-role.sh`, or rely on the default chain (env vars / `AWS_PROFILE` / IMDS / SSO).
- **Assumed-role profile** = the M2M role's short-lived creds. Written by `assume-m2m-role.sh --output profile` (defaults to `isb-m2m-<clientName>`). Used to call the API via `call-api.sh --profile <name>`. Never assume into the `default` profile (the script refuses).

**Discovery is tag-based.** `list-clients.sh` and `revoke-m2m-role.sh deny-all` query IAM directly (not `resourcegroupstaggingapi`, which lags) for roles tagged `aws-solutions:isb-stack-type=M2mClient`.

**Cleanup.** `cdk destroy <client-stack>` (or `aws cloudformation delete-stack`) — there's nothing else to clean up.

## Operations

### Why trust is parameter-driven

`TrustedPrincipal` is a deploy-time CFN parameter — the trust policy is fully specified before the role exists. The alternative (deploy with a placeholder, then narrow via `aws iam update-assume-role-policy` post-deploy) creates a window where the role trusts something it shouldn't, and the trust policy lives outside the stack template — diverged from version control and not reverted on `cloudformation rollback` / stack-set-update. The CFN parameter approach keeps the trust policy declarative, version-controlled, and rolled back automatically with the stack.

### Rotating an ExternalId

The ExternalId is generated by the stack at create time (`AWS::CloudFormation::StackId` UUID suffix) and is immutable for the life of the stack. The rotation procedure below tears the stack down and redeploys; **redeploy parameters MUST match the original** (especially `--namespace`, `--client-name`, `--role`) so the role-name shape — `<namespace>-isb-m2m-<role>-<clientName>` — is unchanged and the middleware regex still recognizes the role as M2M.

```bash
# Substitute your stackPrefix, namespace, role, and client name throughout.
STACK="${STACK_PREFIX:-InnovationSandbox}-M2mClient-Admin-deploy-pipeline"

# (1) Tear down the client stack — destroys the IAM role too.
aws cloudformation delete-stack --stack-name "$STACK"

# (2) Wait for deletion to complete.
aws cloudformation wait stack-delete-complete --stack-name "$STACK"

# (3) Redeploy with the same Namespace, ClientName, Role parameters as before.
./scripts/m2m/deploy-client.sh --namespace myisb \
  --client-name deploy-pipeline --role Admin \
  --trusted-principal arn:aws:iam::123456789012:role/codebuild-deploy-pipeline

# (4) Read the new ExternalId from the redeployed stack outputs.
aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`M2MExternalId`].OutputValue' \
  --output text
```

After rotation, in-flight assumed-role sessions immediately stop working — STS sessions are bound to the role's IAM `RoleId` (not just its name), and the deleted role's RoleId is gone. Re-run `assume-m2m-role.sh` after step (4) to pick up the new ExternalId. Any profiles previously written by `--output profile` will fail with `AccessDenied` until that re-run.

If you need an immediate cut-off WITHOUT destroying and recreating the role (e.g. suspected credential leak, want to keep the trust policy intact), use `revoke-m2m-role.sh --action revoke-sessions` instead — that invalidates existing sessions while keeping new AssumeRole calls valid.

## Scripts

| Script | Purpose |
|--------|---------|
| `deploy-client.sh` | Deploy one client stack |
| `assume-m2m-role.sh` | Assume the client role; output creds as JSON / `export` / profile |
| `call-api.sh` | Sign and send an API request with existing credentials |
| `smoke-test.sh` | Verify one client's RBAC end-to-end |
| `list-clients.sh` | List deployed clients (table or JSON) |
| `revoke-m2m-role.sh` | Incident response — deny / restore client access without destroying the stack |
| `_common.sh` | Sourced helpers; not executed directly |

Every script accepts `--verbose` / `-v` to print AWS calls and resolved values to stderr (credentials and signed headers are never printed). Use it as the first debugging step.

---

# Reference

The rest of this document goes into details: each script's flags, the deploy alternatives (in-tree vs. out-of-tree, raw `cdk deploy`), tag schema, and incident-response actions.

## deploy-client.sh

Deploys one client stack. Two modes:

**In-tree** (developers — synthesizes from the source checkout):

```bash
./scripts/m2m/deploy-client.sh \
  --namespace myisb \
  --client-name deploy-pipeline \
  --role Admin \
  --trusted-principal arn:aws:iam::123456789012:role/codebuild-deploy-pipeline
```

**With a pre-built template** (skips the in-tree CDK synth — useful when you have a template artifact handy and don't want the build cost):

```bash
./scripts/m2m/deploy-client.sh \
  --template ./isb-m2m-client.template.json \
  --namespace myisb --client-name qa-bot --role Manager \
  --trusted-principal arn:aws:iam::123456789012:role/qa-runner
```

`aws cloudformation deploy` only accepts a local file (no `--template-url`), so the script does too. For an S3 or HTTPS template, fetch it first:

```bash
aws s3 cp s3://my-bucket/isb-m2m-client.template.json ./template.json
```

**Raw `cdk deploy`** if you want full control. Name the stack `<stackPrefix>-M2mClient-<Role>-<clientName>` so discovery finds it, and pass `RestApiId` from the Compute stack's SSM export:

```bash
REST_API_ID=$(aws ssm get-parameter \
  --name "InnovationSandbox_myisb_Compute_RestApiId" \
  --query Parameter.Value --output text)

cdk deploy IsbM2mClient \
  --parameters Namespace=myisb \
  --parameters ClientName=deploy-pipeline \
  --parameters Role=Admin \
  --parameters TrustedPrincipal=arn:aws:iam::123456789012:role/codebuild-deploy-pipeline \
  --parameters RestApiId="$REST_API_ID"
```

`--max-session-duration` accepts 3600-43200 seconds (default 3600 / 1 hour). Use `--stack-prefix MyIsb` (or `STACK_PREFIX` env var) if your deployment uses a non-default prefix.

## Discovery via tags

The `IsbM2mClient` template tags the IAM role with three CDK-emitted tags. `list-clients.sh` and `revoke-m2m-role.sh deny-all/restore-all` query IAM directly for roles whose name contains `isb-m2m-`, then filter:

| Tag | Value | Purpose |
|-----|-------|---------|
| `aws-solutions:isb-stack-type` | `M2mClient` | Identifies an M2M client role |
| `aws-solutions:isb-stack-name` | `<stackName>` | Resolves the role to its owning stack (CFN doesn't auto-tag IAM roles with `aws:cloudformation:stack-name`) |
| `aws-solutions:isb-id` | `<namespace>_isb` | Scopes to one ISB deployment |

Why IAM-direct, not `resourcegroupstaggingapi`:
- **Strong consistency.** `resourcegroupstaggingapi` is eventually consistent for IAM (lags minutes to hours). `iam:list-role-tags` is strongly consistent.
- **Deploy-path independence.** Resource-level tags always land in the template, so they survive every deploy path (`cdk deploy`, `aws cloudformation deploy`, console). Stack-level tags via the CDK manifest don't.

## assume-m2m-role

Assumes one client's M2M role and outputs temporary credentials.

The source credentials need permission to call `sts:AssumeRole` on the client role and must match the client stack's `TrustedPrincipal`. In order of preference: compute-attached role (EC2 / ECS / Lambda / CodeBuild — automatic, no keys), IAM Roles Anywhere (X.509 from on-prem), or a minimal IAM user with `sts:AssumeRole` only.

### Output Modes (`--output`, `-o`)

| Mode | Behavior |
|------|----------|
| `json` (default) | Prints credentials as JSON to stdout |
| `export` | Prints shell `export` statements — use with `source <(...)` or `eval $(...)` |
| `profile` | Writes credentials to `~/.aws/credentials` under a named profile |

### Examples

```bash
# JSON output (default) — parse with jq
./scripts/m2m/assume-m2m-role.sh --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline

# Source profile that has sts:AssumeRole permission (the trusted principal)
./scripts/m2m/assume-m2m-role.sh \
  --client-stack <stack> \
  --profile my-corp-sso

# Export to environment (NB: leaks creds into your shell — prefer --write-profile)
source <(./scripts/m2m/assume-m2m-role.sh --client-stack <stack> -o export)

# Write to a named profile (does NOT touch your default profile or env)
./scripts/m2m/assume-m2m-role.sh \
  --client-stack <stack> \
  --profile my-corp-sso \
  --output profile \
  --write-profile isb-m2m-deploy-pipeline

# Explicit role + ExternalId (no CloudFormation lookup), with explicit source profile
./scripts/m2m/assume-m2m-role.sh \
  --profile my-corp-sso \
  --role-arn arn:aws:iam::123:role/myisb-isb-m2m-admin-deploy-pipeline \
  --external-id <id-from-stack-output>
```

### Source-Credential Resolution

The script needs credentials to call `sts:AssumeRole`. Resolution order:

1. `--profile <name>` — explicit AWS profile (highest priority; matches AWS CLI convention)
2. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars (and `AWS_SESSION_TOKEN` if set)
3. `AWS_PROFILE` env var
4. AWS CLI default profile / IMDS / SSO

The assumed-role credentials are **never written to your environment or your default profile**. They are returned via stdout (`--output json`/`export`) or written to a separate named profile (`--output profile --write-profile <name>`).

### Flags

| Flag | Description |
|------|-------------|
| `--client-stack`, `-c` | Client stack name (resolves role ARN + ExternalId from outputs) |
| `--role-arn` | Full role ARN (required if no `--client-stack`) |
| `--external-id`, `-e` | ExternalId (required if no `--client-stack`) |
| `--output`, `-o` | Output mode: `json`, `export`, `profile` (default: `json`) |
| `--profile` | **SOURCE** AWS profile to use for `sts:AssumeRole` (CLI convention) |
| `--write-profile` | **DEST** profile name for `-o profile` (default: derived from client stack name; cannot be `default`) |
| `--session-name`, `-s` | STS session name (default: `isb-m2m-session`) |
| `--duration-seconds`, `-d` | Session duration in seconds (900-43200; default: STS default of 3600). Capped at the role's `MaxSessionDuration` regardless. |
| `--region` | AWS region (default: `$AWS_REGION` or `us-east-1`) |

## call-api

Signs and sends an API request using **existing** AWS credentials. Does not assume a role — use `assume-m2m-role` first.

### Two credential surfaces

This script touches AWS twice and they use **different** credentials:

1. **The signed API request itself** uses the credentials read from `--profile` (or env vars / default chain). When `--profile` is the assumed-role profile written by `assume-m2m-role`, this is exactly what you want — the M2M role has `execute-api:Invoke`.
2. **Resolving the API URL via `cloudformation:DescribeStacks`** (when `--client-stack` is given and `--api-url` is not) deliberately uses the **default credential chain**, NOT `--profile`. The M2M role is scoped to `execute-api:Invoke` only and cannot describe stacks. The operator's own credentials (env vars, `AWS_PROFILE`, default profile, IMDS, SSO) handle the lookup.

If your default credentials don't have `cloudformation:DescribeStacks` either, pass `--api-url <url>` explicitly to skip the lookup.

### Examples

```bash
# Using a profile created by assume-m2m-role.
# describe-stacks runs with default chain; the SigV4 request runs with the assumed-role profile.
./scripts/m2m/call-api.sh \
  --path /leases \
  --client-stack <stack> \
  --profile isb-m2m-<client>

# Using exported env vars
source <(./scripts/m2m/assume-m2m-role.sh --client-stack <stack> -o export)
./scripts/m2m/call-api.sh --path /leases --client-stack <stack>

# POST with body
./scripts/m2m/call-api.sh \
  --path /leases \
  --method POST \
  --body '{"leaseTemplateUuid": "abc-123"}' \
  --client-stack <stack> \
  --profile isb-m2m-<client>

# Explicit API URL (skips CloudFormation lookup; useful when default
# credentials don't have cloudformation:DescribeStacks)
./scripts/m2m/call-api.sh \
  --path /leases \
  --api-url https://abc123.execute-api.us-east-1.amazonaws.com/prod \
  --profile isb-m2m-<client>
```

### Flags

| Flag | Description |
|------|-------------|
| `--path`, `-p` | API path, e.g. `/leases` **(required)** |
| `--client-stack`, `-c` | Client stack name — resolves API URL from outputs (uses default credential chain, not `--profile`) |
| `--api-url` | API Gateway URL with stage (required if no `--client-stack`); skips the CFN lookup |
| `--profile` | AWS profile used to **sign** the API request (typically the assumed-role profile from `assume-m2m-role`). Not used for `describe-stacks`. |
| `--method`, `-m` | HTTP method (default: `GET`) |
| `--body`, `-b` | JSON request body |
| `--region` | AWS region (default: `$AWS_REGION` or `us-east-1`) |

## smoke-test

Tests **one** M2M client by assuming its role and verifying RBAC enforcement on a few representative endpoints. Single-client by design — different clients trust different external principals, so there is no single operator identity that can assume every client's role.

```bash
# Test one client (caller must have credentials matching the client's TrustedPrincipal)
./scripts/m2m/smoke-test.sh --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline

# With a specific source profile
./scripts/m2m/smoke-test.sh \
  --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline \
  --profile my-corp-sso
```

To list deployed client stacks, use [`list-clients.sh`](#list-clients).

## list-clients

Read-only view over CloudFormation. Lists deployed M2M client stacks (discovered by tag) along with each client's role, trust principal, and outputs.

```bash
# All M2M clients in the account
./scripts/m2m/list-clients.sh

# Filter to one ISB deployment
./scripts/m2m/list-clients.sh --namespace myisb

# JSON output (for piping into jq, etc.)
./scripts/m2m/list-clients.sh --output json
```

| Flag | Description |
|------|-------------|
| `--namespace`, `-n` | Filter to one ISB deployment (matches `aws-solutions:isb-id=<ns>_isb`) |
| `--output`, `-o` | `table` (default) or `json` |
| `--region` | AWS region (default: `$AWS_REGION` or `us-east-1`) |
| `--profile` | AWS profile to use (CLI default chain otherwise) |

## revoke-m2m-role

Revoke or restore an M2M client's role access without destroying the stack. For permanent removal, use `cdk destroy <client-stack>` instead.

### Actions

| Action | Effect | Blocks Existing Sessions? | Blocks New Sessions? |
|--------|--------|--------------------------|---------------------|
| `deny` | Attaches inline Deny policy to one client's role | Yes (immediate) | Yes |
| `deny-all` | `deny` applied to every discovered client stack | Yes (immediate) | Yes |
| `revoke-sessions` | Denies sessions issued before now (one client) | Yes (before invocation) | No |
| `restore` | Removes the revocation policy from one client's role | N/A | N/A |
| `restore-all` | `restore` applied to every discovered client stack | N/A | N/A |

### Examples

```bash
# Emergency: deny one client immediately
./scripts/m2m/revoke-m2m-role.sh \
  --action deny \
  --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline

# Emergency: deny ALL M2M clients in the account (tag-based discovery)
./scripts/m2m/revoke-m2m-role.sh --action deny-all

# Scope to one ISB deployment
./scripts/m2m/revoke-m2m-role.sh --action deny-all --namespace myisb

# Credential leak — invalidate existing sessions, allow new ones
./scripts/m2m/revoke-m2m-role.sh \
  --action revoke-sessions \
  --client-stack <stack>

# Restore one client
./scripts/m2m/revoke-m2m-role.sh \
  --action restore \
  --client-stack <stack>

# Restore all clients (idempotent — skips clients with no revocation policy)
./scripts/m2m/revoke-m2m-role.sh --action restore-all
```

Bulk actions (`deny-all`, `restore-all`) prompt for `y/N` confirmation before touching every client. Pass `--skip-confirmation` for non-interactive use (CI / runbook automation).

## How It Works

1. Operator deploys an `IsbM2mClient` stack named `<stackPrefix>-M2mClient-<Role>-<clientName>` with parameters identifying the client (Namespace, ClientName, Role, TrustedPrincipal, RestApiId)
2. Stack creates one IAM role `<namespace>-isb-m2m-<role>-<clientName>` (lowercased) with a per-stack ExternalId and the operator-supplied trust principal
3. Stack scopes role permissions to the API Gateway derived from the operator-supplied REST API ID (read from SSM `InnovationSandbox_<namespace>_Compute_RestApiId` by `deploy-client.sh`)
4. Caller invokes `assume-m2m-role` with `--client-stack <name>`, which:
   - Reads `M2MRoleArn` and `M2MExternalId` from the client stack outputs
   - Calls `STS.AssumeRole` with the role ARN and ExternalId
   - Outputs credentials in the chosen format
5. Caller uses the credentials to sign API requests with SigV4 (via `call-api`, `curl --aws-sigv4`, or any AWS SDK)
6. API Gateway validates the SigV4 signature; the handler middleware extracts the role and client name from the role ARN pattern (namespace-anchored regex)

