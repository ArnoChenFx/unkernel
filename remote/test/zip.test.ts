// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote release's zip writer (remote/scripts/zip.ts): round trips, the
// bytes it writes for the same files, the names it refuses, corruption, and
// an independent reader (Python's zipfile, when python3 is on the PATH).
//
//   node --test remote/test/zip.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkEntryName, readZip, writeZip } from "../scripts/zip.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("entries round-trip with their names and bytes", () => {
	const entries = [
		{ name: "a.txt", data: enc("hello") },
		{ name: "dir/empty.bin", data: new Uint8Array(0) },
		{ name: "dir/sub/random.bin", data: Uint8Array.from({ length: 70000 }, (_, i) => (i * 2654435761) >>> 24) },
		{ name: "ünïcode/файл.txt", data: enc("utf-8 name") },
	];
	const back = readZip(writeZip(entries));
	assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
	for (const [i, e] of back.entries()) assert.deepEqual(new Uint8Array(e.data), entries[i]!.data);
});

test("the same files pack to the same bytes", () => {
	const entries = [{ name: "x/y", data: enc("same") }, { name: "z", data: enc("bytes") }];
	assert.equal(writeZip(entries).equals(writeZip(entries)), true);
});

test("names that escape the install or repeat are refused", () => {
	for (const bad of ["", "/abs", "../up", "a/../b", "a//b", "a/./b", "a\\b", "C:/drive", "trailing/"]) {
		assert.throws(() => checkEntryName(bad), /bad entry name/, bad);
	}
	assert.throws(() => writeZip([{ name: "a", data: enc("1") }, { name: "a", data: enc("2") }]), /duplicate/);
});

test("a corrupted entry is an error when read", () => {
	const zip = writeZip([{ name: "a.txt", data: enc("the quick brown fox jumps over the lazy dog ".repeat(50)) }]);
	zip[40] = zip[40]! ^ 0xff;
	assert.throws(() => readZip(zip));
});

test("an independent reader accepts the archive", (t) => {
	const probe = (() => {
		try {
			execFileSync("python3", ["-c", "import zipfile"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	})();
	if (!probe) return t.skip("python3 is not installed");
	const dir = mkdtempSync(path.join(os.tmpdir(), "unkernel-zip-"));
	try {
		const file = path.join(dir, "t.zip");
		writeFileSync(file, writeZip([{ name: "one/two.txt", data: enc("abc") }, { name: "three.bin", data: new Uint8Array(3000).fill(7) }]));
		const listing = execFileSync("python3", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('\\n'.join(i.filename for i in z.infolist()))", file], { encoding: "utf8" });
		assert.deepEqual(listing.trim().split("\n"), ["one/two.txt", "three.bin"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
