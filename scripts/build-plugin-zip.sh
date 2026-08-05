#!/usr/bin/env sh
# Produces dist/opentill-for-woocommerce.zip for upload to WP Admin.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/opentill-for-woocommerce.zip
(cd plugins && zip -r ../dist/opentill-for-woocommerce.zip opentill-for-woocommerce \
  -x '*.DS_Store' -x '*__MACOSX*')
echo "wrote dist/opentill-for-woocommerce.zip"
