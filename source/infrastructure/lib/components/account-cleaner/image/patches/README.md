# aws-nuke Patches

This directory contains optional patch files applied to the aws-nuke source
during the Docker image build. Patches use standard unified diff format
and are applied in alphabetical order via `patch -p1`.

When this directory contains no `.patch` files, vanilla upstream aws-nuke is
built.

## Patch naming

Use the convention `NNN-short-description.patch` (e.g.,
`001-fix-loggroup-discovery.patch`). Patches are applied in alphabetical
order.

## Updating aws-nuke version

When upgrading aws-nuke, update both `AWS_NUKE_VERSION` and
`AWS_NUKE_SOURCE_SHA256` in the Dockerfile, verify existing patches still
apply cleanly, and remove any that are now included upstream.
