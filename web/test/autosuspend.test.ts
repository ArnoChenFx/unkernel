// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for suspending in the background and the question on leaving
// (src/autosuspend.ts) without a DOM or a kernel: the option's values, when
// the page asks before it goes away, and AutoSuspend's states with fake
// timers and a fake suspend (refusals, retries, the tab shown again before,
// during and after the save, a save that fails with the machine kept, the
// system ending meanwhile), the hold (saved, held while hidden, going on
// when shown, stopped after AUTO_SUSPEND_HOLD_MS, a machine gone meanwhile),
// the kw-resume values (every resume is quiet, with one toast; after
// Reboot a session is kept, or asked about with a data disk), and Pause by hand
// (offered after the user stayed on the page: saved and held with the tab
// shown, ended only by Continue, never by the tab's visibility; stopped
// after AUTO_SUSPEND_HOLD_MS; a failed save leaves the machine running).
//
//   node --test web/test/autosuspend.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	AUTO_SUSPEND_HOLD_MS, AUTO_SUSPEND_RETRY_MS, AUTO_SUSPEND_SAVE_FAILURES, AUTO_SUSPEND_TRIES, AutoSuspend, LEAVE_OFFER_MS, LEAVE_STAYED_MS, Pause, RESUME_AUTO, RESUME_BY_HAND, RESUME_FRESH, quietStart, resumeAskedFor, resumeChoice, resumeRequestKind, resumedNote, AutoSuspendSkip, SuspendSaveError, allowLeave, autoSuspendBlocker, autoSuspendLabel, pageLeaving,
	parseAutoSuspend, sessionRoom, wantLeavePrompt, type SuspendFacts,
} from "../src/autosuspend.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("resumeRequestKind: the Resume button's reload, the quiet one after a suspend in the background, Reboot's, else a plain load", () => {
	assert.equal(resumeRequestKind(RESUME_BY_HAND), "hand");
	assert.equal(resumeRequestKind(RESUME_AUTO), "auto");
	assert.equal(resumeRequestKind(RESUME_FRESH), "fresh");
	for (const v of [null, undefined, "", "0", "true", "AUTO", "FRESH"]) assert.equal(resumeRequestKind(v), null, String(v));
});

test("resumeChoice: a plain load resumes without a question; after Reboot kept, or asked about with a data disk", () => {
	for (const data of [false, true]) {
		assert.equal(resumeChoice(null, data), "resume"); // quietly, then the toast, as every resume
		assert.equal(resumeChoice("hand", data), "resume");
		assert.equal(resumeChoice("auto", data), "resume");
	}
	assert.equal(resumeChoice("fresh", false), "keep"); // nothing changes it: the next plain load resumes it
	assert.equal(resumeChoice("fresh", true), "ask"); // the fresh boot changes the data disk, which makes it useless
});

test("quietStart, resumeAskedFor, resumedNote: every resume starts quiet and says the same; Reboot and ?verbose=1 show the boot", () => {
	for (const r of ["hand", "auto", null] as const) {
		assert.equal(quietStart(r, false), true, String(r)); // the Resume button's reload too, not only the automatic one
		assert.equal(quietStart(r, true), false, String(r));
	}
	assert.equal(quietStart("fresh", false), false);
	assert.equal(resumeAskedFor("hand"), true);
	assert.equal(resumeAskedFor("auto"), true);
	assert.equal(resumeAskedFor(null), false); // a plain load asks on another CPU count
	assert.equal(resumeAskedFor("fresh"), false);
	assert.equal(resumedNote("just now"), "Resumed the session suspended just now");
	assert.equal(resumedNote("5 min ago"), "Resumed the session suspended 5 min ago");
});

