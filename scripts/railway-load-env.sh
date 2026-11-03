#!/bin/sh
# Load every KEY=VALUE from an env file into a Railway service's variables,
# without ever printing a value: each value goes to `railway variable set KEY
# --stdin`, so it is never on the screen, in shell history, or in `ps`.
#
#   sh scripts/railway-load-env.sh .env.railway-live opentill-live
#
# Variables are set with --skip-deploys; deploy afterwards with `railway up`.
# Blank lines and #comments are skipped; empty values are skipped (reported by
# name). One pair of surrounding quotes is stripped. Refuses to run while any
# value is still a template placeholder, or when ADAPTER_MODE=tachi has no
# TACHI_MNEMONIC.
set -eu

if [ $# -ne 2 ]; then
  echo "usage: sh scripts/railway-load-env.sh <env-file> <railway-service-name>" >&2
  exit 2
fi
file=$1
service=$2

[ -f "$file" ] || { echo "error: $file not found (copy it from $file.example first)" >&2; exit 1; }
command -v railway >/dev/null 2>&1 || { echo "error: railway CLI not installed (npm i -g @railway/cli)" >&2; exit 1; }

# Value of KEY in the file (last occurrence), quotes stripped. Never printed.
value_of() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$file" | tail -n 1 | tr -d '\r' \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# ---- preflight: nothing is sent if any check fails ---------------------------
if grep -q 'replace-with-a-long-random-string' "$file"; then
  echo "error: $file still contains a placeholder value — fill it in first:" >&2
  grep -n 'replace-with-a-long-random-string' "$file" | cut -d= -f1 >&2
  exit 1
fi
if [ "$(value_of ADAPTER_MODE)" = "tachi" ] && [ -z "$(value_of TACHI_MNEMONIC)" ]; then
  echo "error: ADAPTER_MODE=tachi but TACHI_MNEMONIC is empty in $file" >&2
  exit 1
fi

# ---- send ----------------------------------------------------------------------
count=0
while IFS= read -r line || [ -n "$line" ]; do
  line=$(printf '%s' "$line" | tr -d '\r')
  case "$line" in
    '' | '#'* | [[:space:]]'#'*) continue ;;
    *=*) ;;
    *) continue ;;
  esac
  key=$(printf '%s' "${line%%=*}" | tr -d '[:space:]')
  value=${line#*=}
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  if [ -z "$value" ]; then
    echo "skip  $key (empty)"
    continue
  fi
  printf '%s' "$value" | railway variable set "$key" --stdin --service "$service" --skip-deploys >/dev/null
  echo "set   $key"
  count=$((count + 1))
done < "$file"

echo "done: $count variables set on service '$service' (values not shown)."
