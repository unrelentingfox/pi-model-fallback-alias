#!/usr/bin/env bash
# Type-check the extension against the pi runtime that will actually load it.
#
# The committed tsconfig.json stays portable: this script resolves the pi
# install and the @types/node copy that ships with it, then layers those paths
# on through a generated override config.
#
# Overrides:
#   PI_ROOT   pi-coding-agent package directory
#   TSC       tsc executable

set -euo pipefail

extension_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

find_pi_root() {
	if [[ -n ${PI_ROOT:-} ]]; then
		printf '%s\n' "$PI_ROOT"
		return 0
	fi
	local candidate roots=()
	if command -v npm >/dev/null 2>&1; then
		roots+=("$(npm root -g 2>/dev/null || true)")
	fi
	if command -v brew >/dev/null 2>&1; then
		roots+=("$(brew --prefix 2>/dev/null || true)/lib/node_modules")
	fi
	roots+=("/usr/local/lib/node_modules" "/usr/lib/node_modules")
	for candidate in "${roots[@]}"; do
		[[ -n $candidate ]] || continue
		if [[ -d "$candidate/@earendil-works/pi-coding-agent" ]]; then
			printf '%s\n' "$candidate/@earendil-works/pi-coding-agent"
			return 0
		fi
	done
	return 1
}

find_tsc() {
	if [[ -n ${TSC:-} ]]; then
		printf '%s\n' "$TSC"
		return 0
	fi
	local candidate
	for candidate in "$extension_dir/node_modules/.bin/tsc" "$extension_dir"/../*/node_modules/.bin/tsc; do
		[[ -x $candidate ]] && printf '%s\n' "$candidate" && return 0
	done
	command -v tsc 2>/dev/null && return 0
	return 1
}

pi_root=$(find_pi_root) || {
	echo "typecheck: cannot find @earendil-works/pi-coding-agent; set PI_ROOT" >&2
	exit 1
}
tsc=$(find_tsc) || {
	echo "typecheck: no tsc found; install typescript or set TSC" >&2
	exit 1
}

node_types=$(find "$pi_root" -maxdepth 4 -type d -path '*@types/node' -print -quit)
[[ -n $node_types && -d $node_types ]] || {
	echo "typecheck: cannot find @types/node in $pi_root" >&2
	exit 1
}
types_root=$(dirname -- "$node_types")
pi_tui="$pi_root/node_modules/@earendil-works/pi-tui"
[[ -d $pi_tui ]] || {
	echo "typecheck: cannot find @earendil-works/pi-tui in $pi_root" >&2
	exit 1
}
override=$(mktemp -t pi-model-alias-tsconfig-XXXXXX.json)
trap 'rm -f "$override"' EXIT

cat >"$override" <<EOF
{
	"extends": "$extension_dir/tsconfig.json",
	"compilerOptions": {
		"typeRoots": ["$types_root"],
		"types": ["node"],
		"paths": {
			"@earendil-works/pi-coding-agent": ["$pi_root"],
			"@earendil-works/pi-ai": ["$pi_root/node_modules/@earendil-works/pi-ai"],
			"@earendil-works/pi-ai/*": ["$pi_root/node_modules/@earendil-works/pi-ai/dist/*"],
			"@earendil-works/pi-tui": ["$pi_tui"]
		}
	},
	"include": ["$extension_dir/**/*.ts"]
}
EOF

echo "typecheck: tsc=$tsc"
echo "typecheck: pi=$pi_root"
exec "$tsc" -p "$override"
