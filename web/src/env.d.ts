// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Build-time constants from vite.config.ts (define).

/** The About dialog's build details; empty strings where unknown. */
declare const __KW_BUILD__: {
	/** Linux release from the kernel's banner (7.3.4+). */
	linux: string;
	/** The kernel's GitHub release tag (web/scripts/kernel.ts), or "local" (KW_KERNEL). */
	kernel: string;
	/** The page's commit hash and its date (ISO 8601). */
	commit: string;
	date: string;
};

/** The page's SMP bundle (vite.config.ts, web/scripts/kernel.ts splitKernel()), or null without one. */
declare module "virtual:unkernel-smp-kernel" {
	export const kernelSmpUrl: URL | null;
}