test("parseAutoSuspend: at once on phones, off on desktops, else as given", () => {
	assert.deepEqual(parseAutoSuspend(null, true), { value: "now", delayS: 0 });
	assert.deepEqual(parseAutoSuspend(null, false), { value: "0", delayS: null });
	assert.deepEqual(parseAutoSuspend("0", true), { value: "0", delayS: null });
	assert.deepEqual(parseAutoSuspend("now", false), { value: "now", delayS: 0 });
	assert.deepEqual(parseAutoSuspend("30", false), { value: "30", delayS: 30 });
	for (const v of ["", "-5", "1.5", "030", "off", "x", "9999999"]) assert.deepEqual(parseAutoSuspend(v, true), { value: "now", delayS: 0 }, v);
	assert.equal(autoSuspendLabel("0"), "Off");
	assert.equal(autoSuspendLabel("now"), "At once");
	assert.equal(autoSuspendLabel("300"), "After 5 min");
	assert.equal(autoSuspendLabel("45"), "After 45 s");
	assert.ok(sessionRoom(1) >= 2 * 28 * 1048576 && sessionRoom(8) >= 2 * 90 * 1048576);
});

const F = (o: Partial<SuspendFacts> = {}): SuspendFacts => ({ running: true, suspending: false, interacted: true, hidden: true, ...o });

test("wantLeavePrompt: only for a used machine that runs or is being saved, never for the page's own reloads", () => {
	const on = { enabled: true, leaving: false };
	assert.equal(wantLeavePrompt(F({ hidden: false }), on), true);
	assert.equal(wantLeavePrompt(F({ running: false, suspending: true }), on), true);
	assert.equal(wantLeavePrompt(F({ running: false }), on), false); // suspended, stopped or not booted yet
	assert.equal(wantLeavePrompt(F({ interacted: false }), on), false);
	assert.equal(wantLeavePrompt(F(), { enabled: false, leaving: false }), false);
	assert.equal(wantLeavePrompt(F(), { enabled: true, leaving: true }), false);
	assert.equal(pageLeaving(), false);
	allowLeave();
	assert.equal(pageLeaving(), true);
});

test("autoSuspendBlocker", () => {
	assert.equal(autoSuspendBlocker(F(), 0), null);
	assert.equal(autoSuspendBlocker(F(), null), "off");
	assert.equal(autoSuspendBlocker(F({ hidden: false }), 0), "the tab is shown");
	assert.equal(autoSuspendBlocker(F({ suspending: true, running: false }), 0), "a suspend is in progress");
	assert.equal(autoSuspendBlocker(F({ running: false }), 0), "the system is not running");
	assert.match(autoSuspendBlocker(F({ interacted: false }), 0)!, /nothing to keep/);
});

/**
 * A fake page: facts to change, timers to run by hand, a suspend that waits
 * for settle() (held when `hold`), and a continue that waits for goOn().
 */
function harness(delayS: number | null, facts: Partial<SuspendFacts> = {}, hold = false) {
	const f = F({ hidden: false, ...facts });
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let id = 0;
	const calls = { suspend: 0, resume: 0, continue: 0, stopHeld: 0, failed: [] as string[], log: [] as string[] };
	let settle: ((e?: Error) => void) | null = null;
	let goOn: ((ok: boolean) => void) | null = null;
	const auto = new AutoSuspend({
		delayS,
		facts: () => ({ ...f }),
		suspend: () => {
			calls.suspend++;
			f.suspending = true;
			f.running = false;
			return new Promise<"held" | void>((res, rej) => {
				settle = (e) => {
					settle = null;
					if (e) { f.suspending = false; rej(e); return; }
					if (hold) f.held = true;
					else f.suspending = false;
					res(hold ? "held" : undefined);
				};
			});
		},
		continue: () => {
			calls.continue++;
			return new Promise<boolean>((res) => { goOn = (ok) => { goOn = null; f.held = f.suspending = false; f.running = ok; res(ok); }; });
		},
		stopHeld: async () => { calls.stopHeld++; f.held = false; },
		holdMs: AUTO_SUSPEND_HOLD_MS,
		resume: () => { calls.resume++; },
		log: (m) => { calls.log.push(m); },
		failed: (m) => { calls.failed.push(m); },
		setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
		clearTimeout: (t) => { timers.delete(t as number); },
	});
	return {
		auto, f, calls, timers,
		/** Run the pending timers (as if their time passed). */
		fire() { const all = [...timers.values()]; timers.clear(); for (const t of all) t.fn(); },
		/** The suspend succeeds (saved; stopped, or held). */
		async ok() { settle!(); await tick(); },
		/** The held machine went on (or was gone: false). */
		async goOn(ok = true) { goOn!(ok); await tick(); },
		/** The suspend is refused before the copy: the machine runs on. */
		async refuse(e: Error = new Error("snapshot: block requests in flight")) { f.running = !(e as { stopped?: boolean }).stopped; settle!(e); await tick(); },
		hide() { f.hidden = true; return auto.hidden(); },
		show() { f.hidden = false; auto.shown(); },
	};
}

