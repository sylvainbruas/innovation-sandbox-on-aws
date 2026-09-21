// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The eight fixed OpenAPI 3.0 Path Item operation fields. Any other path-item key
// (parameters, $ref, servers, summary, ...) is not an operation and is skipped.
const HTTP_METHODS: ReadonlySet<string> = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

// The API domains, spelled as the OpenAPI *path* first-segment
// (`/leaseTemplates` -> `leaseTemplates`). This is a different namespace from the
// model's kebab-case server projections (`lease-templates`), so it is NOT the same
// list as `serverDomains()`. It is the source of the ApiDomain / DomainLambdaArns
// types; `prepare-api-gateway-spec.test.ts` asserts it stays in sync with the
// generated contract's paths.
export const API_DOMAINS = [
  "accounts",
  "blueprints",
  "configurations",
  "leases",
  "leaseTemplates",
  "principals",
] as const;

export type ApiDomain = (typeof API_DOMAINS)[number];
export type DomainLambdaArns = Readonly<Record<ApiDomain, string>>;

// The only gateway-enforced security scheme: SigV4 maps to AWS_IAM authorization.
// Every other scheme in the contract (e.g. `isbIdentity`, the Lambda-verified
// `x-isb-identity` header) is documentation the gateway cannot enforce.
const SIGV4_SCHEME = "aws.auth.sigv4";

// API Gateway OpenAPI vendor extensions.
const INTEGRATION = "x-amazon-apigateway-integration";
const REQUEST_VALIDATOR = "x-amazon-apigateway-request-validator";
const REQUEST_VALIDATORS = "x-amazon-apigateway-request-validators";
const NO_VALIDATION = "none";

// AWS_PROXY integration URI. `${LambdaArn}` is substituted with each domain's
// function ARN at synthesis; `${AWS::Partition}`/`${AWS::Region}` are resolved by
// CloudFormation as pseudo-parameters.
const INTEGRATION_URI_TEMPLATE =
  "arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/" +
  "2015-03-31/functions/${LambdaArn}/invocations";

type OpenApiPath = Record<string, unknown>;

export interface OpenApiDocument {
  paths: Record<string, OpenApiPath>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const domainForPath = (path: string): ApiDomain => {
  const segment = path.split("/")[1];
  const domain = API_DOMAINS.find((candidate) => candidate === segment);
  if (!domain) {
    throw new Error(
      `prepareApiGatewaySpec: no Lambda integration mapping for path "${path}"`,
    );
  }
  return domain;
};

const integration = (lambdaArn: string) => ({
  type: "aws_proxy",
  httpMethod: "POST",
  uri: { "Fn::Sub": [INTEGRATION_URI_TEMPLATE, { LambdaArn: lambdaArn }] },
});

/**
 * Reduces gateway authentication to a single uniform AWS_IAM (SigV4) requirement
 * for both human and M2M callers. Keeps only the SigV4 scheme, dropping every
 * other scheme (e.g. `isbIdentity`) since those document headers the Lambda
 * verifies rather than gateway authorizers.
 */
function enforceUniformSigV4(spec: OpenApiDocument): void {
  const sigv4 = spec.components?.securitySchemes?.[SIGV4_SCHEME];
  if (!sigv4) {
    throw new Error(
      `prepareApiGatewaySpec: canonical OpenAPI has no ${SIGV4_SCHEME} scheme`,
    );
  }
  // Authorization must be set here, in the spec. With SpecRestApi the whole API
  // is imported from this OpenAPI body, so there are no CDK-created methods for a
  // construct-level `defaultMethodOptions.authorizationType: IAM` to apply to.
  // API Gateway maps this top-level `security` requirement plus the sigv4 scheme's
  // `x-amazon-apigateway-authtype: awsSigv4` to AWS_IAM on every operation — the
  // spec is the only place that enforcement can be expressed.
  spec.security = [{ [SIGV4_SCHEME]: [] }];
  spec.components!.securitySchemes = { [SIGV4_SCHEME]: sigv4 };
}

/**
 * Disables API Gateway request validation so malformed requests keep reaching the
 * Smithy server/Lambda and retain the existing JSend error envelope instead of
 * being rejected at the gateway.
 */
function disableGatewayValidation(spec: OpenApiDocument): void {
  spec[REQUEST_VALIDATORS] = {
    [NO_VALIDATION]: {
      validateRequestBody: false,
      validateRequestParameters: false,
    },
  };
  spec[REQUEST_VALIDATOR] = NO_VALIDATION;
}

/**
 * Adds an AWS_PROXY integration to every operation, routing each path to its
 * domain Lambda. Fails closed on an unknown domain, a missing Lambda ARN, a
 * malformed operation, or an operation-level `security` override (which would
 * escape the uniform AWS_IAM requirement).
 */
function attachProxyIntegrations(
  spec: OpenApiDocument,
  lambdaArns: DomainLambdaArns,
): void {
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const lambdaArn = lambdaArns[domainForPath(path)];
    if (!lambdaArn) {
      throw new Error(
        `prepareApiGatewaySpec: no Lambda ARN supplied for path "${path}"`,
      );
    }

    for (const [method, value] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) {
        continue;
      }
      if (!isObject(value)) {
        throw new Error(
          `prepareApiGatewaySpec: ${method.toUpperCase()} ${path} is not an operation`,
        );
      }
      if ("security" in value) {
        throw new Error(
          `prepareApiGatewaySpec: operation-level security on ` +
            `${method.toUpperCase()} ${path} would override uniform AWS_IAM`,
        );
      }
      value[INTEGRATION] = integration(lambdaArn);
    }
  }
}

/**
 * Converts the canonical Smithy-generated OpenAPI contract into the document
 * deployed by API Gateway, as a pure transform over a clone (the published
 * contract is left unchanged). In order:
 *
 * 1. Enforce uniform AWS_IAM (SigV4), dropping the Lambda-verified `isbIdentity`.
 * 2. Disable gateway request validation (preserve Lambda/JSend errors).
 * 3. Attach an aws_proxy integration to every operation (fail-closed on unknown
 *    domains, missing ARNs, malformed operations, or per-operation security).
 *
 * Public paths, schemas, examples, descriptions, and servers are otherwise
 * preserved. Runs in memory during CDK synthesis — no second deployment spec.
 */
export function prepareApiGatewaySpec(
  contract: OpenApiDocument,
  lambdaArns: DomainLambdaArns,
): OpenApiDocument {
  const spec = structuredClone(contract);
  enforceUniformSigV4(spec);
  disableGatewayValidation(spec);
  attachProxyIntegrations(spec, lambdaArns);
  return spec;
}
