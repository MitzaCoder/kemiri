/** `deploy/targets.ts`: the list of remote backend targets, its environment overrides and what it refuses. */
import "./clean-env.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { formatTarget, overrideVariable, parseTargets } from "../targets.ts";

const REAL_LIST = readFileSync(join(import.meta.dir, "..", "targets.example.json"), "utf8");
const BUN = process.execPath;
const TARGETS_TS = join(import.meta.dir, "..", "targets.ts");

describe("targets.json", () => {
	test("lists the remote VM exactly as it was hard-coded, and the Laptop as an intermittent system unit", () => {
		const [vm, laptop, ...rest] = parseTargets(REAL_LIST, {});
		expect(rest).toEqual([]);
		expect(vm).toEqual({
			name: "vm",
			label: "VM",
			ssh: "user@vm.example.test",
			tailnet: "vm.example.test",
			unit: "user",
			bun: "",
			identity: "",
			optional: false,
			port: "",
			shell: "",
		});
		expect(laptop).toMatchObject({
			name: "laptop",
			ssh: "user@laptop.example.test",
			tailnet: "laptop.example.test",
			unit: "system",
			bun: "$HOME/.local/bin/bun",
			identity: join(homedir(), ".ssh", "example-deploy"),
			optional: true,
			shell: "fish",
		});
	});

	test("prints one pipe-separated line per target for the bash scripts, empty fields kept", () => {
		const lines = parseTargets(REAL_LIST, {}).map(formatTarget);
		expect(lines[0]).toBe("vm|VM|user@vm.example.test|vm.example.test|user|||||");
		expect(lines[1]!.split("|")).toHaveLength(10);
		expect(lines[1]).toContain("|optional|");
	});

	test("the CLI prints the same lines and can pick one target", () => {
		const all = Bun.spawnSync([BUN, "run", TARGETS_TS, `--file=${join(import.meta.dir, "..", "targets.example.json")}`], { env: { ...process.env, DEPLOY_SSH_TARGET: "", DEPLOY_TAILNET_HOST: undefined } });
		expect(all.stdout.toString().trim().split("\n")).toHaveLength(2);
		const one = Bun.spawnSync([BUN, "run", TARGETS_TS, `--file=${join(import.meta.dir, "..", "targets.example.json")}`, "--name=laptop"]);
		expect(one.stdout.toString().trim().split("\n")).toHaveLength(1);
		expect(one.stdout.toString()).toStartWith("laptop|");
	});
});

describe("overrides", () => {
	test("the old DEPLOY_SSH_TARGET and DEPLOY_TAILNET_HOST still steer the VM, and only the VM", () => {
		const [vm, laptop] = parseTargets(REAL_LIST, { DEPLOY_SSH_TARGET: "me@elsewhere", DEPLOY_TAILNET_HOST: "10.0.0.9" });
		expect(vm).toMatchObject({ ssh: "me@elsewhere", tailnet: "10.0.0.9" });
		expect(laptop).toMatchObject({ ssh: "user@laptop.example.test", tailnet: "laptop.example.test" });
	});

	test("a tailnet host that is set but empty skips the check; an unset one keeps the default", () => {
		expect(parseTargets(REAL_LIST, { DEPLOY_TAILNET_HOST: "" })[0]!.tailnet).toBe("");
		expect(parseTargets(REAL_LIST, {})[0]!.tailnet).toBe("vm.example.test");
		// An empty ssh target is "not set": the default stands, as `${DEPLOY_SSH_TARGET:-user@vm.example.test}` did.
		expect(parseTargets(REAL_LIST, { DEPLOY_SSH_TARGET: "" })[0]!.ssh).toBe("user@vm.example.test");
	});

	test("each target answers DEPLOY_<NAME>_*, and ENABLED=0 leaves it out", () => {
		expect(overrideVariable("laptop", "SSH_TARGET")).toBe("DEPLOY_LAPTOP_SSH_TARGET");
		expect(overrideVariable("my-laptop", "BUN")).toBe("DEPLOY_MY_LAPTOP_BUN");
		const [, laptop] = parseTargets(REAL_LIST, {
			DEPLOY_LAPTOP_SSH_TARGET: "x@y",
			DEPLOY_LAPTOP_TAILNET_HOST: "",
			DEPLOY_LAPTOP_BUN: "$HOME/.local/bin/bun",
			DEPLOY_LAPTOP_OPTIONAL: "0",
			DEPLOY_LAPTOP_PORT: "9000",
		});
		expect(laptop).toMatchObject({ ssh: "x@y", tailnet: "", bun: "$HOME/.local/bin/bun", optional: false, port: "9000" });
		expect(parseTargets(REAL_LIST, { DEPLOY_LAPTOP_ENABLED: "0" }).map((target) => target.name)).toEqual(["vm"]);
		expect(parseTargets(REAL_LIST, { DEPLOY_VM_ENABLED: "false" }).map((target) => target.name)).toEqual(["laptop"]);
	});
});

