#!/bin/bash
# build-deb.sh — build the cleave .deb. Prints the .deb path.
#
# The package is named for the tool, not the framework: it installs a
# command-line program plus the Axe assets that program inlines, as its own
# private data under /usr/share/cleave. Installing it does not deploy Axe to a
# web root, and nothing on a Debian box consumes Axe from /usr/share — sites
# get Axe from the repository, by symlink or by vendoring.
#
# Publish it with the excelano-apt repo:
#   ./add-deb.sh "$(~/axe/packaging/build-deb.sh)" && ./rebuild.sh

set -euo pipefail

# Without this the builder's umask reaches the package: a 002 umask ships
# group-writable directories, which is wrong for anything under /usr.
umask 022

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The version comes from the same stamp set-version.sh writes, so the package
# cannot drift from the Axe it carries and there is no second place to bump.
VER=$(sed -n 's/.*--axe-version: "\([^"]*\)".*/\1/p' "$ROOT/axe.css" | head -1)
[ -n "$VER" ] || { echo "could not read --axe-version from $ROOT/axe.css" >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
chmod 0755 "$STAGE"

DATA="$STAGE/usr/share/cleave"
mkdir -p "$STAGE/DEBIAN" "$STAGE/usr/bin" "$STAGE/usr/share/doc/cleave"

sed "s/@VERSION@/$VER/" "$ROOT/packaging/control.in" > "$STAGE/DEBIAN/control"

install -m 0755 "$ROOT/cli/cleave.py" "$STAGE/usr/bin/cleave"

# The asset list comes from cleave itself rather than being restated here, so
# a newly inlined file cannot ship in the tool and go missing from the package.
# It is only what cleave reads — not the whole framework: no kitchen-sink, no
# brand-builder, no samples.
ASSETS=$(cd "$ROOT/cli" && python3 -c 'import cleave; print("\n".join(cleave.ASSETS))')
[ -n "$ASSETS" ] || { echo "could not read the asset list from cli/cleave.py" >&2; exit 1; }
while IFS= read -r rel; do
    [ -f "$ROOT/$rel" ] || { echo "cleave lists an asset that is not here: $rel" >&2; exit 1; }
    mkdir -p "$DATA/$(dirname "$rel")"
    install -m 0644 "$ROOT/$rel" "$DATA/$rel"
done <<< "$ASSETS"

install -m 0644 "$ROOT/LICENSE" "$STAGE/usr/share/doc/cleave/copyright"

OUT="/tmp/cleave_${VER}_all.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT" >/dev/null
echo "$OUT"
