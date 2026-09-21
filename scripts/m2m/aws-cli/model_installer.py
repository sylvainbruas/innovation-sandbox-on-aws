#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Install the deployment-agnostic AWS CLI model with forward recovery."""

import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from installer_common import (
    InstallerError,
    atomic_write,
    fsync_dir,
    fsync_file,
)


MIN_CLI = (2, 13, 0)
SERVICE_KEY = "isb"
MODEL_FILES = ("service-2.json", "paginators-1.json")
DOWNLOAD_TIMEOUT = 30
API_VERSION_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def check_cli_version():
    try:
        result = subprocess.run(
            ["aws", "--version"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise InstallerError(f"AWS CLI not found or not runnable: {exc}") from exc
    output = result.stdout or result.stderr
    match = re.search(r"aws-cli/(\d+)\.(\d+)\.(\d+)", output)
    if not match:
        raise InstallerError(
            f"could not parse AWS CLI version from: {output.strip()}"
        )
    version = tuple(int(value) for value in match.groups())
    if version < MIN_CLI:
        minimum = ".".join(map(str, MIN_CLI))
        raise InstallerError(
            f"AWS CLI {'.'.join(map(str, version))} is too old; "
            f"service-specific endpoints require >= {minimum}."
        )
    return version


class _HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        if urllib.parse.urlsplit(new_url).scheme != "https":
            raise InstallerError(
                f"refusing a redirect to a non-https URL ({new_url})."
            )
        return super().redirect_request(
            request,
            fp,
            code,
            message,
            headers,
            new_url,
        )


def _download(url, destination):
    if urllib.parse.urlsplit(url).scheme != "https":
        raise InstallerError(f"--model-url must be https, refusing {url}.")
    opener = urllib.request.build_opener(_HttpsOnlyRedirect())
    try:
        with opener.open(url, timeout=DOWNLOAD_TIMEOUT) as response:
            if urllib.parse.urlsplit(response.url).scheme != "https":
                raise InstallerError(
                    f"refusing {url}: it resolved to {response.url}."
                )
            with open(destination, "wb") as stream:
                shutil.copyfileobj(response, stream)
    except OSError as exc:
        raise InstallerError(f"failed to download {url}: {exc}") from exc


def resolve_model_dir(model_dir, model_url, script_dir):
    if model_url:
        destination = Path(tempfile.mkdtemp(prefix="isb-cli-model."))
        try:
            for name in MODEL_FILES:
                _download(
                    f"{model_url.rstrip('/')}/{name}",
                    destination / name,
                )
        except BaseException:
            shutil.rmtree(destination, ignore_errors=True)
            raise
        return destination, True

    candidates = (
        [Path(model_dir)]
        if model_dir
        else [
            Path(script_dir),
            Path(script_dir) / ".." / ".." / ".." / "docs" / "aws-cli-model",
        ]
    )
    for candidate in candidates:
        if all((candidate / name).is_file() for name in MODEL_FILES):
            return candidate.resolve(), False
    raise InstallerError(
        "could not find service-2.json and paginators-1.json; "
        "pass --model-dir or --model-url."
    )


def model_api_version(model_dir):
    try:
        metadata = json.loads(
            (Path(model_dir) / "service-2.json").read_text()
        )["metadata"]
    except (json.JSONDecodeError, KeyError) as exc:
        raise InstallerError(
            "service-2.json does not contain valid model metadata."
        ) from exc
    version = metadata.get("apiVersion", "")
    if not API_VERSION_RE.match(version):
        raise InstallerError(
            f"service-2.json apiVersion {version!r} is not YYYY-MM-DD."
        )
    return version


def models_root():
    return Path.home() / ".aws" / "models" / SERVICE_KEY


def _model_digest(model_dir):
    directory = Path(model_dir)
    if not directory.exists():
        return None
    digest = hashlib.sha256()
    for name in MODEL_FILES:
        model_file = directory / name
        if not model_file.is_file():
            return None
        digest.update(name.encode())
        digest.update(model_file.read_bytes())
    return digest.hexdigest()


def models_match(api_version, source):
    destination = models_root() / api_version
    return all(
        (destination / name).is_file()
        and (destination / name).read_bytes()
        == (Path(source) / name).read_bytes()
        for name in MODEL_FILES
    )


def _transaction_path():
    return models_root() / ".model-txn.json"


def _validate_transaction(transaction):
    if not isinstance(transaction, dict) or set(transaction) != {
        "dest",
        "staged",
        "new_sha",
    }:
        raise InstallerError(
            "model transaction marker has an unrecognized schema."
        )
    root = models_root()
    if (
        not isinstance(transaction["dest"], str)
        or not isinstance(transaction["staged"], str)
        or not isinstance(transaction["new_sha"], str)
    ):
        raise InstallerError(
            "model transaction marker contains non-string values."
        )
    destination = Path(transaction["dest"])
    staged = Path(transaction["staged"])
    if (
        destination.parent != root
        or not API_VERSION_RE.match(destination.name)
        or staged.parent != root
        or not staged.name.startswith(".staging-")
        or destination == staged
        or destination.is_symlink()
        or staged.is_symlink()
        or not SHA256_RE.match(transaction["new_sha"])
    ):
        raise InstallerError("model transaction marker contains unsafe values.")
    return destination, staged, transaction["new_sha"]


def _sweep_temporary_directories():
    for pattern in (".staging-*", ".old-*"):
        for path in models_root().glob(pattern):
            shutil.rmtree(path, ignore_errors=True)


def _replace_directory(destination, staged):
    root = models_root()
    old = None
    try:
        if destination.exists():
            old = Path(tempfile.mkdtemp(dir=str(root), prefix=".old-"))
            old.rmdir()
            os.replace(destination, old)
        os.replace(staged, destination)
        fsync_dir(root)
    except BaseException:
        if old is not None and old.exists() and not destination.exists():
            try:
                os.replace(old, destination)
                fsync_dir(root)
            except OSError as restore_error:
                raise InstallerError(
                    "model replacement failed and the previous model could "
                    f"not be restored; it remains at {old}: {restore_error}"
                ) from restore_error
        raise
    finally:
        if old is not None and old.exists() and destination.exists():
            shutil.rmtree(old, ignore_errors=True)


def _recover():
    marker = _transaction_path()
    if not marker.exists():
        _sweep_temporary_directories()
        return
    try:
        transaction = json.loads(marker.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise InstallerError(
            f"model transaction marker {marker} is unreadable."
        ) from exc
    destination, staged, expected = _validate_transaction(transaction)
    if _model_digest(destination) == expected:
        pass
    elif _model_digest(staged) == expected:
        _replace_directory(destination, staged)
    marker.unlink()
    fsync_dir(models_root())
    _sweep_temporary_directories()


@contextmanager
def _model_lock():
    root = models_root()
    root.mkdir(parents=True, exist_ok=True)
    with open(root / ".install.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            _recover()
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def install_model(model_dir, api_version, force=False):
    with _model_lock():
        if models_match(api_version, model_dir):
            return False
        destination = models_root() / api_version
        if destination.exists() and not force:
            raise InstallerError(
                f"{destination} exists with different content; "
                "pass --force to replace it."
            )

        staged = Path(
            tempfile.mkdtemp(dir=str(models_root()), prefix=".staging-")
        )
        try:
            for name in MODEL_FILES:
                shutil.copyfile(Path(model_dir) / name, staged / name)
                fsync_file(staged / name)
            fsync_dir(staged)
            marker = {
                "dest": str(destination),
                "staged": str(staged),
                "new_sha": _model_digest(staged),
            }
            atomic_write(_transaction_path(), json.dumps(marker))
            _replace_directory(destination, staged)
            _transaction_path().unlink()
            fsync_dir(models_root())
            return True
        except BaseException:
            shutil.rmtree(staged, ignore_errors=True)
            raise


def purge_models():
    """Delete every installed version of the global ISB model."""
    with _model_lock():
        removed = False
        # Snapshot entries first: the loop creates .old-* dirs inside models_root,
        # and mutating a directory during a live iterdir()/scandir walk has
        # unspecified behavior (entries may be skipped or repeated) per POSIX.
        for child in list(models_root().iterdir()):
            if child.is_dir() and API_VERSION_RE.match(child.name):
                old = Path(
                    tempfile.mkdtemp(
                        dir=str(models_root()),
                        prefix=".old-",
                    )
                )
                old.rmdir()
                os.replace(child, old)
                fsync_dir(models_root())
                shutil.rmtree(old)
                removed = True
        return removed
