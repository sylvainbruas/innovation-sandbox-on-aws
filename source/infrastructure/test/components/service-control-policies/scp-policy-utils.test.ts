// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "path";
import { describe, expect, it } from "vitest";

import {
  buildNukeScpConditionBlock,
  injectBedrockInferenceProfilePatterns,
  injectPrincipalExceptions,
  loadPolicyFromFile,
  PRINCIPAL_EXCEPTIONS_PLACEHOLDER,
  type ScpPolicy,
} from "@amzn/innovation-sandbox-infrastructure/components/service-control-policies/scp-policy-utils";

const SCP_DIR = path.resolve(
  __dirname,
  "../../../lib/components/service-control-policies",
);

describe("loadPolicyFromFile", () => {
  it("should load and parse a valid SCP JSON file", () => {
    const policy = loadPolicyFromFile(
      "isb-limit-managed-regions.json",
      undefined,
      undefined,
      SCP_DIR,
    );

    expect(policy.Version).toBe("2012-10-17");
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]!.Sid).toBe("DenyRegionAccess");
  });

  it("should substitute namespace placeholder", () => {
    const policy = loadPolicyFromFile(
      "isb-limit-managed-regions.json",
      "testns",
      undefined,
      SCP_DIR,
    );

    const principalArns = policy.Statement[0]!.Condition?.ArnNotLike?.[
      "aws:PrincipalARN"
    ] as string[];
    expect(principalArns).toContain(
      "arn:aws:iam::*:role/InnovationSandbox-testns*",
    );
  });

  it("should substitute region list placeholder", () => {
    const policy = loadPolicyFromFile(
      "isb-limit-managed-regions.json",
      "testns",
      ["us-east-1", "eu-west-1"],
      SCP_DIR,
    );

    const regions =
      policy.Statement[0]!.Condition?.StringNotEquals?.["aws:RequestedRegion"];
    expect(regions).toContain("us-east-1,eu-west-1");
  });

  it("should throw on non-existent file", () => {
    expect(() =>
      loadPolicyFromFile("non-existent.json", undefined, undefined, SCP_DIR),
    ).toThrow("Failed to load SCP policy");
  });
});

describe("injectPrincipalExceptions", () => {
  function createTestPolicy(): ScpPolicy {
    return {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "TestStatement",
          Effect: "Deny",
          Action: ["*"],
          Resource: ["*"],
          Condition: {
            ArnNotLike: {
              "aws:PrincipalARN": [
                "arn:aws:iam::*:role/BaseRole*",
                PRINCIPAL_EXCEPTIONS_PLACEHOLDER,
              ],
            },
          },
        },
      ],
    };
  }

  it("should strip placeholder when additionalPrincipalExceptions is undefined", () => {
    const policy = createTestPolicy();
    injectPrincipalExceptions(policy, undefined, undefined);

    // Placeholder should be stripped, only base principals remain
    const arns = policy.Statement[0]!.Condition?.ArnNotLike?.[
      "aws:PrincipalARN"
    ] as string[];
    expect(arns).toEqual(["arn:aws:iam::*:role/BaseRole*"]);
    expect(arns).not.toContain(PRINCIPAL_EXCEPTIONS_PLACEHOLDER);
  });

  it("should replace placeholder with Fn::If intrinsic when params provided", () => {
    const policy = createTestPolicy();
    injectPrincipalExceptions(
      policy,
      ["arn:aws:iam::*:role/CustomRole*"],
      "HasAdditionalPrincipalExceptions",
    );

    const result = policy.Statement[0]!.Condition?.ArnNotLike?.[
      "aws:PrincipalARN"
    ] as any;

    expect(result["Fn::If"]).toBeDefined();
    expect(result["Fn::If"][0]).toBe("HasAdditionalPrincipalExceptions");
    // True branch: Fn::Split producing the combined array
    expect(result["Fn::If"][1]["Fn::Split"]).toBeDefined();
    // False branch: base principals only
    expect(result["Fn::If"][2]).toEqual(["arn:aws:iam::*:role/BaseRole*"]);
  });

  it("should skip statements without ArnNotLike condition", () => {
    const policy: ScpPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "NoCondition",
          Effect: "Deny",
          Action: ["*"],
          Resource: ["*"],
        },
      ],
    };

    // Should not throw
    injectPrincipalExceptions(
      policy,
      ["arn:aws:iam::*:role/CustomRole*"],
      "HasCondition",
    );

    expect(policy.Statement[0]!.Condition).toBeUndefined();
  });

  it("should skip statements without the placeholder", () => {
    const policy: ScpPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "NoPlaceholder",
          Effect: "Deny",
          Action: ["*"],
          Resource: ["*"],
          Condition: {
            ArnNotLike: {
              "aws:PrincipalARN": [
                "arn:aws:iam::*:role/BaseRole*",
                "arn:aws:iam::*:role/AnotherRole*",
              ],
            },
          },
        },
      ],
    };

    injectPrincipalExceptions(
      policy,
      ["arn:aws:iam::*:role/CustomRole*"],
      "HasCondition",
    );

    // Should remain unchanged
    const arns = policy.Statement[0]!.Condition?.ArnNotLike?.[
      "aws:PrincipalARN"
    ] as string[];
    expect(arns).toEqual([
      "arn:aws:iam::*:role/BaseRole*",
      "arn:aws:iam::*:role/AnotherRole*",
    ]);
  });

  it("should handle multiple statements with placeholder", () => {
    const policy: ScpPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Stmt1",
          Effect: "Deny",
          Action: ["s3:*"],
          Resource: ["*"],
          Condition: {
            ArnNotLike: {
              "aws:PrincipalARN": [
                "arn:aws:iam::*:role/Role1*",
                PRINCIPAL_EXCEPTIONS_PLACEHOLDER,
              ],
            },
          },
        },
        {
          Sid: "Stmt2",
          Effect: "Deny",
          Action: ["ec2:*"],
          Resource: ["*"],
          Condition: {
            ArnNotLike: {
              "aws:PrincipalARN": [
                "arn:aws:iam::*:role/Role2*",
                PRINCIPAL_EXCEPTIONS_PLACEHOLDER,
              ],
            },
          },
        },
      ],
    };

    injectPrincipalExceptions(
      policy,
      ["arn:aws:iam::*:role/Custom*"],
      "HasCondition",
    );

    // Both statements should be injected
    for (const stmt of policy.Statement) {
      const result = stmt.Condition?.ArnNotLike?.["aws:PrincipalARN"] as any;
      expect(result["Fn::If"]).toBeDefined();
    }
  });

  it("should include multiple additional principals in the Fn::Join", () => {
    const policy = createTestPolicy();
    const additionalPrincipals = [
      "arn:aws:iam::*:role/RoleA*",
      "arn:aws:iam::*:role/RoleB*",
    ];

    injectPrincipalExceptions(policy, additionalPrincipals, "HasCondition");

    const result = policy.Statement[0]!.Condition?.ArnNotLike?.[
      "aws:PrincipalARN"
    ] as any;
    const trueBranch = result["Fn::If"][1];
    const joinContent = trueBranch["Fn::Split"][1]["Fn::Join"][1];

    // Last element should be the Fn::Join of additional principals
    const additionalJoin = joinContent[joinContent.length - 1];
    expect(additionalJoin["Fn::Join"][1]).toEqual(additionalPrincipals);
  });
});

