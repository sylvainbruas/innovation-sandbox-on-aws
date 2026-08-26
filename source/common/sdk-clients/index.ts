// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { AccessAnalyzerClient } from "@aws-sdk/client-accessanalyzer";
import { AppConfigClient } from "@aws-sdk/client-appconfig";
import { AppConfigDataClient } from "@aws-sdk/client-appconfigdata";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { S3Client } from "@aws-sdk/client-s3";
import { SESClient } from "@aws-sdk/client-ses";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
} from "@aws-sdk/types";
import { IsbEventBridgeClient } from "./event-bridge-client.js";
import { IsbSecretsManagerClient } from "./secrets-manager-client.js";

let cachedAccessAnalyzerClient: AccessAnalyzerClient | null = null;
let cachedDynamoClient: DynamoDBDocumentClient | null = null;
let cachedSecretsManagerClient: IsbSecretsManagerClient | null = null;
let cachedStepFunctionsClient: SFNClient | null = null;
let cachedEC2Client: EC2Client | null = null;
let cachedSTSClient: STSClient | null = null;
let cachedAppConfigClient: AppConfigClient | null = null;
let cachedAppConfigDataClient: AppConfigDataClient | null = null;
let cachedOrgsClient: OrganizationsClient | null = null;
let cachedIamClient: IAMClient | null = null;
let cachedIdentitystoreClient: IdentitystoreClient | null = null;
let cachedSSOAdminClient: SSOAdminClient | null = null;
let cachedCostExplorerClient: CostExplorerClient | null = null;
let cachedSESClient: SESClient | null = null;
let cachedS3Client: S3Client | null = null;
let cachedCWLogsClient: CloudWatchLogsClient | null = null;
let cachedCloudWatchClient: CloudWatchClient | null = null;
let cachedCloudFormationClient: CloudFormationClient | null = null;
let cachedCodeBuildClient: CodeBuildClient | null = null;
let cachedCognitoIdpClient: CognitoIdentityProviderClient | null = null;
let cachedLambdaClient: LambdaClient | null = null;
let cachedSSMProvider: SSMProvider | null = null;

const tracer = new Tracer();

export class IsbClients {
  private constructor() {
    //static class. Shouldn't be constructable
  }