test("AutoSuspend at once: suspends on hide, resumes when shown", async () => {
	const h = harness(0);
	assert.equal(h.hide(), true);
	assert.equal(h.calls.suspend, 1);
	assert.equal(h.auto.state, "saving");
	await h.ok();
	assert.equal(h.auto.state, "done");
	assert.equal(h.calls.resume, 0); // still hidden
	assert.equal(h.hide(), false); // hidden again (a second visibilitychange): nothing new
	h.show();
	assert.equal(h.calls.resume, 1);
	assert.equal(h.calls.suspend, 1);
});

test("AutoSuspend with a delay: shown before it fires cancels it", async () => {
	const h = harness(30);
	assert.equal(h.hide(), false); // the caller syncs as before
	assert.equal(h.auto.state, "armed");
	assert.equal([...h.timers.values()][0]!.ms, 30000);
	h.show();
	assert.equal(h.timers.size, 0);
	assert.equal(h.auto.state, "idle");
	assert.equal(h.calls.suspend, 0);
	// Hidden again: armed again, and this time it fires.
	h.hide();
	h.fire();
	assert.equal(h.calls.suspend, 1);
});

test("AutoSuspend: shown while it saves, it finishes and then resumes", async () => {
	const h = harness(30);
	h.hide();
	h.fire();
	h.show();
	assert.equal(h.calls.resume, 0);
	await h.ok();
	assert.equal(h.calls.resume, 1);
});

test("AutoSuspend: a refusal is tried again while hidden, then it gives up and the machine runs on", async () => {
	const h = harness(0);
	h.hide();
	for (let i = 1; i < AUTO_SUSPEND_TRIES; i++) {
		await h.refuse();
		assert.equal(h.auto.state, "armed");
		assert.equal([...h.timers.values()][0]!.ms, AUTO_SUSPEND_RETRY_MS);
		h.fire();
		assert.equal(h.calls.suspend, i + 1);
	}
	await h.refuse();
	assert.equal(h.auto.state, "idle");
	assert.equal(h.timers.size, 0);
	assert.equal(h.calls.failed.length, 1);
	assert.match(h.calls.failed[0]!, /in flight/);
	h.show();
	assert.equal(h.calls.resume, 0);
	// The next hidden spell tries again from the start.
	h.hide();
	assert.equal(h.calls.suspend, AUTO_SUSPEND_TRIES + 1);
});

test("AutoSuspend: a refusal once shown is not tried again", async () => {
	const h = harness(0);
	h.hide();
	h.f.hidden = false;
	await h.refuse();
	h.auto.shown();
	assert.equal(h.timers.size, 0);
	assert.equal(h.calls.failed.length, 1);
	assert.equal(h.auto.state, "idle");
});

test("AutoSuspend: a skip is never retried; a cancelled one says nothing", async () => {
	const h = harness(0);
	h.hide();
	await h.refuse(new AutoSuspendSkip("the session suspended 5 min ago is kept"));
	assert.equal(h.timers.size, 0);
	assert.deepEqual(h.calls.failed, ["Not suspended in the background: the session suspended 5 min ago is kept"]);
	h.show();
	h.hide();
	await h.refuse(new AutoSuspendSkip("the tab is shown again", true));
	assert.equal(h.calls.failed.length, 1);
	assert.equal(h.auto.state, "idle");
});

