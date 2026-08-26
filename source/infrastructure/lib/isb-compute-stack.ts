// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  addParameterGroup,
  ParameterWithLabel,
  YesNoParameter,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import {
  IdcAccountIdParam,
  NamespaceParam,
  OrgMgtAccountIdParam,
} from "@amzn/innovation-sandbox-infrastructure/helpers/shared-cfn-params";
import {
  getSharedSsmParamValues,
  SharedSpokeConfig,
} from "@amzn/innovation-sandbox-infrastructure/helpers/shared-ssm-params";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import fs from "fs";
import path from "path";

export class IsbComputeStack extends Stack {
  public static sharedSpokeConfig: SharedSpokeConfig;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /* solution input parameters go here*/
    const namespaceParam = new NamespaceParam(this);

    const orgMgtAccountId = new OrgMgtAccountIdParam(this);

    const idcAccountId = new IdcAccountIdParam(this);

    const allowListedCidr = new ParameterWithLabel(
      this,
      "AllowListedIPRanges",
      {
        type: "CommaDelimitedList",
        label: "Allow Listed IP Ranges",
        description:
          "Comma separated list of CIDR ranges that allow access to the API. To allow all the entire internet, leave" +
          " the default 0.0.0.0/1,128.0.0.0/1",
        default: "0.0.0.0/1,128.0.0.0/1",
        allowedPattern:
          "^((\\d{1,3}\\.){3}\\d{1,3}/([0-9]|[1-2][0-9]|3[0-2]))(\\s*,\\s*((\\d{1,3}\\.){3}\\d{1,3}/([0-9]|[1-2][0-9]|3[0-2])))*$",
      },
    );

    const useStableTagging = new YesNoParameter(this, "UseStableTagging", {
      label: "Use Stable Tagging",
      description:
        "Automatically use the most up to date and secure account cleaner image up until the next minor release. Selecting 'No' will pull the image as originally released, without any security updates.",
      default: "Yes",
    });

    const acceptTerms = new ParameterWithLabel(
      this,
      "AcceptSolutionTermsOfUse",
      {
        label: "Accept Solution Terms of Use",
        description: fs.readFileSync(
          path.join(__dirname, "assets/terms-of-use.txt"),
          "utf-8",
        ),
        allowedPattern: "^Accept$",
        constraintDescription:
          'You must enter "Accept" to deploy this template',
      },
    );

    const customDomainName = new ParameterWithLabel(this, "CustomDomainName", {
      label: "Custom Domain Name (Optional)",
      description:
        "A single fully-qualified domain to serve ISB on, e.g. isb.example.com. Provide Custom" +
        " Domain Certificate ARN as well to attach it (with TLS) to the ISB CloudFront" +
        " distribution. If you front ISB with your own edge/proxy, set this to your public" +
        " domain and leave the certificate ARN empty. No wildcards, scheme, or path. Leave" +
        " empty to use the default CloudFront URL.",
      default: "",
      allowedPattern: String.raw`^$|^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$`,
      constraintDescription:
        "Must be a single domain like isb.example.com (no https://, no path, no '*'), or empty",
    });

    const customDomainCertificateArn = new ParameterWithLabel(
      this,
      "CustomDomainCertificateArn",
      {
        label: "Custom Domain Certificate ARN (Optional)",
        description:
          "ARN of an existing ACM certificate that covers the Custom Domain Name (a wildcard" +
          " cert is fine). The certificate must be in us-east-1, because CloudFront only reads" +
          " certificates from that Region regardless of where this stack is deployed. Provide" +
          " this to serve the domain on the ISB CloudFront distribution. Leave empty if you" +
          " terminate TLS on your own edge/proxy.",
        default: "",
        allowedPattern:
          "^$|^arn:aws[a-zA-Z-]*:acm:us-east-1:[0-9]{12}:certificate/[0-9a-fA-F-]+$",
        constraintDescription:
          "Must be an ACM certificate ARN in us-east-1, or empty",
      },
    );

    addParameterGroup(this, {
      label: "Compute Stack Configuration",
      parameters: [
        namespaceParam,
        orgMgtAccountId,
        idcAccountId,
        allowListedCidr,
        useStableTagging,
        acceptTerms,
        customDomainName,
        customDomainCertificateArn,
      ],
    });

    IsbComputeStack.sharedSpokeConfig = getSharedSsmParamValues(
      this,
      namespaceParam.valueAsString,
      idcAccountId.valueAsString,
      orgMgtAccountId.valueAsString,
    );

    new IsbComputeResources(this, {
      namespace: namespaceParam.valueAsString,
      orgMgtAccountId: orgMgtAccountId.valueAsString,
      idcAccountId: idcAccountId.valueAsString,
      allowListedCidr: allowListedCidr.valueAsList,
      useStableTaggingParameter: useStableTagging,
      cognitoUserPoolId:
        IsbComputeStack.sharedSpokeConfig.data.cognitoUserPoolId,
      cognitoUserPoolArn:
        IsbComputeStack.sharedSpokeConfig.data.cognitoUserPoolArn,
      cognitoAppClientId:
        IsbComputeStack.sharedSpokeConfig.data.cognitoAppClientId,
      cognitoIdentityPoolId:
        IsbComputeStack.sharedSpokeConfig.data.cognitoIdentityPoolId,
      cognitoDomain: IsbComputeStack.sharedSpokeConfig.data.cognitoDomain,
      awsAccessPortalUrl:
        IsbComputeStack.sharedSpokeConfig.data.awsAccessPortalUrl,
      identityPoolAdminRoleName:
        IsbComputeStack.sharedSpokeConfig.data.identityPoolAdminRoleName,
      identityPoolManagerRoleName:
        IsbComputeStack.sharedSpokeConfig.data.identityPoolManagerRoleName,
      identityPoolUserRoleName:
        IsbComputeStack.sharedSpokeConfig.data.identityPoolUserRoleName,
      customDomainName: customDomainName.valueAsString,
      customDomainCertificateArn: customDomainCertificateArn.valueAsString,
    });

    applyIsbTag(this, `${namespaceParam.valueAsString}`);
  }
}
