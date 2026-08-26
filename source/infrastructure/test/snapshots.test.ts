// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ensureDirSync } from "fs-extra";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { IsbAccountPoolStack } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-stack";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { IsbDataStack } from "@amzn/innovation-sandbox-infrastructure/isb-data-stack";
import { IsbIdcStack } from "@amzn/innovation-sandbox-infrastructure/isb-idc-stack";
import { IsbM2mClientStack } from "@amzn/innovation-sandbox-infrastructure/isb-m2m-client-stack";
import { IsbSandboxAccountStack } from "@amzn/innovation-sandbox-infrastructure/isb-sandbox-account-stack";
import { AssetCode, Code } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ISource, Source } from "aws-cdk-lib/aws-s3-deployment";

// Prevent real npm installs / file ops during synth.
vi.mock("child_process", () => ({
  execSync: vi.fn().mockImplementation(() => Buffer.from("mocked execSync")),
}));

vi.mock("fs-extra", () => ({
  moveSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  ensureDirSync: vi.fn(),
}));

function normalizeNonDeterministicTemplate(template: Template) {
  const lambdas = template.findResources("AWS::Lambda::Function");
  const layers = template.findResources("AWS::Lambda::LayerVersion");
  const bucketDeployments = template.findResources(
    "Custom::CDKBucketDeployment",
  );
  const spokeConfigParserCustomResources = template.findResources(
    "Custom::ParseJsonConfiguration",
  );
  const cognitoPostDeployCustomResources = template.findResources(
    "Custom::CognitoPostDeployConfigurer",
  );
  const tagActivationTriggerCustomResources = template.findResources(
    "Custom::TagActivationTrigger",
  );
  const stackSets = template.findResources("AWS::CloudFormation::StackSet");

  // Clone so normalization doesn't mutate the Template shared with render assertions.
  const templateJson = structuredClone(template.toJSON());

  for (const lambda in lambdas) {
    templateJson["Resources"][lambda]["Properties"]["Code"] =
      "Omitted to remove snapshot dependency on hash";
  }

  for (const layer in layers) {
    templateJson["Resources"][layer]["Properties"]["Content"] =
      "Omitted to remove snapshot dependency on hash";
  }

  for (const bucketDeployment in bucketDeployments) {
    templateJson["Resources"][bucketDeployment]["Properties"][
      "SourceObjectKeys"
    ] = "Omitted to remove snapshot dependency on hash";
  }

  for (const cr in spokeConfigParserCustomResources) {
    templateJson["Resources"][cr]["Properties"]["forceUpdate"] =
      "Omitted to remove snapshot dependency on generated auto incrementing id";
  }

  for (const cr in cognitoPostDeployCustomResources) {
    templateJson["Resources"][cr]["Properties"]["forceUpdate"] =
      "Omitted to remove snapshot dependency on generated auto incrementing id";
  }

  for (const cr in tagActivationTriggerCustomResources) {
    templateJson["Resources"][cr]["Properties"]["forceUpdate"] =
      "Omitted to remove snapshot dependency on generated auto incrementing id";
  }

  for (const stackSet in stackSets) {
    templateJson["Resources"][stackSet]["Properties"]["TemplateURL"] =
      "Omitted to remove snapshot dependency on hash";
  }

  return templateJson;
}

function toFullDepthSnapshot(templateJson: Record<string, any>): string {
  return JSON.stringify(templateJson, null, 2);
}

beforeAll(async () => {
  vi.spyOn(Code, "fromAsset").mockImplementation(() => {
    const mockCode = new AssetCode("/mock/path");
    mockCode.bind = () => ({
      s3Location: {
        bucketName: "mock-bucket",
        objectKey: "mock-key",
      },
    });
    mockCode.bindToResource = vi.fn();

    return mockCode;
  });

  vi.spyOn(Source, "asset").mockImplementation((path) => {
    const mockBucket = {
      bucketName: "mock-source-bucket",
    } as IBucket;

    return {
      bind: () => ({
        bucket: mockBucket,
        zipObjectKey: "mock-source-key",
        deployTime: true,
        objectKey: "mock-object-key",
      }),
      bindToStackSynthesizer: vi.fn(),
      path: path || "/mock/asset/path",
    } as ISource;
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("IsbComputeStack Snapshot", () => {
  it("matches the snapshot", () => {
    ensureDirSync(path.join(__dirname, "..", "..", "frontend", "dist"));
    const app = new App();
    const stack = new IsbComputeStack(app, "IsbComputeStack");
    const template = Template.fromStack(stack);
    const templateJson = normalizeNonDeterministicTemplate(template);
    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("IsbDataStack Snapshot", () => {
  // Synthesize once and share: IsbDataStack binds a shared singleton to its
  // App, so instantiating it a second time in another App throws
  // CannotReferenceAcrossApps. Built in beforeAll so the top-level asset mocks
  // are already applied.
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new IsbDataStack(app, "IsbDataStack");
    template = Template.fromStack(stack);
  });

  it("grants the config migrator role dynamodb:BatchGetItem and dynamodb:PutItem", () => {
    // The migrator's destination-first idempotency check calls getAllSections()
    // (BatchGetItem) before the migration write (PutItem). Both must be granted
    // or the custom resource fails with AccessDeniedException on deploy. This
    // asserts against the synthesized IAM policy because unit tests mock
    // DynamoDB and never exercise IAM. Runs before the snapshot test, which
    // mutates the template JSON in place.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: Match.arrayWith([
              "dynamodb:BatchGetItem",
              "dynamodb:PutItem",
            ]),
          }),
        ]),
      },
    });
  });

  it("matches the snapshot", () => {
    const templateJson = normalizeNonDeterministicTemplate(template);
    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("IsbAccountPoolStack Snapshot", () => {
  it("matches the snapshot", () => {
    const app = new App();
    const stack = new IsbAccountPoolStack(app, "IsbAccountPoolStack");
    const template = Template.fromStack(stack);
    const templateJson = normalizeNonDeterministicTemplate(template);

    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("IdcStack Snapshot", () => {
  it("matches the snapshot", () => {
    const app = new App();
    const stack = new IsbIdcStack(app, "IsbIdcStack");
    const template = Template.fromStack(stack);
    const templateJson = normalizeNonDeterministicTemplate(template);

    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("SandboxAccountStack Snapshot", () => {
  it("matches the snapshot", () => {
    const app = new App();
    const stack = new IsbSandboxAccountStack(app, "IsbSandboxAccountStack");
    const template = Template.fromStack(stack);
    const templateJson = normalizeNonDeterministicTemplate(template);

    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("IsbM2mClientStack Snapshot", () => {
  it("matches the snapshot", () => {
    const app = new App();
    const stack = new IsbM2mClientStack(app, "IsbM2mClientStack");
    const template = Template.fromStack(stack);
    const templateJson = normalizeNonDeterministicTemplate(template);

    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});
