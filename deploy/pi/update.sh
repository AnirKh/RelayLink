#!/bin/sh
# Brings the Pi's copy of Direct Connection up to date with GitHub, and
# restarts the server only when something changed. Installed as
# /usr/local/sbin/direct-connection-update and run by the update timer — see
# deploy/pi/SETUP.md.
#
# Only as far as GitHub's tests have passed: a push whose tests fail never
# reaches the Pi, and one still being tested waits for them. GitHub Pages is
# not held back this way.
#
# Runs as root only to restart the service. Everything that touches what came
# from GitHub — git, npm, node — runs as the server's own user, dc. npm installs
# with --ignore-scripts: no package's install script runs here.
set -eu

DIR=/opt/direct-connection
as_dc() { runuser -u dc -- env HOME=/var/lib/direct-connection "$@"; }

cd "$DIR"
as_dc git fetch --quiet origin main
if [ "$(as_dc git rev-parse HEAD)" = "$(as_dc git rev-parse origin/main)" ]; then
  exit 0
fi
# The newest commit between here and origin/main that GitHub's tests passed
# (deploy/pi/ci-passed.js — the copy at HEAD, which passed). None yet: still
# being tested, or failed — stay as we are, and look again at the next tick.
TARGET=$(as_dc node deploy/pi/ci-passed.js $(as_dc git rev-list --max-count=50 HEAD..origin/main))
if [ -z "$TARGET" ]; then
  echo "Waiting for GitHub's tests to pass for $(as_dc git rev-parse --short origin/main)"
  exit 0
fi
as_dc git merge --ff-only --quiet "$TARGET"
as_dc npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
systemctl restart direct-connection
echo "Direct Connection updated to $(as_dc git rev-parse --short HEAD)"
