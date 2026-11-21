#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Let Chromium's page sandbox start on Linux systems that restrict unprivileged user namespaces (Ubuntu 24.04 and later).
#
#   sudo apps/browser/scripts/linux-sandbox.sh /path/to/electron
#
# On those systems the browser stops at start-up with "The SUID sandbox helper binary was found, but is not configured
# correctly". This loads an AppArmor profile that allows user namespaces for that one binary, and nothing else. The
# sandbox itself stays on, so --no-sandbox is never needed. Run it again when the binary moves.
#
# Elsewhere it does nothing: no AppArmor, or no restriction.
set -eu

bin=${1:?usage: linux-sandbox.sh /path/to/electron}
[ -x "$bin" ] || { echo "not an executable: $bin" >&2; exit 2; }
case "$bin" in *'"'*) echo "path must not contain a double quote" >&2; exit 2 ;; esac

restrict=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [ ! -r "$restrict" ] || [ "$(cat "$restrict")" != 1 ]; then
  echo "user namespaces are not restricted here; nothing to do"
  exit 0
fi
command -v apparmor_parser >/dev/null || { echo "apparmor_parser not found" >&2; exit 1; }

profile=/etc/apparmor.d/dbbasic-electron
cat > "$profile" <<EOF
abi <abi/4.0>,
include <tunables/global>

profile dbbasic-electron "$bin" flags=(unconfined) {
  userns,
  include if exists <local/dbbasic-electron>
}
EOF
apparmor_parser -r "$profile"
echo "loaded $profile for $bin"
