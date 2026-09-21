#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Install the model and endpoint configuration for `aws isb`."""

import argparse
import shutil
import sys
from pathlib import Path

from aws_config_editor import (
    config_path_from_env,
    configure_endpoint,
    locked_config,
    remove_endpoint,
    validate_profile_name,
    write_config,
)
from endpoint_resolver import add_endpoint_arguments, resolve_endpoint
from installer_common import InstallerError
from model_installer import (
    check_cli_version,
    install_model,
    model_api_version,
    purge_models,
    resolve_model_dir,
)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="install-aws-isb-cli.py",
        description=(
            "Install the `aws isb` model and persist its API endpoint."
        ),
    )
    parser.add_argument(
        "--profile",
        help=(
            "AWS config profile whose services pointer is updated. "
            "Defaults to [default]. Endpoint discovery still uses ambient "
            "credentials."
        ),
    )
    add_endpoint_arguments(parser)
    parser.add_argument(
        "--model-dir",
        help=(
            "Directory containing the model files; defaults to colocated "
            "files or docs/aws-cli-model."
        ),
    )
    parser.add_argument(
        "--model-url",
        help=(
            "Base HTTPS URL to download the model files from (https only)."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace installed model files when their content differs.",
    )
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help=(
            "Remove the installer-managed endpoint from --profile or "
            "[default]."
        ),
    )
    parser.add_argument(
        "--purge-model",
        action="store_true",
        help=(
            "With --uninstall, remove all globally installed ISB model "
            "versions; requires --yes."
        ),
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm --purge-model.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Print intended persistent changes without writing. Endpoint "
            "lookups and model downloads still run for validation."
        ),
    )
    return parser


def _read_config(path):
    # Read bytes, not read_text(): the latter's universal-newline mode collapses
    # \r\n -> \n on read, which would defeat the config editor's line-ending
    # preservation before it ever sees the file.
    return path.read_bytes().decode("utf-8") if path.exists() else ""


def _install(args, profile):
    check_cli_version()
    script_dir = Path(__file__).resolve().parent
    model_dir, temporary = resolve_model_dir(
        args.model_dir,
        args.model_url,
        script_dir,
    )
    try:
        api_version = model_api_version(model_dir)
        endpoint = resolve_endpoint(args)
        for warning in endpoint.warnings:
            print(
                f"install-aws-isb-cli: warning: {warning}",
                file=sys.stderr,
            )
        config_path = config_path_from_env()
        preview = configure_endpoint(
            _read_config(config_path),
            profile,
            endpoint.api_url,
        )
        plan = (
            f"model: ~/.aws/models/isb/{api_version}/"
            "{service-2,paginators-1}.json\n"
            f"profile: {profile}\n"
            f"services section: {preview.section} ({preview.action})\n"
            f"endpoint: {endpoint.api_url}"
        )
        if args.dry_run:
            print("DRY RUN - would apply:\n" + plan)
            return

        install_model(model_dir, api_version, args.force)

        # Re-read under the lock so concurrent config edits are not lost.
        with locked_config(config_path):
            current = _read_config(config_path)
            change = configure_endpoint(
                current,
                profile,
                endpoint.api_url,
            )
            if change.text != current:
                write_config(config_path, change.text)

        profile_section = (
            "[default]" if profile == "default" else f"[profile {profile}]"
        )
        profile_option = (
            "" if profile == "default" else f" --profile {profile}"
        )
        print(f"Configured {profile_section} -> {endpoint.api_url}")
        print(f"Example: aws isb list-lease-templates{profile_option}")
    finally:
        if temporary:
            shutil.rmtree(model_dir, ignore_errors=True)


def _uninstall(args, profile):
    if args.purge_model and not args.yes and not args.dry_run:
        raise InstallerError(
            "--purge-model removes the global ISB model for every profile; "
            "re-run with --yes."
        )
    config_path = config_path_from_env()

    def plan_removal(text):
        # --purge-model is a global action independent of any profile's config, so
        # a missing/unowned `isb` endpoint must warn rather than abort the purge.
        try:
            return remove_endpoint(text, profile), None
        except InstallerError as exc:
            if args.purge_model:
                return None, str(exc)
            raise

    change, warning = plan_removal(_read_config(config_path))
    if args.dry_run:
        removal = (
            f"skip config removal ({warning})"
            if change is None
            else f"remove the `isb` endpoint for profile {profile}"
        )
        suffix = " and purge the global model" if args.purge_model else ""
        print(f"DRY RUN - would {removal}{suffix}.")
        return

    with locked_config(config_path):
        current = _read_config(config_path)
        change, warning = plan_removal(current)
        if change is not None and change.text != current:
            write_config(config_path, change.text)
    if warning is not None:
        print(
            f"install-aws-isb-cli: {warning} Proceeding with --purge-model.",
            file=sys.stderr,
        )
    # The endpoint removal and the global model purge are independent actions;
    # report each one that actually happened.
    if change is not None:
        print(f"Removed the `isb` endpoint for profile {profile}.")
    if args.purge_model:
        purge_models()
        print("Purged the global ISB model.")


def main(argv=None):
    args = build_parser().parse_args(argv)
    profile = args.profile or "default"
    try:
        validate_profile_name(profile)
        if args.uninstall:
            if args.api_url or args.client_stack:
                raise InstallerError(
                    "--api-url and --client-stack cannot be used with "
                    "--uninstall."
                )
            if args.model_dir or args.model_url or args.force:
                raise InstallerError(
                    "model install options cannot be used with --uninstall."
                )
            _uninstall(args, profile)
        else:
            if args.purge_model or args.yes:
                raise InstallerError(
                    "--purge-model and --yes require --uninstall."
                )
            _install(args, profile)
    except InstallerError as exc:
        print(f"install-aws-isb-cli: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
