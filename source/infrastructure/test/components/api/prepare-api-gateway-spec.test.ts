// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  API_DOMAINS,
  DomainLambdaArns,
  OpenApiDocument,
  prepareApiGatewaySpec,
} from "@amzn/innovation-sandbox-infrastructure/components/api/prepare-api-gateway-spec";

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

const contractPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "docs",
  "openapi",
  "innovation-sandbox-api.json",
);
const contract = JSON.parse(
  readFileSync(contractPath, "utf8"),
) as OpenApiDocument;

const lambdaArns: DomainLambdaArns = {
  accounts: "arn:accounts",
  blueprints: "arn:blueprints",
  configurations: "arn:configurations",
  leases: "arn:leases",
  leaseTemplates: "arn:lease-templates",
  principals: "arn:principals",
};

const methods = (document: OpenApiDocument) =>
  Object.entries(document.paths).flatMap(([pathName, pathItem]) =>
    Object.keys(pathItem)
      .filter((key) => HTTP_METHODS.has(key))
      .map((method) => `${method.toUpperCase()} ${pathName}`),
  );

describe("prepareApiGatewaySpec", () => {
  it("keeps API_DOMAINS in sync with the generated contract's path segments", () => {
    // The contract is the single source of truth for domains; API_DOMAINS mirrors
    // it to provide the ApiDomain / DomainLambdaArns types. If the contract adds or
    // renames a domain, this fails until API_DOMAINS (and the Lambda wiring) follow.
    const fromContract = [
      ...new Set(Object.keys(contract.paths).map((p) => p.split("/")[1])),
    ].sort();
    expect([...API_DOMAINS].sort()).toEqual(fromContract);
  });

  it("keeps every generated operation and literal configuration route", () => {
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    expect(methods(spec).sort()).toEqual(methods(contract).sort());
    expect(spec.paths["/configurations/{section}"]).toBeUndefined();
    const configurationPaths = Object.keys(contract.paths).filter((pathName) =>
      pathName.startsWith("/configurations/"),
    );
    expect(configurationPaths.length).toBeGreaterThan(0);
    expect(
      configurationPaths.every((pathName) => !pathName.includes("{")),
    ).toBe(true);
  });

  it("preserves the public contract and does not mutate its input", () => {
    const pristine = structuredClone(contract);
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    expect(contract).toEqual(pristine);
    expect(spec.components?.schemas).toEqual(contract.components?.schemas);
    expect(spec.servers).toEqual(contract.servers);
    expect(spec.info).toEqual(contract.info);
    expect(JSON.stringify(spec)).toContain('"examples"');
    expect(JSON.stringify(spec)).toContain('"requestBody"');
  });

  it("adds the appropriate domain Lambda integration to every operation", () => {
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    for (const [pathName, pathItem] of Object.entries(spec.paths)) {
      const domain = pathName.split("/")[1] as keyof DomainLambdaArns;
      for (const [method, value] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) {
          continue;
        }
        const operation = value as Record<string, unknown>;
        expect(
          operation["x-amazon-apigateway-integration"],
          `${method.toUpperCase()} ${pathName}`,
        ).toEqual({
          type: "aws_proxy",
          httpMethod: "POST",
          uri: {
            "Fn::Sub": [
              "arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/" +
                "2015-03-31/functions/${LambdaArn}/invocations",
              { LambdaArn: lambdaArns[domain] },
            ],
          },
        });
      }
    }
  });

  it("uses uniform AWS_IAM and explicitly leaves gateway validation disabled", () => {
    const spec = prepareApiGatewaySpec(contract, lambdaArns);

    expect(spec.security).toEqual([{ "aws.auth.sigv4": [] }]);
    expect(spec.components?.securitySchemes?.["aws.auth.sigv4"]).toBeDefined();
    expect(spec.components?.securitySchemes?.isbIdentity).toBeUndefined();
    expect(spec["x-amazon-apigateway-request-validators"]).toEqual({
      none: {
        validateRequestBody: false,
        validateRequestParameters: false,
      },
    });
    expect(spec["x-amazon-apigateway-request-validator"]).toBe("none");
  });

  it("fails closed on unknown domains and operation-level auth overrides", () => {
    const unknownDomain = structuredClone(contract);
    unknownDomain.paths["/unknown"] = {
      get: { responses: { "200": { description: "ok" } } },
    };
    expect(() => prepareApiGatewaySpec(unknownDomain, lambdaArns)).toThrow(
      /no Lambda integration mapping/,
    );

    const authOverride = structuredClone(contract);
    const accounts = authOverride.paths["/accounts"]?.get;
    if (typeof accounts !== "object" || accounts === null) {
      throw new Error("test fixture has no GET /accounts operation");
    }
    (accounts as Record<string, unknown>).security = [];
    expect(() => prepareApiGatewaySpec(authOverride, lambdaArns)).toThrow(
      /operation-level security/,
    );
  });

  it("throws when an operation is malformed", () => {
    const malformed = structuredClone(contract);
    (malformed.paths["/accounts"] as Record<string, unknown>).get =
      "not-an-operation";
    expect(() => prepareApiGatewaySpec(malformed, lambdaArns)).toThrow(
      /is not an operation/,
    );
  });

  it("throws when a domain's Lambda ARN is missing", () => {
    const missingArn = { ...lambdaArns, accounts: "" } as DomainLambdaArns;
    expect(() => prepareApiGatewaySpec(contract, missingArn)).toThrow(
      /no Lambda ARN supplied/,
    );
  });
});
