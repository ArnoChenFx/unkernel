// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote kernel backend's settings. Each one comes from the first of:
// a command-line flag, an UNKERNEL_REMOTE_* variable, the JSON file given by
// --config (or UNKERNEL_REMOTE_CONFIG, or remote/unkernel-remote.json when it
// exists), and the default. Paths in the file are relative to the file.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RemoteConfig {
	/** The persistent data disk's image, created from the kernel's template when missing. */
	data: string;
	/** The host directory of /work, or null for none. */
	work: string | null;
	/** Where distro images are copied for the guest to run from (a rebuild of the web app does not change them under a running guest). */
	cache: string;
	/** The web build the page is served from (web/.output/public). */
	web: string;
	/** The port on 127.0.0.1. */
	port: number;
	/** Whether the kernel has the network (direct host sockets). */
	net: boolean;
	/** The JSON file the settings came from, if any. */
	configFile: string | null;
}

export const DEFAULT_PORT = 8787;

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SETTINGS = ["data", "work", "cache", "web", "port", "net"] as const;
type Setting = (typeof SETTINGS)[number];
type Value = string | number | boolean;
type Raw = Partial<Record<Setting, Value>>;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const ENV: Record<Setting, string> = {
	data: "UNKERNEL_REMOTE_DATA", work: "UNKERNEL_REMOTE_WORK", cache: "UNKERNEL_REMOTE_CACHE",
	web: "UNKERNEL_REMOTE_WEB", port: "UNKERNEL_REMOTE_PORT", net: "UNKERNEL_REMOTE_NET",
};

/** The command line as settings (`--data FILE`, `--data=FILE`, `--no-net`), with `--help`, `--open` and `--config`. */
export function parseFlags(argv: string[]): { values: Raw; help: boolean; open: boolean; config?: string } {
	const values: Raw = {};
	let help = false;
	let open = false;
	let config: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--open") {
			open = true;
			continue;
		}
		if (arg === "--no-net") {
			values.net = false;
			continue;
		}
		const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
		if (!m) throw new ConfigError(`unexpected argument ${JSON.stringify(arg)} (see --help)`);
		const name = m[1]!;
		const value = m[2] ?? argv[++i];
		if (value === undefined) throw new ConfigError(`--${name} needs a value`);
		if (name === "config") {
			config = value;
			continue;
		}
		if (!(SETTINGS as readonly string[]).includes(name)) throw new ConfigError(`unknown option --${name} (see --help)`);
		values[name as Setting] = value;
	}
	return { values, help, open, config };
}

/** A settings file. `null` is allowed for work only, and means no /work. */
function fromFile(file: string): Raw {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
	}
	if (!json || typeof json !== "object" || Array.isArray(json)) throw new ConfigError(`${file}: the file must hold a JSON object`);
	const out: Raw = {};
	const dir = path.dirname(path.resolve(file));
	for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
		if (!(SETTINGS as readonly string[]).includes(k)) throw new ConfigError(`${file}: unknown setting ${JSON.stringify(k)}`);
		const s = k as Setting;
		if (v === null) {
			if (s !== "work") throw new ConfigError(`${file}: ${k} cannot be null`);
			out.work = "none";
		} else if (s === "data" || s === "work" || s === "cache" || s === "web") {
			if (typeof v !== "string") throw new ConfigError(`${file}: ${k} must be a path`);
			out[s] = path.resolve(dir, v);
		} else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			out[s] = v;
		} else throw new ConfigError(`${file}: ${k} has the wrong type`);
	}
	return out;
}

function parseBool(name: string, v: Value): boolean {
	if (typeof v === "boolean") return v;
	const s = String(v).toLowerCase();
	if (["1", "on", "yes", "true"].includes(s)) return true;
	if (["0", "off", "no", "false"].includes(s)) return false;
	throw new ConfigError(`${name} must be on or off, not ${JSON.stringify(v)}`);
}

function parsePort(v: Value): number {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`port must be 1 to 65535, not ${JSON.stringify(v)}`);
	return n;
}

/**
 * The settings from the flags, the environment, the file and the defaults.
 * A relative path on the command line or in the environment is relative to
 * the working directory.
 */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): RemoteConfig & { help: boolean; open: boolean } {
	const flags = parseFlags(argv);
	const fromEnv: Raw = {};
	for (const s of SETTINGS) {
		const v = env[ENV[s]];
		if (v !== undefined && v !== "") fromEnv[s] = v;
	}
	const bundled = path.join(repo, "remote", "unkernel-remote.json");
	const configFile = flags.config ?? (env.UNKERNEL_REMOTE_CONFIG || undefined) ?? (existsSync(bundled) ? bundled : undefined);
	if (configFile && !existsSync(configFile)) throw new ConfigError(`the config file ${configFile} does not exist`);
	const file = configFile ? fromFile(configFile) : {};
	const pick = (k: Setting): Value | undefined => flags.values[k] ?? fromEnv[k] ?? file[k];
	const home = path.join(homedir(), ".unkernel", "remote");
	const pathOr = (k: "data" | "cache" | "web", fallback: string) => {
		const v = pick(k);
		return v === undefined ? fallback : path.resolve(String(v));
	};
	const workValue = pick("work");
	const work = workValue === undefined ? path.join(home, "work")
		: String(workValue).toLowerCase() === "none" ? null : path.resolve(String(workValue));
	const portValue = pick("port");
	const netValue = pick("net");
	return {
		data: pathOr("data", path.join(home, "data.img")),
		work,
		cache: pathOr("cache", path.join(home, "cache")),
		web: pathOr("web", path.join(repo, "web", ".output", "public")),
		port: portValue === undefined ? DEFAULT_PORT : parsePort(portValue),
		net: netValue === undefined ? true : parseBool("net", netValue),
		configFile: configFile ? path.resolve(configFile) : null,
		help: flags.help,
		open: flags.open,
	};
}

export const USAGE = `usage: bun --bun remote/cli.ts [options]

Runs the unkernel kernel on this computer for the page served at
http://127.0.0.1:PORT/?remote=1. One kernel runs at a time, and the data disk
is locked while the backend runs.

  --data FILE     the data disk image (created from the kernel's template if missing)
                  default ~/.unkernel/remote/data.img            (UNKERNEL_REMOTE_DATA)
  --work DIR      the host directory mounted at /work in the guest (created if missing);
                  "none" for no /work. default ~/.unkernel/remote/work (UNKERNEL_REMOTE_WORK)
  --cache DIR     copies of the distro images the guest runs from
                  default ~/.unkernel/remote/cache               (UNKERNEL_REMOTE_CACHE)
  --port N        the port on 127.0.0.1, default ${DEFAULT_PORT}          (UNKERNEL_REMOTE_PORT)
  --net on|off    the guest's network; --no-net is off            (UNKERNEL_REMOTE_NET)
  --web DIR       the page's web build, default web/.output/public (UNKERNEL_REMOTE_WEB)
  --config FILE   a JSON file with these settings (keys: data, work, cache, web, port, net;
                  relative paths are relative to the file)       (UNKERNEL_REMOTE_CONFIG)
  --open          open the page in the default browser once the backend listens
  --help          this text

Precedence: flags, then environment, then the config file, then the defaults.
`;