test("resolves a private user unit, installed health env, pinned Bun and per-target VAPID destination", () => {
	const directory = mkdtempSync(join(tmpdir(), "deploy-target-settings-"));
	try {
		const targetEnv = join(directory, "private.env");
		const targetUnit = join(directory, "portable.service");
		const globalUnit = join(directory, "fallback.service");
		writeFileSync(targetUnit, "");
		writeFileSync(globalUnit, "");
		const targets = join(directory, "targets.json");
		writeFileSync(targets, JSON.stringify({ targets: [
			{ name: "vm", ssh: "user@vm.example.test", unit: "user" },
			{ name: "my-portable", ssh: "user@portable.example.test", unit: "user", bun: "/usr/bin/bun", enabled: false },
		] }));
		const resolve = (target: string, overrides: Record<string, string> = {}) => {
			const result = Bun.spawnSync(["bash", "-ec", [
				'source "$REPO_DIR/deploy/server-env.sh"; source "$REPO_DIR/deploy/targets.sh"',
				'die() { echo "$*" >&2; exit 1; }; load_targets; use_target "$(target_index "$1")"',
				'path=$(target_vapid_path); eval "key=$path"',
				'printf "%s\\n" "$T_USER_UNIT_FILE" "$key" "$(remote_bun)" "$(remote_backend_env)"',
			].join("\n"), "bash", target], { env: {
				...process.env, HOME: "/home/example", XDG_DATA_HOME: "/example/share",
				REPO_DIR: join(import.meta.dir, "../.."), BUN, DEPLOY_CONFIG_DIR: directory, DEPLOY_TARGETS_FILE: targets,
				DEPLOY_USER_UNIT_FILE: globalUnit, DEPLOY_MY_PORTABLE_ENABLED: "1",
				DEPLOY_MY_PORTABLE_USER_UNIT_FILE: targetUnit, DEPLOY_MY_PORTABLE_ENV_FILE: targetEnv,
				DEPLOY_MY_PORTABLE_ENV_DEST: "/example/config/server.env",
				...overrides,
			} });
			expect(result.stderr.toString()).toBe("");
			expect(result.exitCode).toBe(0);
			return result.stdout.toString().trimEnd().split("\n");
		};
		writeFileSync(targetEnv, 'KEMIRI_VAPID_KEY_FILE="~/private key/\$literal.json"\nKEMIRI_DATA_DIR=/other\n');
		const globalVapid = { DEPLOY_VM_DATA_DIR: "$HOME/legacy" };
		const portable = resolve("my-portable", globalVapid);
		expect(portable.slice(0, 3)).toEqual([targetUnit, "/home/example/private key/$literal.json", "$HOME/.local/bin/bun"]);
		expect(portable[3]).toContain('DEPLOY_HEALTH_ENV_FILE="/example/config/server.env"');
		expect(resolve("my-portable", { ...globalVapid, DEPLOY_MY_PORTABLE_VAPID_KEY_FILE: "$HOME/manual.json" })[1]).toBe("/home/example/manual.json");
		writeFileSync(targetEnv, "KEMIRI_DATA_DIR=/example/data\n");
		expect(resolve("my-portable", globalVapid)[1]).toBe("/example/data/notifications/vapid.json");
		expect(resolve("vm", globalVapid).slice(0, 2)).toEqual([globalUnit, "/home/example/legacy/notifications/vapid.json"]);
		expect(resolve("vm")[1]).toBe("/example/share/kemiri/notifications/vapid.json");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("validation", () => {
	const one = (patch: Record<string, unknown>) => JSON.stringify({ targets: [{ name: "a", ssh: "u@h", unit: "user", ...patch }] });

	test("accepts a bare array and fills in the label with the name", () => {
		const targets = parseTargets(JSON.stringify([{ name: "a", ssh: "u@h", unit: "system" }]), {});
		expect(targets[0]).toMatchObject({ name: "a", label: "a", unit: "system", optional: false });
	});

	test("refuses what would break a script", () => {
		expect(() => parseTargets("{", {})).toThrow("not JSON");
		expect(() => parseTargets("{}", {})).toThrow("expected");
		expect(() => parseTargets(one({ unit: "container" }), {})).toThrow('"unit" must be');
		expect(() => parseTargets(one({ ssh: "" }), {})).toThrow('"ssh" is required');
		expect(() => parseTargets(one({ name: "Bad Name" }), {})).toThrow('"name" must be');
		expect(() => parseTargets(one({ name: "host" }), {})).toThrow("is taken");
		expect(() => parseTargets(one({ ssh: "u@h|x" }), {})).toThrow('must not contain "|"');
		expect(() => parseTargets(one({ optional: "yes" }), {})).toThrow('"optional" must be');
		expect(() =>
			parseTargets(JSON.stringify([{ name: "a", ssh: "x", unit: "user" }, { name: "a", ssh: "y", unit: "user" }]), {}),
		).toThrow("is taken");
	});
});

describe("remote_command under a fish login shell", () => {
	const fish = Bun.which("fish");
	test.skipIf(!fish)("passes quotes and backslashes in a commit message through fish to bash unchanged", () => {
		const message = `test(deploy): keep the deploy's "config" out \\ of the scripts`;
		const script = `source ${JSON.stringify(join(import.meta.dir, "..", "targets.sh"))}; T_SHELL=fish; remote_command "printf '%s' $(printf '%q' "$1")"`;
		const built = Bun.spawnSync(["bash", "-c", script, "bash", message]);
		expect(built.exitCode).toBe(0);
		const ran = Bun.spawnSync([fish as string, "-c", built.stdout.toString()]);
		expect(ran.stderr.toString()).toBe("");
		expect(ran.stdout.toString()).toBe(message);
	});
});