test("AutoSuspend: a failed save keeps the machine running: not retried in that hidden spell, again the next time, then off for the page load", async () => {
	const h = harness(0);
	assert.equal(h.hide(), true);
	await h.refuse(new SuspendSaveError("the session was not saved (IndexedDB transaction aborted); the system runs on"));
	assert.equal(h.auto.state, "idle");
	assert.equal(h.timers.size, 0, "not retried while hidden");
	assert.equal(h.calls.failed.length, 1);
	assert.match(h.calls.failed[0]!, /transaction aborted.*runs on/);
	h.show();
	assert.equal(h.calls.resume, 0, "nothing to resume: it runs");
	for (let i = 2; i <= AUTO_SUSPEND_SAVE_FAILURES; i++) {
		assert.equal(h.hide(), true);
		assert.equal(h.calls.suspend, i);
		await h.refuse(new SuspendSaveError("the session was not saved (QuotaExceededError); the system runs on"));
		h.show();
	}
	assert.equal(h.auto.state, "off");
	assert.match(h.calls.failed.at(-1)!, /off until the page is loaded again/);
	assert.equal(h.hide(), false, "off: the caller syncs the disks as without it");
	assert.equal(h.calls.suspend, AUTO_SUSPEND_SAVE_FAILURES);
});

test("AutoSuspend: the system ending while it saves leaves nothing to resume", async () => {
	const h = harness(0);
	h.hide();
	await h.refuse(Object.assign(new Error("the kernel worker exited unexpectedly"), { stopped: true }));
	assert.equal(h.auto.state, "stopped");
	h.show();
	assert.equal(h.calls.resume, 0);
	assert.equal(h.hide(), false);
	assert.equal(h.calls.suspend, 1);
});

test("AutoSuspend: off, an untouched machine, and a machine that starts running while hidden", async () => {
	const off = harness(null);
	assert.equal(off.hide(), false);
	assert.equal(off.calls.suspend + off.timers.size, 0);

	const idle = harness(0, { interacted: false });
	assert.equal(idle.hide(), false);
	assert.equal(idle.calls.suspend, 0);
	idle.auto.update();
	assert.equal(idle.calls.suspend, 0);

	const booting = harness(0, { running: false });
	assert.equal(booting.hide(), false);
	assert.equal(booting.calls.suspend, 0);
	booting.f.running = true;
	booting.auto.update();
	assert.equal(booting.calls.suspend, 1);
	booting.auto.update(); // decided: no second one
	assert.equal(booting.calls.suspend, 1);
});

test("AutoSuspend with a hold: saved and held while hidden; shown, it goes on (no reload), and a new hidden spell suspends again", async () => {
	const h = harness(0, {}, true);
	assert.equal(h.hide(), true);
	await h.ok();
	assert.equal(h.auto.state, "held");
	assert.equal([...h.timers.values()][0]!.ms, AUTO_SUSPEND_HOLD_MS, "the cap");
	assert.equal(h.hide(), false); // a second visibilitychange: nothing new
	h.show();
	assert.equal(h.auto.state, "releasing");
	assert.equal(h.timers.size, 0, "the cap is cancelled");
	assert.equal(h.calls.continue, 1);
	await h.goOn();
	assert.equal(h.auto.state, "idle");
	assert.equal(h.calls.resume, 0, "no reload");
	assert.equal(h.hide(), true, "hidden again: suspended again");
	assert.equal(h.calls.suspend, 2);
});

test("AutoSuspend with a hold: past AUTO_SUSPEND_HOLD_MS hidden the hold becomes a stop, which a show resumes", async () => {
	const h = harness(0, {}, true);
	h.hide();
	await h.ok();
	h.fire();
	assert.equal(h.calls.stopHeld, 1);
	assert.equal(h.auto.state, "done");
	h.show();
	assert.equal(h.calls.continue, 0);
	assert.equal(h.calls.resume, 1);
});

