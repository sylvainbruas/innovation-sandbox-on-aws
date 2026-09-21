#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Shared primitives for the `aws isb` installer modules."""

import errno
import os
import tempfile
from pathlib import Path


class InstallerError(Exception):
    """User-facing installer failure."""


_DIR_FSYNC_UNSUPPORTED = {
    errno.EINVAL,
    getattr(errno, "ENOTSUP", errno.EINVAL),
    getattr(errno, "EOPNOTSUPP", errno.EINVAL),
}


def fsync_dir(path):
    """Persist directory entry changes when the filesystem supports it."""
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError as exc:
        if exc.errno in _DIR_FSYNC_UNSUPPORTED:
            return
        raise
    try:
        os.fsync(fd)
    except OSError as exc:
        if exc.errno not in _DIR_FSYNC_UNSUPPORTED:
            raise
    finally:
        os.close(fd)


def fsync_file(path):
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path, text):
    """Replace one text file atomically while preserving its existing mode."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.name}.",
    )
    # os.fdopen takes ownership of `fd` only once it succeeds; until then close it
    # ourselves so a failing fdopen (e.g. EMFILE/ENOMEM) doesn't leak the descriptor.
    stream = None
    try:
        # newline="" writes the string verbatim (no \n -> os.linesep translation),
        # so a caller preserving the file's original line endings round-trips exactly.
        stream = os.fdopen(fd, "w", newline="")
        with stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        fsync_dir(path.parent)
    except BaseException:
        if stream is None:
            os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise
