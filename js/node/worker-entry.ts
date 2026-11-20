// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The kernel worker's entry on Node (started by worker.ts): serve the
// kernel (core/worker-serve.ts) over parentPort, reading file: URLs from
// disk and building disks and the network from specs (devices.ts). It finds nothing through import.meta.url: in the package it runs
// from a string. The build bundles it with everything it imports except
// Node built-ins.

import { parentPort } from "node:worker_threads";
import { serveKernel } from "../core/worker-serve.ts";
import { spawnNodeCpu } from "./cpu.ts";
import { spawnNodeSampler } from "./sampler.ts";
import { nodeDevices } from "./devices.ts";
import { nodeReadFile } from "./platform.ts";

const port = parentPort;
if (!port) throw new Error("unkernel: the kernel worker runs only in a worker thread (createKernel({ worker: true }))");
serveKernel({
	post: (msg, transfer) => port.postMessage(msg, transfer),
	listen: (handler) => port.on("message", handler),
}, { readFile: nodeReadFile(), devices: nodeDevices, spawnCpu: spawnNodeCpu, spawnSampler: spawnNodeSampler });