test("AutoSuspend with a hold: shown while it saves, it goes on once saved; a machine gone while held (or while going on) resumes its saved session", async () => {
	const a = harness(0, {}, true);
	a.hide();
	a.f.hidden = false;
	a.auto.shown();
	await a.ok();
	assert.equal(a.calls.continue, 1);
	await a.goOn();
	assert.equal(a.auto.state, "idle");

	const b = harness(0, {}, true);
	b.hide();
	await b.ok();
	b.auto.heldEnded(); // its worker died while hidden
	assert.equal(b.auto.state, "done");
	assert.equal(b.calls.resume, 0);
	b.show();
	assert.equal(b.calls.continue, 0);
	assert.equal(b.calls.resume, 1);

	const c = harness(0, {}, true);
	c.hide();
	await c.ok();
	c.show();
	await c.goOn(false); // gone when asked to go on
	assert.equal(c.auto.state, "done");
	assert.equal(c.calls.resume, 1);
});

test("wantLeavePrompt: a held machine (its session saved) needs no question", () => {
	assert.equal(wantLeavePrompt(F({ running: false, suspending: true, held: true }), { enabled: true, leaving: false }), false);
});

test("wantLeavePrompt: staying on the page changes nothing by itself; paused, closing asks nothing", () => {
	const on = { enabled: true, leaving: false };
	assert.equal(wantLeavePrompt(F({ hidden: false }), on), true); // stayed: it runs on, and asks again next time
	assert.equal(wantLeavePrompt(F({ hidden: false, running: false, suspending: true }), on), true); // Pause saving: closing now loses it
	assert.equal(wantLeavePrompt(F({ hidden: false, running: false, suspending: true, held: true }), on), false); // paused: saved
	assert.equal(wantLeavePrompt(F({ hidden: false, running: false, suspending: false }), on), false); // the pause became a stop
	assert.ok(LEAVE_STAYED_MS > 0 && LEAVE_OFFER_MS >= 5000 && LEAVE_OFFER_MS <= 15000);
});

/** A Pause with fakes, and an AutoSuspend on the same facts (the page has both). */
function pauseHarness(delayS: number | null = 0) {
	const h = harness(delayS);
	const calls = { suspend: 0, continue: 0, stopHeld: 0, notice: [] as boolean[], failed: [] as string[], log: [] as string[] };
	let settle: ((e?: Error | "stopped") => void) | null = null;
	let goOn: ((ok: boolean) => void) | null = null;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let id = 0;
	const f = h.f;
	const pause = new Pause({
		suspend: () => {
			calls.suspend++;
			f.suspending = true;
			f.running = false;
			return new Promise<"held" | "stopped">((res, rej) => {
				settle = (e) => {
					settle = null;
					if (e instanceof Error) { f.suspending = false; f.running = true; rej(e); return; }
					if (e === "stopped") { f.suspending = false; res("stopped"); return; }
					f.held = true;
					res("held");
				};
			});
		},
		continue: () => {
			calls.continue++;
			return new Promise<boolean>((res) => { goOn = (ok) => { goOn = null; f.held = f.suspending = false; f.running = ok; res(ok); }; });
		},
		stopHeld: async () => { calls.stopHeld++; },
		holdMs: AUTO_SUSPEND_HOLD_MS,
		notice: (on) => { calls.notice.push(on); },
		log: (m) => { calls.log.push(m); },
		failed: (m) => { calls.failed.push(m); },
		setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
		clearTimeout: (t) => { timers.delete(t as number); },
	});
	return {
		h, f, pause, calls, timers,
		fire() { const all = [...timers.values()]; timers.clear(); for (const t of all) t.fn(); },
		async ok(how?: "stopped") { settle!(how); await tick(); },
		async fail(e: Error) { settle!(e); await tick(); },
		async goOn(ok = true) { goOn!(ok); await tick(); },
	};
}

