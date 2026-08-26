// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { IsbRole } from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";

export type HttpMethod =
  | "OPTIONS"
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "TRACE"
  | "CONNECT"
  | "ALL";

export interface AuthorizationMapType {
  [path: string]: {
    [method in HttpMethod]?: IsbRole[];
  };
}

export const authorizationMap: AuthorizationMapType = {
  "/leases": {
    GET: ["Manager", "Admin", "User"],
    POST: ["User", "Manager", "Admin"],
  },
  "/leases/{param}": {
    PATCH: ["Manager", "Admin"],
    GET: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/review": {
    POST: ["Manager", "Admin"],
  },
  "/leases/{param}/terminate": {
    POST: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/freeze": {
    POST: ["Manager", "Admin"],
  },
  "/leases/{param}/unfreeze": {
    POST: ["Manager", "Admin"],
  },
  "/leaseTemplates": {
    GET: ["User", "Manager", "Admin"],
    POST: ["Admin", "Manager"],
  },
  "/leaseTemplates/{param}": {
    GET: ["User", "Manager", "Admin"],
    DELETE: ["Admin", "Manager"],
    PUT: ["Admin", "Manager"],
  },
  "/configurations": {
    GET: ["Manager", "Admin", "User"],
  },
  "/configurations/{param}": {
    GET: ["Manager", "Admin", "User"],
    PUT: ["Admin"],
  },
  "/accounts": {
    GET: ["Admin"],
    POST: ["Admin"],
  },
  "/accounts/{param}": {
    GET: ["Admin"],
  },
  "/accounts/{param}/retryCleanup": {
    POST: ["Admin"],
  },
  "/accounts/{param}/eject": {
    POST: ["Admin"],
  },
  "/accounts/{param}/quarantine": {
    POST: ["Admin"],
  },
  "/accounts/unregistered": {
    GET: ["Admin"],
  },
  "/accounts/{param}/cleanup-reports": {
    GET: ["Admin"],
  },
  "/accounts/{param}/skipCooldown": {
    POST: ["Admin"],
  },
  "/blueprints": {
    GET: ["Manager", "Admin"], // Managers can view for template selection
    POST: ["Admin"], // Only admins can create
  },
  "/blueprints/stacksets": {
    GET: ["Manager", "Admin"], // Managers need this for template creation
  },
  "/blueprints/{param}": {
    GET: ["Manager", "Admin"], // Managers can view for template selection
    PUT: ["Admin"], // Only admins can update
    DELETE: ["Admin"], // Only admins can delete
  },
  "/principals/search": {
    GET: ["User", "Manager", "Admin"],
  },
  "/leases/{param}/assignments": {
    GET: ["User", "Manager", "Admin"],
    PUT: ["User", "Manager", "Admin"],
  },
  "/leases/shared": {
    GET: ["User", "Manager", "Admin"],
  },
};
