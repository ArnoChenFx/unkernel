// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A kwsnd sink for Node: what the guest played, as a WAV file (the CLI's
// --sound-wav). See core/sound.ts.
import fs from "node:fs";
import { convertPcm, wavHeader, type SoundEvent, type SoundFormat, type SoundSink, type SoundState, type SoundStats } from "../core/sound.ts";

/**
 * Write every chunk the guest plays to `file`, in the format of the first
 * stream; later streams in another format are converted (core/sound.ts,
 * convertPcm). Gaps (underruns, time between streams) are not recorded: the
 * file is the samples back to back. The header is rewritten after every
 * stream stop and by close(), so the file is valid while the guest runs.
 */
export class WavSink implements SoundSink {
	readonly file: string;
	format: SoundFormat | null = null;
	bytes = 0;
	#fd: number;
	#log: (msg: string) => void;
	onChunk: (chunk: { format: SoundFormat; data: Uint8Array }) => number;
	onState: (state: SoundState, event: SoundEvent) => void;

	constructor(file: string, opts: { log?: (msg: string) => void; onState?: (state: SoundState, event: SoundEvent) => void } = {}) {
		this.file = file;
		this.#log = opts.log ?? (() => {});
		this.#fd = fs.openSync(file, "w");
		this.onChunk = ({ format, data }) => {
			if (!this.format) {
				this.format = format;
				fs.writeSync(this.#fd, wavHeader(format, 0), 0, 44, 0);
			}
			const out = convertPcm(data, format, this.format);
			fs.writeSync(this.#fd, out, 0, out.length, 44 + this.bytes);
			this.bytes += out.length;
			return 0;
		};
		this.onState = (state, event) => {
			if (event === "stop" || event === "drain" || event === "close") this.#writeHeader();
			opts.onState?.(state, event);
		};
	}

	#writeHeader(): void {
		if (this.format) fs.writeSync(this.#fd, wavHeader(this.format, this.bytes), 0, 44, 0);
	}

	/** Finish the header and close the file (once). */
	close(): void {
		if (this.#fd < 0) return;
		this.#writeHeader();
		fs.closeSync(this.#fd);
		this.#fd = -1;
		const f = this.format;
		this.#log(f ? `[host] sound: wrote ${this.file} (${f.rate} Hz, ${f.channels} ch, ${(f.frameBytes / f.channels) * 8} bit, ${(this.bytes / f.frameBytes / f.rate).toFixed(3)} s)`
			: `[host] sound: nothing played, ${this.file} is empty`);
	}
}

/**
 * The CLI's sound options: --sound-wav FILE (a card whose output goes to
 * FILE) or --sound (a card whose output is dropped); neither: no card.
 * Logs each state change; close() finishes the file and, given the stats
 * (--stats), prints them.
 */
export function cliSound(wavFile: string | undefined, enabled: boolean, log: (msg: string) => void): {
	option: boolean | SoundSink;
	close: (stats?: SoundStats) => void;
} {
	const onState = (s: SoundState, ev: SoundEvent): void => {
		const f = s.format;
		log(`[host] sound: ${ev}${ev === "prepare" && f ? ` ${f.rate} Hz, ${f.channels} ch, ${(f.frameBytes / f.channels) * 8} bit` : ""}`);
	};
	const wav = wavFile ? new WavSink(wavFile, { log, onState }) : undefined;
	return {
		option: wav ?? (enabled ? { onState } : false),
		close: (stats) => {
			wav?.close();
			if (stats) log(`[host] sound: ${stats.opens} opens, ${stats.starts} starts, ${stats.stops} stops (not drains), ` +
				`${stats.chunks} chunks, ${stats.frames} frames, max lag ${stats.maxLagMs.toFixed(1)} ms`);
		},
	};
}