test("Pause: saved and held with the tab shown; the notice; Continue goes on", async () => {
	const p = pauseHarness();
	p.pause.pause();
	assert.equal(p.pause.state, "saving");
	p.pause.pause(); // a second Pause: nothing new
	assert.equal(p.calls.suspend, 1);
	await p.ok();
	assert.equal(p.pause.state, "paused");
	assert.deepEqual(p.calls.notice, [true]);
	assert.equal(p.timers.size, 1); // the hold's cap
	assert.equal([...p.timers.values()][0]!.ms, AUTO_SUSPEND_HOLD_MS);
	p.pause.continue();
	assert.equal(p.pause.state, "releasing");
	assert.deepEqual(p.calls.notice, [true, false]);
	assert.equal(p.timers.size, 0);
	await p.goOn();
	assert.equal(p.pause.state, "idle");
	assert.equal(p.f.running, true);
	p.pause.continue(); // not paused: nothing
	assert.equal(p.calls.continue, 1);
});

test("Pause: hiding and showing the tab neither continues it nor suspends it again", async () => {
	const p = pauseHarness(0); // auto-suspend at once, as on a phone
	p.pause.pause();
	await p.ok();
	assert.equal(p.h.hide(), false); // no suspend of its own (the machine is held)
	assert.equal(p.h.calls.suspend, 0);
	assert.equal(p.h.auto.state, "idle");
	assert.deepEqual(p.h.calls.log, []); // and quiet about it
	p.h.show();
	assert.equal(p.h.calls.continue, 0);
	assert.equal(p.h.calls.resume, 0);
	assert.equal(p.calls.continue, 0);
	assert.equal(p.pause.state, "paused");
	assert.equal(autoSuspendBlocker(F({ running: false, suspending: true, held: true }), 0), "paused");
	// Continued later, then hidden: auto-suspend works as before.
	p.pause.continue();
	await p.goOn();
	assert.equal(p.h.hide(), true);
	assert.equal(p.h.calls.suspend, 1);
});

test("Pause: after AUTO_SUSPEND_HOLD_MS it stops (the session stays saved), and ended() says it was this pause", async () => {
	const p = pauseHarness(null);
	p.pause.pause();
	await p.ok();
	p.fire();
	assert.equal(p.pause.state, "stopped");
	assert.equal(p.calls.stopHeld, 1);
	assert.deepEqual(p.calls.notice, [true, false]);
	assert.equal(p.pause.ended(), true); // the exit then offers Resume
	p.pause.continue();
	assert.equal(p.calls.continue, 0);

	const q = pauseHarness(null);
	assert.equal(q.pause.ended(), false); // not paused: AutoSuspend's or nobody's
	q.pause.pause();
	await q.ok();
	assert.equal(q.pause.ended(), true); // its worker died while paused
	assert.deepEqual(q.calls.notice, [true, false]);
	assert.equal(q.timers.size, 0);

	const r = pauseHarness(null);
	r.pause.pause();
	await r.ok();
	r.pause.continue();
	await r.goOn(false); // gone when asked to go on
	assert.equal(r.pause.state, "stopped");
	assert.equal(r.pause.ended(), true);
});

test("Pause: a save that fails leaves it running, and says why", async () => {
	const p = pauseHarness(null);
	p.pause.pause();
	await p.fail(new SuspendSaveError("the session was not saved (IndexedDB transaction aborted); the system runs on"));
	assert.equal(p.pause.state, "idle");
	assert.deepEqual(p.calls.notice, []);
	assert.equal(p.calls.failed.length, 1);
	assert.match(p.calls.failed[0]!, /IndexedDB transaction aborted/);
	p.pause.pause(); // can be tried again
	assert.equal(p.calls.suspend, 2);
	await p.ok("stopped"); // stopped instead of held (not expected): nothing to continue
	assert.equal(p.pause.state, "stopped");
	assert.deepEqual(p.calls.notice, []);
});