  public static accessAnalyzer(env: {
    USER_AGENT_EXTRA: string;
  }): AccessAnalyzerClient {
    if (cachedAccessAnalyzerClient == null) {
      cachedAccessAnalyzerClient = tracer.captureAWSv3Client(
        new AccessAnalyzerClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedAccessAnalyzerClient;
  }

  public static dynamo(env: {
    USER_AGENT_EXTRA: string;
  }): DynamoDBDocumentClient {
    if (cachedDynamoClient == null) {
      cachedDynamoClient = tracer.captureAWSv3Client(
        DynamoDBDocumentClient.from(
          new DynamoDBClient({
            customUserAgent: env.USER_AGENT_EXTRA,
          }),
        ),
      );
    }

    return cachedDynamoClient;
  }

  public static eventBridge(
    props: {
      eventSource: string;
    },
    env: {
      USER_AGENT_EXTRA: string;
      ISB_EVENT_BUS: string;
    },
  ): IsbEventBridgeClient {
    const client = new IsbEventBridgeClient(
      {
        Source: props.eventSource,
        EventBusName: env.ISB_EVENT_BUS,
      },
      {
        customUserAgent: env.USER_AGENT_EXTRA,
      },
    );
    return tracer.captureAWSv3Client(client);
  }

  public static secretsManager(env: {
    USER_AGENT_EXTRA: string;
  }): IsbSecretsManagerClient {
    if (cachedSecretsManagerClient == null) {
      cachedSecretsManagerClient = tracer.captureAWSv3Client(
        new IsbSecretsManagerClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedSecretsManagerClient;
  }

  public static stepFunctions(env: { USER_AGENT_EXTRA: string }): SFNClient {
    if (cachedStepFunctionsClient == null) {
      cachedStepFunctionsClient = tracer.captureAWSv3Client(
        new SFNClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedStepFunctionsClient;
  }

  public static ec2(env: { USER_AGENT_EXTRA: string }): EC2Client {
    if (cachedEC2Client == null) {
      cachedEC2Client = tracer.captureAWSv3Client(
        new EC2Client({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedEC2Client;
  }

  public static sts(env: { USER_AGENT_EXTRA: string }): STSClient {
    if (cachedSTSClient == null) {
      cachedSTSClient = tracer.captureAWSv3Client(
        new STSClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedSTSClient;
  }

  public static appConfig(env: { USER_AGENT_EXTRA: string }): AppConfigClient {
    //intentionally not traced in x-ray as this is typically loaded before X-ray has initialized and thus causes errors
    if (cachedAppConfigClient == null) {
      cachedAppConfigClient = new AppConfigClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      });
    }
    return cachedAppConfigClient;
  }

  public static appConfigData(env: {
    USER_AGENT_EXTRA: string;
  }): AppConfigDataClient {
    //intentionally not traced in x-ray as this is typically loaded before X-ray has initialized and thus causes errors
    if (cachedAppConfigDataClient == null) {
      cachedAppConfigDataClient = new AppConfigDataClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      });
    }
    return cachedAppConfigDataClient;
  }

  public static orgs(
    env: { USER_AGENT_EXTRA: string },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): OrganizationsClient {
    if (cachedOrgsClient == null) {
      cachedOrgsClient = tracer.captureAWSv3Client(
        new OrganizationsClient({
          customUserAgent: env.USER_AGENT_EXTRA,
          credentials,
        }),
      );
    }
    return cachedOrgsClient;
  }

  public static iam(
    env: { USER_AGENT_EXTRA: string },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): IAMClient {
    if (cachedIamClient == null) {
      cachedIamClient = tracer.captureAWSv3Client(
        new IAMClient({
          customUserAgent: env.USER_AGENT_EXTRA,
          credentials,
        }),
      );
    }
    return cachedIamClient;
  }

  public static identityStore(
    env: {
      USER_AGENT_EXTRA: string;
    },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): IdentitystoreClient {
    if (cachedIdentitystoreClient == null) {
      cachedIdentitystoreClient = tracer.captureAWSv3Client(
        new IdentitystoreClient({
          customUserAgent: env.USER_AGENT_EXTRA,
          credentials,
        }),
      );
    }
    return cachedIdentitystoreClient;
  }

  public static ssoAdmin(
    env: { USER_AGENT_EXTRA: string },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): SSOAdminClient {
    if (cachedSSOAdminClient == null) {
      cachedSSOAdminClient = tracer.captureAWSv3Client(
        new SSOAdminClient({
          customUserAgent: env.USER_AGENT_EXTRA,
          credentials,
        }),
      );
    }
    return cachedSSOAdminClient;
  }

  public static costExplorer(
    env: {
      USER_AGENT_EXTRA: string;
    },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): CostExplorerClient {
    if (cachedCostExplorerClient == null) {
      cachedCostExplorerClient = tracer.captureAWSv3Client(
        new CostExplorerClient({
          customUserAgent: env.USER_AGENT_EXTRA,
          credentials,
        }),
      );
    }
    return cachedCostExplorerClient;
  }

  public static ses(env: { USER_AGENT_EXTRA: string }): SESClient {
    if (cachedSESClient == null) {
      cachedSESClient = tracer.captureAWSv3Client(
        new SESClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedSESClient;
  }

  public static s3(env: { USER_AGENT_EXTRA: string }): S3Client {
    if (cachedS3Client == null) {
      cachedS3Client = tracer.captureAWSv3Client(
        new S3Client({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedS3Client;
  }

  public static cloudWatchLogs(env: {
    USER_AGENT_EXTRA: string;
  }): CloudWatchLogsClient {
    if (cachedCWLogsClient == null) {
      cachedCWLogsClient = tracer.captureAWSv3Client(
        new CloudWatchLogsClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedCWLogsClient;
  }

  public static cloudWatch(env: {
    USER_AGENT_EXTRA: string;
  }): CloudWatchClient {
    if (cachedCloudWatchClient == null) {
      cachedCloudWatchClient = tracer.captureAWSv3Client(
        new CloudWatchClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedCloudWatchClient;
  }

  public static cloudFormation(env: {
    USER_AGENT_EXTRA: string;
  }): CloudFormationClient {
    if (cachedCloudFormationClient == null) {
      cachedCloudFormationClient = tracer.captureAWSv3Client(
        new CloudFormationClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedCloudFormationClient;
  }

  public static cognitoIdp(env: {
    USER_AGENT_EXTRA: string;
  }): CognitoIdentityProviderClient {
    if (cachedCognitoIdpClient == null) {
      cachedCognitoIdpClient = tracer.captureAWSv3Client(
        new CognitoIdentityProviderClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedCognitoIdpClient;
  }

  public static ssmProvider(env: { USER_AGENT_EXTRA: string }): SSMProvider {
    if (cachedSSMProvider == null) {
      cachedSSMProvider = new SSMProvider({
        clientConfig: {
          customUserAgent: env.USER_AGENT_EXTRA,
        },
      });
    }
    return cachedSSMProvider;
  }

  public static codeBuild(env: { USER_AGENT_EXTRA: string }): CodeBuildClient {
    if (cachedCodeBuildClient == null) {
      cachedCodeBuildClient = tracer.captureAWSv3Client(
        new CodeBuildClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedCodeBuildClient;
  }

  public static lambda(env: { USER_AGENT_EXTRA: string }): LambdaClient {
    if (cachedLambdaClient == null) {
      cachedLambdaClient = tracer.captureAWSv3Client(
        new LambdaClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      );
    }
    return cachedLambdaClient;
  }
}
