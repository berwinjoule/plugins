#!/bin/sh
# Dry-run plan. Does not restart Magpie, read sign-in files, send a model
# request, or connect to a VPS. --execute still does not copy in this version;
# it only refuses a candidate that is not based on 0.1.120.
set -eu
mode=${1:-plan}
shift || true
execute=0
plugin_dir=
candidate=
backup=
while [ $# -gt 0 ]; do
  case $1 in
    --execute) execute=1; shift ;;
    --plugin-dir) plugin_dir=${2:-}; shift 2 ;;
    --candidate) candidate=${2:-}; shift 2 ;;
    --backup) backup=${2:-}; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "$plugin_dir" ] && [ -n "$candidate" ] && [ -n "$backup" ] || { echo "need --plugin-dir --candidate --backup" >&2; exit 2; }
case $plugin_dir$candidate$backup in *://*) echo "refusing URL path" >&2; exit 3 ;; esac
echo "mode=$mode execute=$execute"
echo "CanReload=no and KillMode=control-group: stopping magpie.service stops the host and its agy children together. This script does not do that."
echo "Disk hash is not the loaded memory hash. Drain is not confirmed while turns are attached."
echo "No promise of host-only restart or zero OAuth refresh."
if [ "$execute" -eq 0 ]; then
  echo "dry-run only; 0.1.116 candidates must not replace 0.1.120"
  exit 0
fi
base=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("baseVersion",""))' "$candidate/FORK_BUILD.json")
if [ "$base" != "0.1.120" ]; then
  echo "refusing execute: candidate base is $base, not 0.1.120" >&2
  exit 4
fi
echo "local execute switch accepted but this version performs no copy and no restart" >&2
exit 0
