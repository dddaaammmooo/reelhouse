#!/usr/bin/env bash
# Signs and packages the app as Reelhouse.wgt on Linux (used by the release workflow; build-tv.ps1 is the
# Windows equivalent that also installs it). The package holds no API keys or tokens: js/config.js keeps its
# placeholders, and they're entered on the TV in Settings.
#
#   AUTHOR_P12=author.p12 AUTHOR_PASSWORD=... DISTRIBUTOR_P12=distributor.p12 DISTRIBUTOR_PASSWORD=... \
#     tools/package-tv.sh [output-dir]
#
# Needs the Tizen Studio CLI (TIZEN_HOME, default ~/tizen-studio). Samsung certificates only install on the TVs
# listed (by DUID) in the distributor certificate.
set -euo pipefail

: "${AUTHOR_P12:?path to the author certificate (.p12)}"
: "${AUTHOR_PASSWORD:?author certificate password}"
: "${DISTRIBUTOR_P12:?path to the distributor certificate (.p12)}"
: "${DISTRIBUTOR_PASSWORD:?distributor certificate password}"
TIZEN_HOME="${TIZEN_HOME:-$HOME/tizen-studio}"
tizen="$TIZEN_HOME/tools/ide/bin/tizen"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mkdir -p "${1:-$root/dist}" && cd "${1:-$root/dist}" && pwd)"

# A password pasted into a secret often carries a line ending; certificate passwords don't.
AUTHOR_PASSWORD="${AUTHOR_PASSWORD%$'\n'}"; AUTHOR_PASSWORD="${AUTHOR_PASSWORD%$'\r'}"
DISTRIBUTOR_PASSWORD="${DISTRIBUTOR_PASSWORD%$'\n'}"; DISTRIBUTOR_PASSWORD="${DISTRIBUTOR_PASSWORD%$'\r'}"
export AUTHOR_PASSWORD DISTRIBUTOR_PASSWORD

# Check each password opens its certificate first: the Tizen CLI only says "Author password:" and asks again.
opens() { openssl pkcs12 -noout -nodes -legacy -in "$1" -passin "env:$2" >/dev/null 2>&1 || openssl pkcs12 -noout -nodes -in "$1" -passin "env:$2" >/dev/null 2>&1; }
if command -v openssl >/dev/null; then
    opens "$AUTHOR_P12" AUTHOR_PASSWORD || { echo "error: the author password doesn't open $(basename "$AUTHOR_P12")" >&2; exit 1; }
    opens "$DISTRIBUTOR_P12" DISTRIBUTOR_PASSWORD || { echo "error: the distributor password doesn't open $(basename "$DISTRIBUTOR_P12")" >&2; exit 1; }
fi

# Only the app files, as build-tv.ps1 stages them
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -r "$root/config.xml" "$root/index.html" "$root/icon.png" "$root/css" "$root/js" "$stage/"
if [ -d "$root/img" ]; then cp -r "$root/img" "$stage/"; fi

# The signing profile. `tizen security-profiles add` saves the passwords encrypted through the desktop keyring,
# which a headless runner doesn't have (packaging then fails with "Invaild password"), so the profile is written
# directly, with the passwords in it. It only exists on the (throwaway) build machine.
data="$(sed -n 's/^TIZEN_SDK_DATA_PATH=//p' "$TIZEN_HOME/sdk.info" 2>/dev/null || true)"
data="${data:-$HOME/tizen-studio-data}"
mkdir -p "$data/profile"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
cat > "$data/profile/profiles.xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<profiles active="Reelhouse" version="3.1">
<profile name="Reelhouse">
<profileitem ca="" distributor="0" key="$(xml "$(realpath "$AUTHOR_P12")")" password="$(xml "$AUTHOR_PASSWORD")" rootca=""/>
<profileitem ca="" distributor="1" key="$(xml "$(realpath "$DISTRIBUTOR_P12")")" password="$(xml "$DISTRIBUTOR_PASSWORD")" rootca=""/>
<profileitem ca="" distributor="2" key="" password="" rootca=""/>
</profile>
</profiles>
EOF
chmod 600 "$data/profile/profiles.xml"
"$tizen" package -t wgt -s Reelhouse -- "$stage" < /dev/null      # never wait for a password prompt

wgt="$(ls "$stage"/*.wgt)"
mv "$wgt" "$out/"
echo "Built $out/$(basename "$wgt")"
