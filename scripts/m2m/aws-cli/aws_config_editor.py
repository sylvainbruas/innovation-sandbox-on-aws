#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Surgical editor for AWS CLI profile-scoped service endpoints."""

import fcntl
import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from installer_common import InstallerError, atomic_write


SERVICE_KEY = "isb"
MANAGED_MARKER = "# Managed by install-aws-isb-cli.py"
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
PROFILE_RE = re.compile(r"^[A-Za-z0-9_.@=+-]+$")
SECTION_RE = re.compile(r"^\[([^\]]+)\]\s*$")
TOP_KEY_RE = re.compile(r"^(\S[^=]*?)\s*=\s*(.*?)\s*$")


@dataclass(frozen=True)
class ConfigChange:
    text: str
    section: str
    action: str


def validate_profile_name(profile):
    if not profile or not PROFILE_RE.match(profile):
        raise InstallerError(
            f"invalid profile name {profile!r}: only [A-Za-z0-9_.@+=-] "
            "are permitted."
        )


def config_path_from_env(environ=None):
    environ = os.environ if environ is None else environ
    return Path(
        environ.get("AWS_CONFIG_FILE") or Path.home() / ".aws" / "config"
    ).resolve()


@contextmanager
def locked_config(path):
    """Serialize one config read-modify-write without creating a backup."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(f"{path}.lock")
    with open(lock_path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def write_config(path, text):
    atomic_write(path, text)


class AwsConfig:
    """Line editor for the AWS CLI `[services]` config layout (nested,
    indented sub-keys under each `service =` that need surgical edits)."""

    def __init__(self, text):
        # Detect the file's line terminator so edits round-trip faithfully: a
        # CRLF config must not be rewritten to LF, nor left with mixed endings
        # when new lines are inserted. Split on "\n" only (str.splitlines() also
        # breaks on \r, \v, \f, \x1c-\x1e, NEL) and store each line \r-free -- so
        # the section/key regexes and every emitted line are consistent -- then
        # dumps() re-applies the detected terminator. An empty config stays [] so
        # it round-trips to "".
        self.newline = "\r\n" if "\r\n" in text else "\n"
        self.lines = (
            [line[:-1] if line.endswith("\r") else line for line in text.split("\n")]
            if text
            else []
        )

    def dumps(self):
        # Re-apply the detected terminator; [] restores "" and a trailing "" line
        # restores the file's trailing newline. No line ending is normalized.
        return self.newline.join(self.lines)

    @staticmethod
    def _header(inner):
        inner = inner.strip()
        if inner == "default":
            return "profile", "default"
        parts = inner.split(None, 1)
        if len(parts) == 2 and parts[0] in (
            "profile",
            "services",
            "sso-session",
        ):
            return parts[0], parts[1].strip()
        return "profile", inner

    def _spans(self):
        spans = []
        current = None
        for index, line in enumerate(self.lines):
            match = SECTION_RE.match(line)
            if match:
                if current:
                    spans.append((current[0], current[1], index))
                current = (self._header(match.group(1)), index)
        if current:
            spans.append((current[0], current[1], len(self.lines)))
        return spans

    def find(self, kind, name):
        for header, start, end in self._spans():
            if header == (kind, name):
                return start, end
        return None

    def get_profile_services(self, profile):
        span = self.find("profile", profile)
        if not span:
            return None
        for index in range(span[0] + 1, span[1]):
            match = TOP_KEY_RE.match(self.lines[index])
            if match and match.group(1) == "services":
                return match.group(2) or None
        return None

    def set_profile_services(self, profile, section):
        span = self.find("profile", profile)
        if not span:
            header = "[default]" if profile == "default" else f"[profile {profile}]"
            if self.lines and self.lines[-1].strip():
                self.lines.append("")
            self.lines.extend((header, f"services = {section}"))
            return
        start, end = span
        for index in range(start + 1, end):
            match = TOP_KEY_RE.match(self.lines[index])
            if match and match.group(1) == "services":
                self.lines[index] = f"services = {section}"
                return
        self.lines.insert(start + 1, f"services = {section}")

    def clear_profile_services(self, profile, expected):
        span = self.find("profile", profile)
        if not span:
            return
        for index in range(span[0] + 1, span[1]):
            match = TOP_KEY_RE.match(self.lines[index])
            if (
                match
                and match.group(1) == "services"
                and (match.group(2) or None) == expected
            ):
                del self.lines[index]
                return

    def remove_profile_if_empty(self, profile):
        span = self.find("profile", profile)
        if not span:
            return
        start, end = span
        if any(line.strip() for line in self.lines[start + 1 : end]):
            return
        if end < len(self.lines) and not self.lines[end].strip():
            end += 1
        del self.lines[start:end]

    def profiles_referencing(self, section):
        return [
            header[1]
            for header, _, _ in self._spans()
            if header[0] == "profile"
            and self.get_profile_services(header[1]) == section
        ]

    def _subsections(self, section):
        span = self.find("services", section)
        if not span:
            return None, {}
        _, end = span
        subsections = {}
        index = span[0] + 1
        while index < end:
            match = TOP_KEY_RE.match(self.lines[index])
            if match and self.lines[index][0] not in " \t":
                service = match.group(1)
                body_end = index + 1
                while body_end < end and (
                    not self.lines[body_end].strip()
                    or self.lines[body_end][0] in " \t"
                ):
                    body_end += 1
                subsections[service] = (index, body_end)
                index = body_end
            else:
                index += 1
        return span, subsections

    def is_managed(self, section):
        span = self.find("services", section)
        return bool(
            span
            and MANAGED_MARKER in self.lines[span[0] + 1 : span[1]]
        )

    def mark_managed(self, section):
        span = self.find("services", section)
        if not span:
            raise InstallerError(f"services section {section!r} does not exist.")
        if not self.is_managed(section):
            self.lines.insert(span[0] + 1, MANAGED_MARKER)

    def clear_managed_marker(self, section):
        span = self.find("services", section)
        if not span:
            return
        for index in range(span[0] + 1, span[1]):
            if self.lines[index] == MANAGED_MARKER:
                del self.lines[index]
                return

    def has_service(self, section, service):
        _, subsections = self._subsections(section)
        return service in subsections

    def get_service_endpoint(self, section, service):
        _, subsections = self._subsections(section)
        if service not in subsections:
            return None
        start, end = subsections[service]
        for index in range(start + 1, end):
            match = TOP_KEY_RE.match(self.lines[index].strip())
            if match and match.group(1) == "endpoint_url":
                return match.group(2) or None
        return None

    def set_service_endpoint(self, section, service, endpoint):
        span = self.find("services", section)
        if not span:
            if self.lines and self.lines[-1].strip():
                self.lines.append("")
            self.lines.extend(
                (
                    f"[services {section}]",
                    f"{service} =",
                    f"  endpoint_url = {endpoint}",
                )
            )
            return
        _, subsections = self._subsections(section)
        if service in subsections:
            start, end = subsections[service]
            for index in range(start + 1, end):
                match = TOP_KEY_RE.match(self.lines[index].strip())
                if match and match.group(1) == "endpoint_url":
                    self.lines[index] = f"  endpoint_url = {endpoint}"
                    return
            self.lines.insert(start + 1, f"  endpoint_url = {endpoint}")
            return
        self.lines[span[1] : span[1]] = (
            f"{service} =",
            f"  endpoint_url = {endpoint}",
        )

    def remove_service(self, section, service):
        _, subsections = self._subsections(section)
        if service in subsections:
            start, end = subsections[service]
            del self.lines[start:end]

    def service_count(self, section):
        _, subsections = self._subsections(section)
        return len(subsections)

    def clone_services(self, source, destination):
        span = self.find("services", source)
        body = [] if not span else self.lines[span[0] + 1 : span[1]]
        if self.lines and self.lines[-1].strip():
            self.lines.append("")
        self.lines.extend((f"[services {destination}]", *body))

    def remove_services_section(self, section):
        span = self.find("services", section)
        if not span:
            return
        start, end = span
        if end < len(self.lines) and not self.lines[end].strip():
            end += 1
        del self.lines[start:end]


def _new_section(config, profile):
    section = f"isb-cli-{profile}"
    if config.find("services", section) is None:
        return section
    raise InstallerError(
        f"[services {section}] already exists and is not the selected "
        "profile's exclusive managed section. Remove or rename that section "
        "before rerunning the installer."
    )


def configure_endpoint(text, profile, endpoint):
    validate_profile_name(profile)
    # The endpoint is written verbatim into ~/.aws/config; reject control chars
    # (esp. newlines) so a value can't inject extra config lines. Defense in depth:
    # the only caller already validates via endpoint_resolver.validate_api_url.
    if CONTROL_CHARS_RE.search(endpoint):
        raise InstallerError(
            f"invalid endpoint {endpoint!r}: control characters are not permitted."
        )
    config = AwsConfig(text)
    current = config.get_profile_services(profile)
    expected_section = f"isb-cli-{profile}"

    if current == expected_section:
        # The profile already points at its own deterministic section. Re-adopt it
        # in place (re-add `isb` + re-mark managed) whether it is still marked or
        # was left unmanaged by a prior uninstall that preserved cloned services --
        # and even if another profile also references it, it is still ours. This
        # avoids a `_new_section` collision on the install -> uninstall -> reinstall
        # path.
        section = current
        action = "update"
    else:
        if current and config.is_managed(current):
            # A managed section under a different (legacy) name -- refuse to guess.
            raise InstallerError(
                f"profile {profile!r} points at obsolete managed section "
                f"[services {current}]. Run --uninstall for this profile, then "
                "run the installer again."
            )
        section = _new_section(config, profile)
        if current:
            config.clone_services(current, section)
            action = "clone"
        else:
            action = "create"
        config.set_profile_services(profile, section)

    config.set_service_endpoint(section, SERVICE_KEY, endpoint)
    config.mark_managed(section)
    return ConfigChange(config.dumps(), section, action)


def remove_endpoint(text, profile):
    validate_profile_name(profile)
    config = AwsConfig(text)
    section = config.get_profile_services(profile)
    if not section or not config.has_service(section, SERVICE_KEY):
        raise InstallerError(
            f"profile {profile!r} has no configured `isb` endpoint."
        )
    if not config.is_managed(section):
        raise InstallerError(
            f"[services {section}] is not managed by this installer; "
            "remove its `isb` entry manually."
        )

    other_profiles = [
        item for item in config.profiles_referencing(section) if item != profile
    ]
    if other_profiles:
        names = ", ".join(sorted(other_profiles))
        raise InstallerError(
            f"[services {section}] is also referenced by profile(s) {names}; "
            "refusing to change their endpoint. Remove those references "
            "before uninstalling."
        )

    config.remove_service(section, SERVICE_KEY)
    config.clear_managed_marker(section)
    if config.service_count(section) == 0:
        config.remove_services_section(section)
        config.clear_profile_services(profile, section)
        config.remove_profile_if_empty(profile)
    return ConfigChange(config.dumps(), section, "uninstall")