describe("buildNukeScpConditionBlock", () => {
  function createNukeTestPolicy(): ScpPolicy {
    return {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyAllExceptAwsNukeSupportedServices",
          Effect: "Deny",
          NotAction: ["s3:*"],
          Resource: ["*"],
          Condition: {
            ArnNotLike: {
              "aws:PrincipalARN": [
                "arn:aws:iam::*:role/TestRole*",
                PRINCIPAL_EXCEPTIONS_PLACEHOLDER,
              ],
            },
          },
        },
      ],
    };
  }

  it("should produce correct JSON fragments", () => {
    const policy = createNukeTestPolicy();
    const result = buildNukeScpConditionBlock(
      policy,
      ["arn:aws:iam::*:role/Custom*"],
      "HasCondition",
    );

    expect(result.conditionBlockStart).toBe(
      '{"ArnNotLike":{"aws:PrincipalARN":[',
    );
    expect(result.conditionBlockEnd).toBe("]}}");
    expect(result.basePrincipalArnsJson).toBe(
      '"arn:aws:iam::*:role/TestRole*"',
    );
  });

  it("should produce Fn::If for principal exceptions", () => {
    const policy = createNukeTestPolicy();
    const result = buildNukeScpConditionBlock(
      policy,
      ["arn:aws:iam::*:role/Custom*"],
      "HasCondition",
    );

    const fnIf = result.principalExceptionsFnIf as any;
    expect(fnIf["Fn::If"][0]).toBe("HasCondition");
    // True branch appends additional principals
    expect(fnIf["Fn::If"][1]["Fn::Join"]).toBeDefined();
    // False branch is empty string (no additions)
    expect(fnIf["Fn::If"][2]).toBe("");
  });

  it("should filter out the placeholder from basePrincipalArns", () => {
    const policy = createNukeTestPolicy();
    const result = buildNukeScpConditionBlock(
      policy,
      ["arn:aws:iam::*:role/Custom*"],
      "HasCondition",
    );

    expect(result.basePrincipalArnsJson).not.toContain(
      PRINCIPAL_EXCEPTIONS_PLACEHOLDER,
    );
  });

  it("should throw if ArnNotLike condition is missing", () => {
    const policy: ScpPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "NoCondition",
          Effect: "Deny",
          NotAction: ["s3:*"],
          Resource: ["*"],
          Condition: {
            StringEquals: { "aws:Region": ["us-east-1"] },
          },
        },
      ],
    };

    expect(() =>
      buildNukeScpConditionBlock(
        policy,
        ["arn:aws:iam::*:role/Custom*"],
        "HasCondition",
      ),
    ).toThrow("missing ArnNotLike condition");
  });
});

