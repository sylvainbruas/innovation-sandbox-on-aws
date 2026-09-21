#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Resolve and validate the deployment-specific ISB API endpoint."""

import json
import os
import re
import subprocess
import urllib.parse
from dataclasses import dataclass

from installer_common import InstallerError


CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
APIGW_HOST_RE = re.compile(
    r"^([a-z0-9]+)\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$"
)


@dataclass(frozen=True)
class ResolvedEndpoint:
    api_url: str
    region: str
    source: str
    warnings: tuple = ()


def add_endpoint_arguments(parser):
    endpoints = parser.add_mutually_exclusive_group()
    endpoints.add_argument(
        "--api-url",
        help=(
            "API Gateway URL: "
            "https://<api-id>.execute-api.<region>.amazonaws.com/prod"
        ),
    )
    endpoints.add_argument(
        "--client-stack",
        help=(
            "M2M client stack used to resolve ApiGatewayUrl with ambient "
            "AWS credentials."
        ),
    )
    parser.add_argument(
        "--namespace",
        help=(
            "ISB namespace; defaults to the client stack's Namespace parameter."
        ),
    )
    parser.add_argument(
        "--region",
        help=(
            "AWS region for discovery calls. Defaults to AWS_REGION, then "
            "AWS_DEFAULT_REGION, then the AWS CLI's own resolution (e.g. the "
            "profile default in ~/.aws/config)."
        ),
    )


def _aws(args, *, region=None, runner=subprocess.run):
    # When no region was explicitly chosen (flag or env), omit --region so the
    # AWS CLI resolves it through its own chain, including the profile default in
    # ~/.aws/config. Forcing a hardcoded default here would silently issue calls
    # against the wrong region for an operator configured only via ~/.aws/config.
    cmd = ["aws", *args]
    if region:
        cmd += ["--region", region]
    try:
        proc = runner(cmd, capture_output=True, text=True)
    except OSError as exc:
        raise InstallerError(f"AWS CLI not found or not runnable: {exc}") from exc
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip()
        raise InstallerError(f"`{' '.join(cmd)}` failed: {detail}")
    return proc.stdout


def validate_api_url(url, expected_region=None):
    if not isinstance(url, str) or CONTROL_CHARS_RE.search(url):
        raise InstallerError("API URL contains control characters.")
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https":
        raise InstallerError(
            f"API URL must be https, got {parts.scheme or '(missing scheme)'}."
        )
    if parts.username or parts.password:
        raise InstallerError("API URL must not contain user information.")
    if parts.query or parts.fragment:
        raise InstallerError("API URL must not contain a query string or fragment.")
    try:
        port = parts.port
    except ValueError as exc:
        raise InstallerError("API URL has an invalid port.") from exc
    if port:
        raise InstallerError("API URL must not specify a port.")
    match = APIGW_HOST_RE.match(parts.hostname or "")
    if not match:
        raise InstallerError(
            f"API URL host {parts.hostname!r} is not a canonical API Gateway host "
            "(<api-id>.execute-api.<region>.amazonaws.com)."
        )
    segments = [segment for segment in parts.path.split("/") if segment]
    if segments != ["prod"]:
        actual = "/".join(segments)
        raise InstallerError(
            f"API URL stage must be exactly /prod, got /{actual}."
        )
    api_id, endpoint_region = match.groups()
    if expected_region is not None and endpoint_region != expected_region:
        raise InstallerError(
            f"API URL region {endpoint_region} does not match region "
            f"{expected_region}."
        )
    return url.rstrip("/"), api_id, endpoint_region


def _load_json(payload, command):
    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise InstallerError(
            f"`aws {command}` returned invalid JSON: {exc}"
        ) from exc


def _stack_parameter(stack, name):
    for parameter in stack.get("Parameters", []):
        if parameter.get("ParameterKey") == name:
            return parameter.get("ParameterValue")
    return None


def _stack_output(stack, name):
    values = [
        output.get("OutputValue")
        for output in stack.get("Outputs", [])
        if output.get("OutputKey") == name
    ]
    if len(values) != 1 or not values[0]:
        raise InstallerError(
            f"client stack must have exactly one non-empty {name} output."
        )
    return values[0]


def resolve_endpoint(args, *, runner=subprocess.run, environ=None):
    environ = os.environ if environ is None else environ
    # An explicitly chosen region (flag or env) is enforced against the endpoint
    # and passed to the AWS CLI; otherwise it stays None so the CLI resolves the
    # region itself and the endpoint's region is derived from the URL host.
    explicit_region = (
        args.region
        or environ.get("AWS_REGION")
        or environ.get("AWS_DEFAULT_REGION")
    )
    if args.api_url:
        api_url, _, endpoint_region = validate_api_url(
            args.api_url, explicit_region
        )
        return ResolvedEndpoint(api_url, endpoint_region, "api-url")
    if not args.client_stack:
        raise InstallerError("one of --api-url or --client-stack is required.")

    response = _load_json(
        _aws(
            [
                "cloudformation",
                "describe-stacks",
                "--stack-name",
                args.client_stack,
                "--output",
                "json",
            ],
            region=explicit_region,
            runner=runner,
        ),
        "cloudformation describe-stacks",
    )
    stacks = response.get("Stacks")
    if not isinstance(stacks, list) or len(stacks) != 1:
        raise InstallerError(
            f"expected exactly one client stack named {args.client_stack!r}."
        )
    stack = stacks[0]
    api_url, api_id, endpoint_region = validate_api_url(
        _stack_output(stack, "ApiGatewayUrl"),
        explicit_region,
    )
    namespace = args.namespace or _stack_parameter(stack, "Namespace")
    if not namespace:
        warning = (
            "could not verify whether the client stack endpoint is current "
            "because no namespace was provided or found on the stack."
        )
        return ResolvedEndpoint(
            api_url,
            endpoint_region,
            "client-stack",
            (warning,),
        )

    parameter_name = f"InnovationSandbox_{namespace}_Compute_RestApiId"
    try:
        current_api = _load_json(
            _aws(
                [
                    "ssm",
                    "get-parameter",
                    "--name",
                    parameter_name,
                    "--output",
                    "json",
                ],
                region=explicit_region,
                runner=runner,
            ),
            "ssm get-parameter",
        ).get("Parameter", {}).get("Value")
    except InstallerError as exc:
        warning = (
            "could not verify whether the client stack endpoint is current: "
            f"{exc}"
        )
        return ResolvedEndpoint(
            api_url,
            endpoint_region,
            "client-stack",
            (warning,),
        )
    if not current_api:
        warning = (
            f"could not verify whether the client stack endpoint is current: "
            f"SSM parameter {parameter_name!r} has no RestApiId value."
        )
        return ResolvedEndpoint(
            api_url,
            endpoint_region,
            "client-stack",
            (warning,),
        )
    if current_api != api_id:
        raise InstallerError(
            f"client stack {args.client_stack} resolves API {api_id!r}, but "
            f"the Compute stack's current API is {current_api!r}; redeploy the "
            "client stack before installing."
        )
    return ResolvedEndpoint(api_url, endpoint_region, "client-stack")
