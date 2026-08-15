#!/usr/bin/env bash
#
# set-version.sh — stamp a new axe version across every file that carries it.
#
# Usage:
#   ./set-version.sh 0.4.1        # stamp a plain release version
#
# The working copy is always stamped with a plain release version (no -dev
# suffix); see the Versioning section in README.md.
#
# Touches the 8 stamps: axe.css (header + --axe-version), calendar.css (header),
# calendar.js (header + Calendar.version), toml.js (header + TOML.version), and
# kitchen-sink.html (footer). It
# does NOT edit the README changelog — those notes are prose, so add a
# "### <version> (date)" entry by hand, then commit and tag.
#
set -euo pipefail
cd "$(dirname "$0")"

NEW="${1:-}"
if [ -z "$NEW" ]; then
    echo "usage: $0 <version>   e.g. $0 0.4.1" >&2
    exit 1
fi

# Shape check: digits.digits.digits, with an optional pre-release suffix still
# tolerated (e.g. -rc1) even though releases are stamped plain.
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$ ]]; then
    echo "error: '$NEW' isn't a version (expected e.g. 0.4.1)" >&2
    exit 1
fi

# Matches an existing version token wherever it appears: starts with a digit,
# then any digits / letters / dots / hyphens (so it still catches an old suffix).
V='[0-9][0-9A-Za-z.-]*'

# axe.css — banner comment and the --axe-version custom property.
sed -i -E "s/AXE v$V/AXE v$NEW/"                                   axe.css
sed -i -E "s/(--axe-version: \")$V(\")/\1$NEW\2/"                  axe.css
# calendar.css — banner comment.
sed -i -E "s/AXE CALENDAR v$V/AXE CALENDAR v$NEW/"                 calendar.css
# calendar.js — banner comment and the runtime Calendar.version.
sed -i -E "s/AXE CALENDAR v$V/AXE CALENDAR v$NEW/"                 calendar.js
sed -i -E "s/(Calendar\.version = ')$V(')/\1$NEW\2/"              calendar.js
# toml.js — banner comment and the runtime TOML.version.
sed -i -E "s/AXE TOML v$V/AXE TOML v$NEW/"                         toml.js
sed -i -E "s/(version: ')$V(')/\1$NEW\2/"                          toml.js
# kitchen-sink.html — footer version line.
sed -i -E "s/Axe v$V/Axe v$NEW/"                                  kitchen-sink.html

echo "axe version set to $NEW:"
grep -nE "AXE( CALENDAR| TOML)? v[0-9]|Axe v[0-9]|--axe-version:|Calendar\.version = '|version: '" axe.css calendar.css calendar.js toml.js kitchen-sink.html
echo
echo "Next: add a '### $NEW ($(date +%Y-%m-%d))' note to README.md, then commit + tag."
