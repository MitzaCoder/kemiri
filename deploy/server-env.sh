#!/usr/bin/env bash
# Sourced by deploy.sh and rollback.sh. Env files are private installation config, never archived release contents.
# Missing sources mean a fresh installation using normal AIKI defaults. No file contents are logged.
function install_host_env() {
	HOST_ENV_CHANGED=0
	local source=${DEPLOY_HOST_ENV_FILE:-$DEPLOY_CONFIG_DIR/server-host.env}
	[[ -f $source ]] || return 0
	local destination=${DEPLOY_HOST_ENV_DEST:-${XDG_CONFIG_HOME:-$HOME/.config}/aiki/server.env} temporary
	if ! cmp -s "$source" "$destination"; then HOST_ENV_CHANGED=1; fi
	mkdir -p "$(dirname "$destination")" || return 1
	temporary=$(mktemp "${destination}.XXXXXX") || return 1
	if install -m 0600 "$source" "$temporary" && mv -f "$temporary" "$destination"; then return 0; fi
	rm -f "$temporary"
	return 1
}

function resolve_target_env() { # <target override prefix>
	local file_variable=${1}_ENV_FILE destination_variable=${1}_ENV_DEST
	T_ENV_SOURCE=${!file_variable:-$DEPLOY_CONFIG_DIR/server-$T_NAME.env}
	# HOME and XDG_CONFIG_HOME belong to the remote shell.
	T_ENV_DEST=${!destination_variable:-'${XDG_CONFIG_HOME:-$HOME/.config}/aiki/server.env'}
}

# The destination as one remote shell word. Operator overrides may expand remote HOME/XDG; dotenv values
# are literal paths (with the server's tilde expansion), never evaluated as shell code.
function target_vapid_path() {
	if [[ -n $T_VAPID_KEY_FILE ]]; then
		printf '"%s"' "$T_VAPID_KEY_FILE"
		return
	fi
	local key
	if [[ -f $T_ENV_SOURCE ]]; then
		key=$("$BUN" -e '
			import { parseEnv } from "node:util";
			const settings = parseEnv(await Bun.file(process.argv[1]).text());
			const data = settings.KEMIRI_DATA_DIR?.trim();
			const path = settings.KEMIRI_VAPID_KEY_FILE?.trim() || (data && data + "/notifications/vapid.json");
			if (path && !/^(\/|~(?:\/|$))/.test(path)) throw new Error("VAPID sharing needs an absolute or ~/ server path");
			if (path) process.stdout.write(path);
		' -- "$T_ENV_SOURCE") || return 1
	fi
	case ${key:-} in
	'~'|'~/'*) printf '"$HOME"%q' "${key:1}" ;;
	/*) printf '%q' "$key" ;;
	*)
		if [[ -n ${DEPLOY_VM_DATA_DIR:-} ]]; then
			printf '"%s/notifications/vapid.json"' "$DEPLOY_VM_DATA_DIR"
		else
			printf '%s' '"${XDG_DATA_HOME:-$HOME/.local/share}/kemiri/notifications/vapid.json"'
		fi
		;;
	esac
}

function install_target_env() {
	TARGET_ENV_CHANGED=0
	local source=$T_ENV_SOURCE destination=$T_ENV_DEST
	[[ -f $source ]] || return 0
	local previous current
	current=$(sha256sum <"$source") || return 1
	previous=$(tssh "if [[ -f \"$destination\" ]]; then sha256sum <\"$destination\"; fi") || return 1
	if [[ $previous != "$current" ]]; then TARGET_ENV_CHANGED=1; fi
	tssh "umask 077 && mkdir -p \"\$(dirname \"$destination\")\" && tmp=\$(mktemp \"$destination.XXXXXX\") && cat >\"\$tmp\" && mv -f \"\$tmp\" \"$destination\"" <"$source"
}