describe("injectBedrockInferenceProfilePatterns", () => {
  function createRegionLimitPolicy(): ScpPolicy {
    return {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyRegionAccess",
          Effect: "Deny",
          Action: ["*"],
          Resource: ["*"],
          Condition: {
            StringNotEquals: {
              "aws:RequestedRegion": ["us-east-1"],
            },
            ArnNotLike: {
              "aws:PrincipalARN": ["arn:aws:iam::*:role/BaseRole*"],
            },
          },
        },
      ],
    };
  }

  it("should be a no-op when bedrockInferenceProfilePatterns is undefined", () => {
    const policy = createRegionLimitPolicy();
    injectBedrockInferenceProfilePatterns(policy, undefined, undefined);

    const arnNotLike = policy.Statement[0]!.Condition?.ArnNotLike;
    expect(arnNotLike).toEqual({
      "aws:PrincipalARN": ["arn:aws:iam::*:role/BaseRole*"],
    });
    expect(arnNotLike?.["bedrock:InferenceProfileArn"]).toBeUndefined();
  });

  it("should be a no-op when conditionId is undefined", () => {
    const policy = createRegionLimitPolicy();
    injectBedrockInferenceProfilePatterns(
      policy,
      ["arn:aws:bedrock:*:*:inference-profile/*"],
      undefined,
    );

    const arnNotLike = policy.Statement[0]!.Condition?.ArnNotLike;
    expect(arnNotLike).toEqual({
      "aws:PrincipalARN": ["arn:aws:iam::*:role/BaseRole*"],
    });
  });

  it("should inject Fn::If with bedrock key when params provided", () => {
    const policy = createRegionLimitPolicy();
    const patterns = ["arn:aws:bedrock:*:*:inference-profile/*"];

    injectBedrockInferenceProfilePatterns(
      policy,
      patterns,
      "HasBedrockInferenceProfilePatterns",
    );

    const arnNotLike = policy.Statement[0]!.Condition?.ArnNotLike as any;
    expect(arnNotLike["Fn::If"]).toBeDefined();
    expect(arnNotLike["Fn::If"][0]).toBe("HasBedrockInferenceProfilePatterns");

    // True branch: includes bedrock key
    const trueBranch = arnNotLike["Fn::If"][1];
    expect(trueBranch["aws:PrincipalARN"]).toEqual([
      "arn:aws:iam::*:role/BaseRole*",
    ]);
    expect(trueBranch["bedrock:InferenceProfileArn"]).toEqual(patterns);

    // False branch: no bedrock key
    const falseBranch = arnNotLike["Fn::If"][2];
    expect(falseBranch["aws:PrincipalARN"]).toEqual([
      "arn:aws:iam::*:role/BaseRole*",
    ]);
    expect(falseBranch["bedrock:InferenceProfileArn"]).toBeUndefined();
  });

  it("should handle multiple bedrock patterns", () => {
    const policy = createRegionLimitPolicy();
    const patterns = [
      "arn:aws:bedrock:*:*:inference-profile/us.*",
      "arn:aws:bedrock:*:*:inference-profile/eu.*",
    ];

    injectBedrockInferenceProfilePatterns(policy, patterns, "HasBedrock");

    const trueBranch = (policy.Statement[0]!.Condition?.ArnNotLike as any)[
      "Fn::If"
    ][1];
    expect(trueBranch["bedrock:InferenceProfileArn"]).toEqual(patterns);
  });

  it("should skip statements without DenyRegionAccess Sid", () => {
    const policy: ScpPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "OtherStatement",
          Effect: "Deny",
          Action: ["*"],
          Resource: ["*"],
          Condition: {
            ArnNotLike: {
              "aws:PrincipalARN": ["arn:aws:iam::*:role/BaseRole*"],
            },
          },
        },
      ],
    };

    injectBedrockInferenceProfilePatterns(
      policy,
      ["arn:aws:bedrock:*:*:inference-profile/*"],
      "HasBedrock",
    );

    // Should remain unchanged — not DenyRegionAccess
    const arnNotLike = policy.Statement[0]!.Condition?.ArnNotLike;
    expect(arnNotLike).toEqual({
      "aws:PrincipalARN": ["arn:aws:iam::*:role/BaseRole*"],
    });
  });

  it("should skip if DenyRegionAccess has no ArnNotLike condition", () => {
    const policy: ScpPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyRegionAccess",
          Effect: "Deny",
          Action: ["*"],
          Resource: ["*"],
          Condition: {
            StringNotEquals: {
              "aws:RequestedRegion": ["us-east-1"],
            },
          },
        },
      ],
    };

    injectBedrockInferenceProfilePatterns(
      policy,
      ["arn:aws:bedrock:*:*:inference-profile/*"],
      "HasBedrock",
    );

    // Should not add ArnNotLike
    expect(
      policy.Statement[0]!.Condition?.ArnNotLike,
    ).toBeUndefined();
  });
});
