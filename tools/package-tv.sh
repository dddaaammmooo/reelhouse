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

# The signing profile. The Tizen CLI reads each password in it through CipherUtil, its own fixed-key cipher
# (`tizen security-profiles add` hands them to the desktop keyring instead, which a CI runner doesn't have). A
# plain password only works by luck: one that happens to look like base64 fails to decrypt and the CLI stops to
# ask for it, which can't work without a terminal. So each one is encrypted with the CLI's own CipherUtil
# (tools/TizenPassword.java, run by a JDK 11+: the CLI's bundled Java 8 can't run a .java file). The profile only
# exists on the build machine.
data="$(sed -n 's/^TIZEN_SDK_DATA_PATH=//p' "$TIZEN_HOME/sdk.info" 2>/dev/null || true)"
data="${data:-$HOME/tizen-studio-data}"
mkdir -p "$data/profile"
encrypted() {
    java -Dlog4j2.statusLoggerLevel=OFF --add-exports java.xml/com.sun.org.apache.xerces.internal.impl.dv.util=ALL-UNNAMED \
        -cp "$TIZEN_HOME/tools/ide/lib-ncli/*" "$root/tools/TizenPassword.java" "$1" 2>/dev/null | sed -n 's/^TIZENPW://p'
}
author_pw="$(encrypted AUTHOR_PASSWORD)"
distributor_pw="$(encrypted DISTRIBUTOR_PASSWORD)"
if [ -z "$author_pw" ] || [ -z "$distributor_pw" ]; then
    echo "error: couldn't encrypt the passwords for the signing profile (needs a JDK 11+ as 'java')" >&2
    exit 1
fi
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
cat > "$data/profile/profiles.xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<profiles active="Reelhouse" version="3.1">
<profile name="Reelhouse">
<profileitem ca="" distributor="0" key="$(xml "$(realpath "$AUTHOR_P12")")" password="$(xml "$author_pw")" rootca=""/>
<profileitem ca="" distributor="1" key="$(xml "$(realpath "$DISTRIBUTOR_P12")")" password="$(xml "$distributor_pw")" rootca=""/>
<profileitem ca="" distributor="2" key="" password="" rootca=""/>
</profile>
</profiles>
EOF
chmod 600 "$data/profile/profiles.xml"
"$tizen" package -t wgt -s Reelhouse -- "$stage" < /dev/null || true

# The CLI can report an error and still exit 0, so check for the package itself.
if ! ls "$stage"/*.wgt > /dev/null 2>&1; then
    echo "error: packaging failed; see $data/cli/logs/cli.log" >&2
    exit 1
fi
wgt="$(ls "$stage"/*.wgt)"

# Make sure it's signed with this author certificate: when the CLI can't use a profile it can quietly sign with
# another one. Only a match / no match is printed (certificates can carry the owner's name).
fingerprint() { openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2; }
want="$({ openssl pkcs12 -in "$AUTHOR_P12" -passin env:AUTHOR_PASSWORD -nokeys -clcerts -legacy 2>/dev/null \
    || openssl pkcs12 -in "$AUTHOR_P12" -passin env:AUTHOR_PASSWORD -nokeys -clcerts 2>/dev/null; } | fingerprint)"
got="$(unzip -p "$wgt" author-signature.xml | tr -d '\r\n' | grep -o '<X509Certificate>[^<]*' | head -1 \
    | sed 's/<X509Certificate>//' | base64 -d 2>/dev/null | openssl x509 -inform DER -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)"
if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "error: the package isn't signed with the given author certificate" >&2
    exit 1
fi
echo "Signed with the given author certificate."
mv "$wgt" "$out/"
echo "Built $out/$(basename "$wgt")"
