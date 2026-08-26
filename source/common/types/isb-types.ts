// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type JSendResponse =
  | JSendSuccessResponse
  | JSendFailResponse
  | JSendErrorResponse;

export type JSendSuccessResponse = {
  status: "success";
  data: JSendData;
};

export type JSendFailResponse = {
  status: "fail";
  data: JSendData;
};

export type JSendErrorResponse = {
  status: "error";
  message: string;
  data?: JSendData;
};

export type JSendData = Record<string, any> & { errors?: JSendErrorObject[] };

export type JSendErrorObject = {
  field?: string;
  message: string;
};

export const SSM_PARAM_NAME_PREFIX = "/InnovationSandbox";
export const SSM_PARAM_NAME_PREFIX_SIMPLE = "InnovationSandbox";
export const SECRET_NAME_PREFIX = "/InnovationSandbox";

/**
 * The CFN `Namespace` parameter's AllowedPattern. Reused by the env-schema
 * validator (`BaseApiLambdaEnvironmentSchema`) and the CDK `NamespaceParam`
 * so the rule lives in one place.
 */
export const NAMESPACE_PATTERN = "^[0-9a-zA-Z]{3,8}$";

export function sharedAccountPoolSsmParamName(namespace: string) {
  return `${SSM_PARAM_NAME_PREFIX_SIMPLE}_${namespace}_AccountPool_Configuration`;
}

export function sharedDataSsmParamName(namespace: string) {
  return `${SSM_PARAM_NAME_PREFIX_SIMPLE}_${namespace}_Data_Configuration`;
}

export function sharedIdcSsmParamName(namespace: string) {
  return `${SSM_PARAM_NAME_PREFIX_SIMPLE}_${namespace}_Idc_Configuration`;
}

export function computeRestApiIdSsmParamName(namespace: string) {
  return `${SSM_PARAM_NAME_PREFIX_SIMPLE}_${namespace}_Compute_RestApiId`;
}

export function identityPoolAdminRoleName(namespace: string) {
  return `${namespace}-isb-admin-role`;
}

export function identityPoolManagerRoleName(namespace: string) {
  return `${namespace}-isb-manager-role`;
}

export function identityPoolUserRoleName(namespace: string) {
  return `${namespace}-isb-user-role`;
}
