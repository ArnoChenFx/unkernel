// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// glimmer: "Glimmer Meadow", a small game on the display (/dev/fb0, kwfb),
// the evdev keyboard and mouse (kwinput) and the sound card (kwsnd, ALSA
// hw:0,0), and their self-test. Both need a display: the page, or the CLI's
// --display; sound is optional (the page has it, the CLI with --sound or
// --sound-wav FILE).
//
//   glimmer [--no-sound]                play
//   glimmer --test [secs] [--no-sound]  self-test (default 10 s), see below
//
// The game: Pip, a glowing seed, floats over a night meadow. Catch the
// falling stars (chained catches score more and refill bloom energy) and keep
// away from the glooms. A bloom (Space or Ctrl) sends out a ring that turns
// every gloom it reaches into a flower on the ground. The mouse moves a wisp
// that pulls stars towards it, and a click blooms at the wisp. With an
// absolute pointer (kwinput's tablet) the wisp sits where the pointer is,
// and the relative mouse is not opened, so the page takes no pointer lock
// and the cursor leaves the picture freely (the wisp stays where it was);
// without one, the relative mouse moves it. Arrows or WASD
// move; Enter starts; Esc pauses, and Esc again quits; M (or Tab, which the
// page's touch overlay has behind its "more" button) turns the sound off and
// on. On the touch overlay that is the d-pad, Space/Ctrl, Enter, Esc, Tab,
// and dragging/tapping the picture. A bloom without the energy for it
// fizzles: sparks at the spot, "NEED STARS", and the energy bar flashes red.
//
// Sound: short effects, synthesised (a few sine, triangle, square and noise
// voices with a quick attack and a fade to zero, a soft ping-pong echo):
// a bell for each star caught, higher up a pentatonic scale as the chain
// (and so the multiplier) grows; a rising sweep for a bloom and a dull
// buzz for a fizzle; a three-note chime when glooms turn into flowers; a
// falling sweep for a lost heart and two notes for a new one; an arpeggio
// for a level; a slow falling one for game over; two notes for a new game,
// pause and resume. Panned by where it happens. 22050 Hz stereo S16_LE to
// the ALSA PCM, non-blocking, topped up to 46 ms every frame; an underrun
// is recovered with PREPARE. Without a sound device (or with --no-sound,
// or when a step fails) the game runs silent.
//
// Any mode: the game reads the mode at start and fills the screen at its
// aspect ratio. It draws a logical picture of (xres/S)x(yres/S) and shows
// each logical pixel as an SxS block, where S is the smallest integer that
// keeps the logical picture at or under 125000 pixels (about 400x300), but
// never so large that the logical width drops under 160 or the height under
// 140 (the smallest the layout is made for):
//   S = max(1, min(smallest s with (xres/s)*(yres/s) <= 125000, xres/160, yres/140))
// e.g. 320x200 -> 1 (320x200), 640x480 -> 2 (320x240), 360x640 -> 2 (180x320),
// 800x360 -> 2 (400x180), 1280x720 -> 3 (426x240), 1920x1000 -> 4 (480x250),
// 2560x1440 -> 6 (426x240). Sprites and text are a
// fixed number of logical pixels, so they scale with the screen; speeds are
// scaled by the shorter logical side. The HUD sits along the top edge (two
// rows when narrow), and the panels stay in the upper three quarters, so the
// page's touch controls in the bottom corners cover nothing important.
// GLIMMER_MODE=WxH makes it use a WxH mode instead: inside the real buffer
// at its top-left corner when it fits (to look at other layouts on a fixed
// mode), else in an invisible buffer of that size (to time a large mode).
//
// Drawing: the logical picture is cut into 16x16 tiles; every frame the
// scene is walked twice, first only to mark the tiles that anything covers,
// then to draw. Tiles marked now or in the previous frame are restored from
// the background and redrawn, and only those are scaled into the
// framebuffer. Game logic runs at a fixed 60 Hz on CLOCK_MONOTONIC; the loop
// sleeps until the next tick.
//
// The keyboard device is read directly, so the tty is put in no-echo,
// non-canonical mode and drained while the game runs (Ctrl-C on the console
// still works), then flushed and restored. Esc, SIGINT, SIGTERM and SIGHUP
// end the game cleanly: the framebuffer is cleared before it is unmapped.
//
// --test prints, each on a line starting "glimmer: ": the mode from
// FBIOGET_VSCREENINFO/FSCREENINFO, then writes the first 16 rows of the
// pattern below with pwrite() and reads them back with pread(), maps the
// buffer and draws the rest through the mapping; then it lists every
// /dev/input/event* (name, id, event types, key, rel and abs codes, and for
// each abs axis ", absN min..max"), prints
// "glimmer: test ready", and holds the picture for the given time while
// printing each input event as "glimmer: event eventN TYPE CODE VALUE"
// (TYPE is EV_SYN, EV_KEY, EV_REL, EV_ABS, ... ; CODE and VALUE in decimal); it ends
// with "glimmer: test done, N events" and clears the screen. Exit status 0,
// or 1 if a framebuffer or sound step failed. The pattern, for a WxH mode at (0,0)
// (GLIMMER_MODE applies; everything outside it is black), first rule wins:
//   x == 0, y == 0, x == W-1 or y == H-1                0xffffff (border)
//   x < 9 and y < 9: 0xff0000; x >= W-9 and y < 9: 0x00ff00;
//   x < 9 and y >= H-9: 0x0000ff; x >= W-9 and y >= H-9: 0xffff00 (corners)
//   y < H/4      bars[x*8/W], bars = ffffff ffff00 00ffff 00ff00 ff00ff ff0000 0000ff 000000
//   y < H/2      v*0x010101 with v = x*255/(W-1) (grey ramp)
//   y < 3*H/4    0xff8000 if (x/8 + y/8) is odd, else 0x000040 (checkerboard)
//   otherwise    v<<8 | (255-v) with v = y*255/(H-1)
// with integer division throughout.
//
// Sound, between the input list and "test ready": "glimmer: test sound
// card 0: ...", "... pcm 0: ...", "... protocol ..." (what the card
// offers), "glimmer: test sound signal ..." (what it plays), then, during
// the hold, the signal, and "glimmer: test sound done, N frames in T s, U
// underrun(s)". The signal: 22050 Hz, 2 channels, S16_LE, 66150 frames
// (3 s). Frame f (counted from 0) in second k = f / 22050 carries
// 0.5 * sin(2 pi * ((F * f) mod 22050) / 22050) * 32767, rounded half away
// from zero, with F = 440, 660, 880 Hz for k = 0, 1, 2: on both channels in
// second 0, on the left only in second 1 and on the right only in second 2
// (the other channel 0). With no sound device it prints "glimmer:
// test sound: no sound device (...)", which is not a failure; --no-sound
// prints "glimmer: test sound skipped (--no-sound)". test/glimmer-check.mjs
// checks a frame, a recording of the signal (--sound-wav), and both with
// --run.
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/input.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <sound/asound.h>

#define TS 16           /* tile size, logical pixels */
#define FP 8            /* fixed point: positions and speeds in 1/256 px */
#define ONE (1 << FP)
#define TICK_NS 16666667LL
#define BLOOM_COST 250  /* energy 0..1000 */
#define BUDGET 125000   /* logical pixels */
#define MINW 160
#define MINH 120
#define MG 6            /* margin from the screen edges */
#define NMOTE 16
#define NGLOOM 10
#define NRING 6
#define NFT 8
#define BITS(n) (((n) + 8 * sizeof(long) - 1) / (8 * sizeof(long)))
#define TEST(bit, arr) (((arr)[(bit) / (8 * sizeof(long))] >> ((bit) % (8 * sizeof(long)))) & 1)
#define PX(b, x, y) (b)[(size_t)(y) * LW + (x)]

enum { TITLE, PLAY, PAUSE, OVER };

/* layout, set by layout() from the mode */
static int LW, LH, S, TW, TH, TOP, GROUND, KS, HUD2, moon_x, moon_y;
static uint32_t *scr, *bgbase, *bg, *tgt, *rowbuf;
static uint8_t *tcur, *tprev, *tforce, *tdirty;
static int marking;

/* the display: map is the device mapping, fb what is drawn (map, or an
 * invisible buffer for a GLIMMER_MODE larger than the device) */
static uint32_t *map, *fb;
static size_t map_len;
static unsigned fb_stride, mode_w, mode_h, ox, oy;
static unsigned disp_w, disp_h; /* the device's mode, which an absolute pointer spans */
static int fb_fake;
static int kfd = -1, mfd = -1, tty_raw;
static int mabs; /* mfd is an absolute pointer: its X and Y ranges */
static struct input_absinfo abs_x, abs_y;
static int snd_fd = -1, snd_muted, no_sound; /* the PCM (see "sound" below) */
static struct termios tty_saved;
static volatile sig_atomic_t quit;

static unsigned char key[256], hit[256];
static int click, cxs, cys, cur_on; /* cursor in screen pixels */

struct obj { int on, x, y, vx, vy, ph, k, sp, life; };
static struct obj motes[NMOTE], glooms[NGLOOM], rings[NRING];
static struct { int on, x, y, t, scale; uint32_t c; char s[12]; } fts[NFT];
static struct { int x, y, vx, vy, face, inv; } pip;
static struct { int on, x, y, t; } fizz; /* a bloom without the energy for it */
static int state, state_t, anim, score, best, new_best, hearts, energy, combo, level;
static int flowers, next_heart, mote_t, gloom_t, bar_flash, fps, games;
static int title_y, prompt_y, panel_x0, panel_x1;
static char hud_sig[64];
static uint32_t rs = 1;

/* ---- maths ---------------------------------------------------------------- */

static uint32_t rnd(void)
{
	rs ^= rs << 13;
	rs ^= rs >> 17;
	rs ^= rs << 5;
	return rs;
}

static int rn(int n) { return n > 0 ? (int)(rnd() % (unsigned)n) : 0; }
static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
static int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static int sc(int v) { return v * KS / 256; } /* scale a speed to the field */

/* sin over 64 steps per turn, scaled to 256 */
static int isin(int a)
{
	static const short q[17] = { 0, 25, 50, 74, 98, 121, 142, 162, 181, 198, 213, 226, 237, 245, 251, 255, 256 };
	a &= 63;
	return a < 16 ? q[a] : a < 32 ? q[32 - a] : a < 48 ? -q[a - 32] : -q[64 - a];
}

static int isqrt(unsigned v)
{
	unsigned r = 0, b = 1u << 30;
	while (b > v)
		b >>= 2;
	for (; b; b >>= 2) {
		if (v >= r + b) {
			v -= r + b;
			r = (r >> 1) + b;
		} else {
			r >>= 1;
		}
	}
	return (int)r;
}

static int64_t now_ns(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000000000 + t.tv_nsec;
}

/* ---- tiles and drawing ---------------------------------------------------- */

static void mark_into(uint8_t *m, int x0, int y0, int x1, int y1)
{
	if (x1 < 0 || y1 < 0 || x0 >= LW || y0 >= LH)
		return;
	x0 = imax(x0, 0) / TS, x1 = imin(x1, LW - 1) / TS;
	y0 = imax(y0, 0) / TS, y1 = imin(y1, LH - 1) / TS;
	for (int ty = y0; ty <= y1; ty++)
		memset(m + ty * TW + x0, 1, x1 - x0 + 1);
}

static void mark(int x0, int y0, int x1, int y1) { mark_into(tcur, x0, y0, x1, y1); }
static void mark_all(void) { memset(tforce, 1, TW * TH); }

static void put(int x, int y, uint32_t c)
{
	if (marking)
		mark(x, y, x, y);
	else if ((unsigned)x < (unsigned)LW && (unsigned)y < (unsigned)LH)
		PX(tgt, x, y) = c;
}

static void hspan(int x0, int x1, int y, uint32_t c)
{
	if (marking) {
		mark(x0, y, x1, y);
		return;
	}
	if ((unsigned)y >= (unsigned)LH)
		return;
	x0 = imax(x0, 0), x1 = imin(x1, LW - 1);
	for (int x = x0; x <= x1; x++)
		PX(tgt, x, y) = c;
}

static void fill_circle(int cx, int cy, int r, uint32_t c)
{
	if (marking) {
		mark(cx - r, cy - r, cx + r, cy + r);
		return;
	}
	for (int dy = 0, w = r; dy <= r; dy++) {
		while (w > 0 && w * w + dy * dy > r * r + r)
			w--;
		hspan(cx - w, cx + w, cy - dy, c);
		if (dy)
			hspan(cx - w, cx + w, cy + dy, c);
	}
}

static void ring_line(int cx, int cy, int r, uint32_t c)
{
	if (marking) {
		mark(cx - r, cy - r, cx + r, cy + r);
		return;
	}
	for (int x = r, y = 0, e = 1 - r; x >= y; y++) {
		put(cx + x, cy + y, c), put(cx - x, cy + y, c), put(cx + x, cy - y, c), put(cx - x, cy - y, c);
		put(cx + y, cy + x, c), put(cx - y, cy + x, c), put(cx + y, cy - x, c), put(cx - y, cy - x, c);
		if (e < 0) {
			e += 2 * y + 3;
		} else {
			e += 2 * (y - x) + 5;
			x--;
		}
	}
}

/* 5x7 font, ASCII 32..95 (lower case is drawn as upper case); '@' is a
 * heart and '#' a star. Bit 4 is the leftmost column. */
static const uint8_t font[64][7] = {
	['!' - 32] = { 4, 4, 4, 4, 4, 0, 4 },
	['#' - 32] = { 4, 4, 31, 14, 10, 17, 0 },
	['\'' - 32] = { 4, 4, 8, 0, 0, 0, 0 },
	['(' - 32] = { 2, 4, 8, 8, 8, 4, 2 },
	[')' - 32] = { 8, 4, 2, 2, 2, 4, 8 },
	['*' - 32] = { 0, 4, 21, 14, 21, 4, 0 },
	['+' - 32] = { 0, 4, 4, 31, 4, 4, 0 },
	[',' - 32] = { 0, 0, 0, 0, 12, 4, 8 },
	['-' - 32] = { 0, 0, 0, 31, 0, 0, 0 },
	['.' - 32] = { 0, 0, 0, 0, 0, 12, 12 },
	['/' - 32] = { 0, 1, 2, 4, 8, 16, 0 },
	['0' - 32] = { 14, 17, 19, 21, 25, 17, 14 },
	['1' - 32] = { 4, 12, 4, 4, 4, 4, 14 },
	['2' - 32] = { 14, 17, 1, 2, 4, 8, 31 },
	['3' - 32] = { 31, 2, 4, 2, 1, 17, 14 },
	['4' - 32] = { 2, 6, 10, 18, 31, 2, 2 },
	['5' - 32] = { 31, 16, 30, 1, 1, 17, 14 },
	['6' - 32] = { 6, 8, 16, 30, 17, 17, 14 },
	['7' - 32] = { 31, 1, 2, 4, 8, 8, 8 },
	['8' - 32] = { 14, 17, 17, 14, 17, 17, 14 },
	['9' - 32] = { 14, 17, 17, 15, 1, 2, 12 },
	[':' - 32] = { 0, 12, 12, 0, 12, 12, 0 },
	['<' - 32] = { 2, 4, 8, 16, 8, 4, 2 },
	['=' - 32] = { 0, 0, 31, 0, 31, 0, 0 },
	['>' - 32] = { 8, 4, 2, 1, 2, 4, 8 },
	['?' - 32] = { 14, 17, 1, 2, 4, 0, 4 },
	['@' - 32] = { 0, 10, 31, 31, 14, 4, 0 },
	['A' - 32] = { 14, 17, 17, 31, 17, 17, 17 },
	['B' - 32] = { 30, 17, 17, 30, 17, 17, 30 },
	['C' - 32] = { 14, 17, 16, 16, 16, 17, 14 },
	['D' - 32] = { 28, 18, 17, 17, 17, 18, 28 },
	['E' - 32] = { 31, 16, 16, 30, 16, 16, 31 },
	['F' - 32] = { 31, 16, 16, 30, 16, 16, 16 },
	['G' - 32] = { 14, 17, 16, 23, 17, 17, 15 },
	['H' - 32] = { 17, 17, 17, 31, 17, 17, 17 },
	['I' - 32] = { 14, 4, 4, 4, 4, 4, 14 },
	['J' - 32] = { 7, 2, 2, 2, 2, 18, 12 },
	['K' - 32] = { 17, 18, 20, 24, 20, 18, 17 },
	['L' - 32] = { 16, 16, 16, 16, 16, 16, 31 },
	['M' - 32] = { 17, 27, 21, 21, 17, 17, 17 },
	['N' - 32] = { 17, 17, 25, 21, 19, 17, 17 },
	['O' - 32] = { 14, 17, 17, 17, 17, 17, 14 },
	['P' - 32] = { 30, 17, 17, 30, 16, 16, 16 },
	['Q' - 32] = { 14, 17, 17, 17, 21, 18, 13 },
	['R' - 32] = { 30, 17, 17, 30, 20, 18, 17 },
	['S' - 32] = { 15, 16, 16, 14, 1, 1, 30 },
	['T' - 32] = { 31, 4, 4, 4, 4, 4, 4 },
	['U' - 32] = { 17, 17, 17, 17, 17, 17, 14 },
	['V' - 32] = { 17, 17, 17, 17, 17, 10, 4 },
	['W' - 32] = { 17, 17, 17, 21, 21, 21, 10 },
	['X' - 32] = { 17, 17, 10, 4, 10, 17, 17 },
	['Y' - 32] = { 17, 17, 17, 10, 4, 4, 4 },
	['Z' - 32] = { 31, 1, 2, 4, 8, 16, 31 },
};

static int text_w(const char *s, int scale) { return (int)strlen(s) * 6 * scale - scale; }

static void glyphs(int x, int y, const char *s, uint32_t c, int scale)
{
	for (; *s; s++, x += 6 * scale) {
		int ch = *s >= 'a' && *s <= 'z' ? *s - 32 : *s;
		const uint8_t *g = font[ch >= 32 && ch < 96 ? ch - 32 : '?' - 32];
		for (int row = 0; row < 7; row++)
			for (int col = 0; col < 5; col++)
				if (g[row] & (16 >> col))
					for (int sy = 0; sy < scale; sy++)
						hspan(x + col * scale, x + col * scale + scale - 1, y + row * scale + sy, c);
	}
}

/* Text with a one-pixel shadow; marks its box in the marking pass. */
static void text(int x, int y, const char *s, uint32_t c, int scale)
{
	if (marking) {
		mark(x, y, x + text_w(s, scale), y + 7 * scale);
		return;
	}
	glyphs(x + 1, y + 1, s, 0x000000, scale);
	glyphs(x, y, s, c, scale);
}

static void textc(int y, const char *s, uint32_t c, int scale) { text((LW - text_w(s, scale)) / 2, y, s, c, scale); }
static void textr(int y, const char *s, uint32_t c) { text(LW - MG - text_w(s, 1), y, s, c, 1); }

/* ---- the framebuffer ------------------------------------------------------ */

static void blit_tile(int tx, int ty)
{
	int x0 = tx * TS, x1 = imin(x0 + TS, LW), y0 = ty * TS, y1 = imin(y0 + TS, LH);
	size_t n = (size_t)(x1 - x0) * S * 4;
	for (int y = y0; y < y1; y++) {
		const uint32_t *s = &PX(scr, x0, y);
		uint32_t *d = fb + (size_t)(oy + y * S) * fb_stride + ox + x0 * S;
		if (S == 1) {
			memcpy(d, s, n);
			continue;
		}
		if (S == 2 && !(((uintptr_t)d | fb_stride * 4) & 7)) { /* the common case, two pixels a store */
			uint64_t *d0 = (uint64_t *)d, *d1 = (uint64_t *)(d + fb_stride);
			for (int x = 0; x < x1 - x0; x++)
				d0[x] = d1[x] = s[x] | (uint64_t)s[x] << 32;
			continue;
		}
		uint32_t *p = rowbuf;
		for (int x = 0; x < x1 - x0; x++)
			for (int k = 0; k < S; k++)
				*p++ = s[x];
		for (int k = 0; k < S; k++)
			memcpy(d + (size_t)k * fb_stride, rowbuf, n);
	}
}

/* ---- layout and background ------------------------------------------------ */

static void choose_scale(unsigned w, unsigned h)
{
	int sb = 1;
	while ((uint64_t)(w / sb) * (h / sb) > BUDGET)
		sb++;
	S = imax(1, imin(sb, imin((int)w / 160, (int)h / 140)));
	LW = w / S;
	LH = h / S;
}

static int layout(void)
{
	KS = imin(LW, LH) * 256 / 240;
	HUD2 = LW < 264;
	TOP = MG + (HUD2 ? 20 : 9) + 3;
	GROUND = LH - clamp(LH / 9, 16, 36);
	TW = (LW + TS - 1) / TS;
	TH = (LH + TS - 1) / TS;
	moon_x = LW - (LW >= 264 ? 44 : 28);
	moon_y = TOP + 22;
	size_t px = (size_t)LW * LH, tiles = (size_t)TW * TH;
	scr = calloc(px, 4), bgbase = calloc(px, 4), bg = calloc(px, 4);
	rowbuf = calloc((size_t)TS * S, 4);
	tcur = calloc(tiles, 1), tprev = calloc(tiles, 1), tforce = calloc(tiles, 1), tdirty = calloc(tiles, 1);
	tgt = scr;
	cxs = LW * S / 2, cys = (TOP + GROUND) * S / 2;
	return scr && bgbase && bg && rowbuf && tcur && tprev && tforce && tdirty ? 0 : -1;
}

static uint32_t rgb(int r, int g, int b) { return (uint32_t)clamp(r, 0, 255) << 16 | (uint32_t)clamp(g, 0, 255) << 8 | (uint32_t)clamp(b, 0, 255); }

static void make_base(void)
{
	uint32_t saved = rs;
	rs = 0x9e3779b9; /* the same sky every game */
	for (int y = 0; y < LH; y++)
		for (int x = 0; x < LW; x++) {
			int dx = x - moon_x, dy = y - moon_y, d2 = dx * dx + dy * dy;
			int cut = (dx + 6) * (dx + 6) + (dy + 4) * (dy + 4);
			int hill = GROUND - 14 - ((isin((x * 3 / 2) & 63) * 7) >> 8) - ((isin((x * 5 / 7 + 20) & 63) * 5) >> 8);
			uint32_t c;
			if (y >= GROUND)
				c = rgb(0x1c - (y - GROUND) / 3, 0x3c - (y - GROUND) / 2, 0x2a - (y - GROUND) / 3);
			else if (y >= hill)
				c = rgb(0x16, 0x1e, 0x3a);
			else if (d2 <= 13 * 13 && cut > 12 * 12)
				c = 0xf4eccc;
			else
				c = rgb(0x0a + 0x26 * y / GROUND, 0x0e + 0x0c * y / GROUND, 0x2a + 0x28 * y / GROUND) +
				    (d2 < 22 * 22 ? 0x0a0a0c : 0);
			PX(bgbase, x, y) = c;
		}
	for (int i = 0, n = LW * LH / 1300; i < n; i++) {
		int x = 1 + rn(LW - 2), y = TOP + rn(GROUND - 40 - TOP), b = 0x60 + rn(0x80);
		if ((x - moon_x) * (x - moon_x) + (y - moon_y) * (y - moon_y) < 26 * 26)
			continue;
		PX(bgbase, x, y) = rgb(b, b, b + 0x20);
		if (b > 0xc8) {
			uint32_t d = rgb(b / 3, b / 3, b / 2);
			PX(bgbase, x - 1, y) = PX(bgbase, x + 1, y) = PX(bgbase, x, y - 1) = PX(bgbase, x, y + 1) = d;
		}
	}
	for (int x = 0; x < LW; x++)
		for (int h = rn(4), y = GROUND - 1; y >= GROUND - h; y--)
			PX(bgbase, x, y) = 0x2c6b3e;
	rs = saved;
}

static void panel_box(int x0, int y0, int x1, int y1)
{
	x0 = imax(x0, 0), y0 = imax(y0, 0), x1 = imin(x1, LW - 1), y1 = imin(y1, LH - 1);
	for (int y = y0; y <= y1; y++)
		for (int x = x0; x <= x1; x++)
			PX(bg, x, y) = ((PX(bg, x, y) >> 2) & 0x3f3f3f) + 0x08061a;
	for (int x = x0; x <= x1; x++)
		PX(bg, x, y0) = PX(bg, x, y1) = 0x7a68c8;
	for (int y = y0; y <= y1; y++)
		PX(bg, x0, y) = PX(bg, x1, y) = 0x7a68c8;
}

/* Panel text, laid out top to bottom: a measuring pass, then a drawing pass. */
static int lay_draw, lay_y, lay_x0, lay_x1;

static void lay_center(const char *s, uint32_t c, int scale)
{
	if (lay_draw)
		textc(lay_y, s, c, scale);
	lay_y += 7 * scale + 3 + scale;
}

/* A key and what it does: two columns when there is room, else stacked;
 * tighter on short screens. */
static void lay_row(const char *k, const char *d)
{
	int w = lay_x1 - lay_x0, cols = 11 * 6 + 10 + 22 * 6, compact = LH < 220;
	if (w >= cols) {
		int x = lay_x0 + (w - cols) / 2;
		if (lay_draw)
			text(x, lay_y, k, 0x9fe8ff, 1), text(x + 76, lay_y, d, 0xe8e0ff, 1);
		lay_y += compact ? 11 : 13;
	} else {
		if (lay_draw)
			text(lay_x0, lay_y, k, 0x9fe8ff, 1), text(lay_x0 + imin(12, w - text_w(d, 1)), lay_y + 9, d, 0xe8e0ff, 1);
		lay_y += compact ? 18 : 20;
	}
}

/* The panel for the state. lvl 0..5 makes the title screen ever shorter:
 * fewer help rows (the mouse rows merged, then gone), no subtitle. */
static void panel_content(int lvl)
{
	static const char *help[][2] = {
		{ "ARROWS/WASD", "FLOAT, CATCH STARS" },
		{ "SPACE/CTRL", "BLOOM AWAY THE GLOOMS" },
		{ "MOUSE/DRAG", "WISP PULLS STARS IN" },
		{ "CLICK/TAP", "BLOOM AT THE WISP" },
		{ "ESC", "PAUSE, TWICE TO QUIT" },
		{ "TIP", "STARS REFILL BLOOMS" },
		{ "DRAG/CLICK", "WISP PULLS, TAP BLOOMS" },
		{ "M/TAB", "SOUND ON/OFF" }, /* shown only with a sound device */
	};
	static const signed char sets[6][8] = {
		{ 0, 1, 2, 3, 4, 7, 5, -1 }, { 0, 1, 2, 3, 4, 7, -1 }, { 0, 1, 6, 4, 7, -1 },
		{ 0, 1, 6, 4, -1 }, { 0, 1, 4, -1 }, { -1 },
	};
	char s[48];
	int gap = LH < 220 ? 3 : 6;
	if (state == TITLE) {
		title_y = lay_y;
		if (text_w("GLIMMER MEADOW", 2) + 40 <= lay_x1 - lay_x0) {
			lay_center("GLIMMER MEADOW", 0xffe27a, 2);
		} else {
			lay_center("GLIMMER", 0xffe27a, 2);
			lay_center("MEADOW", 0xffe27a, 2);
		}
		if (LH >= 220 && lvl <= 2)
			lay_center("AN UNKERNEL NIGHT GAME", 0xa898d8, 1);
		lay_y += gap;
		for (const signed char *r = sets[lvl]; *r >= 0; r++)
			if (*r != 7)
				lay_row(help[*r][0], help[*r][1]);
			else if (snd_fd >= 0)
				lay_row(help[7][0], snd_muted ? "TURN THE SOUND ON" : "TURN THE SOUND OFF");
		lay_y += gap;
		prompt_y = lay_y;
		lay_y += 11;
		if (best) {
			snprintf(s, sizeof(s), "BEST %d", best);
			lay_center(s, 0xffb0d0, 1);
		}
	} else if (state == PAUSE) {
		lay_center("PAUSED", 0xffe27a, 2);
		lay_y += gap;
		lay_center("ENTER  RESUME   ", 0xe8e0ff, 1);
		lay_center("SPACE  NEW GAME ", 0xe8e0ff, 1);
		lay_center("ESC    QUIT     ", 0xe8e0ff, 1);
		if (snd_fd >= 0)
			lay_center(snd_muted ? "M/TAB  SOUND ON " : "M/TAB  SOUND OFF", 0xe8e0ff, 1);
	} else if (state == OVER) {
		lay_center("GOOD NIGHT", 0xffe27a, 2);
		lay_y += gap - 2;
		snprintf(s, sizeof(s), "SCORE %d", score);
		lay_center(s, 0xe8e0ff, 1);
		snprintf(s, sizeof(s), "FLOWERS %d", flowers);
		lay_center(s, 0xa0f0b0, 1);
		snprintf(s, sizeof(s), new_best ? "NEW BEST!" : "BEST %d", best);
		lay_center(s, 0xffb0d0, 1);
		lay_y += gap;
		int show = lay_draw;
		lay_draw = show && state_t >= 60;
		lay_center("ENTER/SPACE: AGAIN", 0x9fe8ff, 1);
		lay_center("ESC: QUIT", 0x9fe8ff, 1);
		lay_draw = show;
	}
}

/* The background for the current state: the meadow, plus a panel for the
 * title, pause and game over screens, centred in the upper three quarters
 * where it fits. Redraws everything. */
static void make_bg(void)
{
	memcpy(bg, bgbase, (size_t)LW * LH * 4);
	if (state != PLAY) {
		int maxw = state == TITLE ? 256 : state == PAUSE ? 160 : 200;
		int pw = imin(LW - 2 * MG, maxw), lvl, pick = -1, h, top = TOP + 2, safe = LH * 3 / 4;
		panel_x0 = (LW - pw) / 2, panel_x1 = panel_x0 + pw - 1;
		lay_x0 = panel_x0 + 8, lay_x1 = panel_x1 - 8;
		/* the fullest panel that fits above the bottom quarter (the
		 * corners there are for touch controls), else the fullest that
		 * fits at all, else the shortest */
		for (lvl = 0; lvl < 6; lvl++) {
			lay_draw = 0, lay_y = 0;
			panel_content(lvl);
			h = lay_y + 18;
			if (top + h <= safe)
				break;
			if (pick < 0 && top + h <= LH - MG)
				pick = lvl;
		}
		if (lvl == 6) {
			lvl = pick >= 0 ? pick : 5;
			lay_draw = 0, lay_y = 0;
			panel_content(lvl);
			h = lay_y + 18;
		}
		int y0 = top + imax(0, (safe - top - h) / 2);
		y0 = imax(top, imin(y0, LH - MG - h));
		tgt = bg;
		panel_box(panel_x0, y0, panel_x1, y0 + h - 1);
		lay_draw = 1, lay_y = y0 + 10;
		panel_content(lvl);
		tgt = scr;
	}
	mark_all();
}

static void plant_flower(int x)
{
	static const uint32_t pal[] = { 0xff8fb8, 0xfff0f5, 0xffb347, 0x9fd8ff, 0xd7a6ff, 0xff6f6f };
	int base = GROUND + 6 + rn(LH - GROUND - 9), h = 5 + rn(6), y = base - h - 2;
	uint32_t c = pal[rn(6)];
	x = clamp(x, 3, LW - 4);
	for (int pass = 0; pass < 2; pass++) {
		tgt = pass ? bg : bgbase;
		for (int sy = y + 1; sy <= base; sy++)
			put(x, sy, 0x3f9a4f);
		put(x - 1, base - 2, 0x3f9a4f), put(x + 1, base - 3, 0x3f9a4f);
		put(x - 2, y, c), put(x + 2, y, c), put(x, y - 2, c), put(x, y + 2, c);
		put(x - 1, y - 1, c), put(x + 1, y - 1, c), put(x - 1, y + 1, c), put(x + 1, y + 1, c);
		put(x, y, 0xffe066);
	}
	tgt = scr;
	mark_into(tforce, x - 3, y - 3, x + 3, base);
}

/* ---- sprites -------------------------------------------------------------- */

static void draw_pip(int x, int y, int face)
{
	fill_circle(x, y, 7, 0x6a5418);
	fill_circle(x, y, 6, 0xffd45a);
	put(x - 2, y - 3, 0xfff4c0), put(x - 3, y - 2, 0xfff4c0);
	for (int e = -1; e <= 1; e += 2) {
		put(x + 2 * e + face, y - 1, 0x2a1a10);
		put(x + 2 * e + face, y, 0x2a1a10);
		put(x + 4 * e + face, y + 2, 0xff9a8a);
	}
	put(x, y - 7, 0x6fdc6f), put(x, y - 8, 0x6fdc6f), put(x + 1, y - 9, 0x6fdc6f), put(x + 2, y - 9, 0x6fdc6f);
	put(x - 1, y - 9, 0x4fb04f);
}

static void draw_gloom(int x, int y, int ph, int lx, int ly)
{
	int r = 7 + (isin(ph) >> 7);
	fill_circle(x, y, r, 0x2e1d52);
	fill_circle(x, y - 1, r - 1, 0x6c47a6);
	put(x - 2, y - r + 1, 0x9a78d0), put(x - 3, y - r + 2, 0x9a78d0);
	for (int e = -1; e <= 1; e += 2) {
		int ex = x + 3 * e - (e > 0), ey = y - 2;
		hspan(ex, ex + 1, ey, 0xffffff), hspan(ex, ex + 1, ey + 1, 0xffffff);
		put(ex + (lx > 0), ey + (ly > 0), 0x180c28);
	}
	hspan(x - 2, x + 2, y + 3, 0x2e1d52);
}

static void draw_mote(int x, int y, int ph, int k)
{
	static const uint32_t cols[3] = { 0xffe680, 0x9ff3ff, 0xffb0e0 };
	uint32_t c = cols[k % 3];
	int arm = (ph >> 3) & 1 ? 2 : 3;
	for (int i = 1; i <= arm; i++)
		put(x - i, y, c), put(x + i, y, c), put(x, y - i, c), put(x, y + i, c);
	put(x - 1, y - 1, c), put(x + 1, y + 1, c), put(x + 1, y - 1, c), put(x - 1, y + 1, c);
	put(x, y, 0xffffff);
}

/* The HUD along the top edge: one row when wide, two when narrow. */
static void draw_hud(void)
{
	char sig[64], s[24];
	int y2 = HUD2 ? MG + 11 : MG;
	int hx = HUD2 ? MG : MG + 66, bx0 = hx + 38, bx1 = HUD2 ? LW - MG - 34 : bx0 + 52;
	int bar = energy * (bx1 - bx0 - 2) / 1000;
	snprintf(sig, sizeof(sig), "%d %d %d %d %d %d %d %d %d", state, score, combo / 4, hearts, bar,
		 bar_flash > 0 ? 1 + (bar_flash / 5) % 2 : 0, level, fps, best);
	if (marking) {
		if (strcmp(sig, hud_sig)) {
			strcpy(hud_sig, sig);
			mark(0, 0, LW - 1, TOP - 1);
		}
		return;
	}
	snprintf(s, sizeof(s), "%d FPS", fps);
	textr(MG, s, 0x8a80b0);
	if (state == TITLE)
		return;
	snprintf(s, sizeof(s), "#%d", score);
	text(MG, MG, s, 0xffe680, 1);
	if (combo >= 4) {
		int x = MG + text_w(s, 1) + 6;
		snprintf(s, sizeof(s), "X%d", 1 + imin(combo / 4, 4));
		text(x, MG, s, 0x9ff3ff, 1);
	}
	for (int i = 0; i < hearts; i++)
		text(hx + 7 * i, y2, "@", 0xff7aa8, 1);
	uint32_t frame = bar_flash > 0 && (bar_flash / 5) % 2 ? 0xff5050 : 0x6a5aa0;
	for (int x = bx0; x <= bx1; x++)
		put(x, y2 - 1, frame), put(x, y2 + 7, frame);
	for (int y = y2 - 1; y <= y2 + 7; y++)
		put(bx0, y, frame), put(bx1, y, frame);
	for (int y = y2 + 1; y <= y2 + 5; y++)
		hspan(bx0 + 1, bx0 + 1 + bar, y, bar_flash > 0 ? 0xff5050 : energy >= BLOOM_COST ? 0x7ee08a : 0x4a8a58);
	snprintf(s, sizeof(s), "LV%d", level);
	if (HUD2)
		textr(y2, s, 0xa898d8);
	else
		text(bx1 + 8, y2, s, 0xa898d8, 1);
}

/* Everything that moves or changes; run once to mark, once to draw. */
static void scene(void)
{
	if (state == TITLE) {
		int b = isin(anim) * 3 >> 8;
		draw_pip(lay_x0 + 8, title_y + 7 + b, 1);
		draw_gloom(lay_x1 - 8, title_y + 7 - b, anim * 2, -1, 1);
		if ((anim / 30) % 2 == 0)
			textc(prompt_y, "PRESS ENTER OR SPACE", 0xffffff, 1);
	} else if (state == PLAY) {
		for (int i = 0; i < NMOTE; i++)
			if (motes[i].on)
				draw_mote(motes[i].x >> FP, motes[i].y >> FP, motes[i].ph, motes[i].k);
		for (int i = 0; i < NGLOOM; i++)
			if (glooms[i].on)
				draw_gloom(glooms[i].x >> FP, glooms[i].y >> FP, glooms[i].ph,
					   pip.x - glooms[i].x, pip.y - glooms[i].y);
		for (int i = 0; i < NRING; i++)
			if (rings[i].on) {
				static const uint32_t rc[4] = { 0xe0ffe8, 0xb0f8c0, 0x80e0a0, 0x58b880 };
				int r = rings[i].k >> FP;
				uint32_t c = rc[imin(r * 4 / imax(1, sc(60)), 3)];
				ring_line(rings[i].x >> FP, rings[i].y >> FP, r, c);
				ring_line(rings[i].x >> FP, rings[i].y >> FP, r - 1, c);
			}
		if (fizz.on) { /* sparks puff out, sag and fade */
			int r = 9 + fizz.t;
			uint32_t c = fizz.t < 7 ? 0xff96a8 : fizz.t < 14 ? 0xc06a7c : 0x7c4a5a;
			for (int a = 4; a < 68; a += 8) {
				int x = fizz.x + (isin(a) * r >> 8), y = fizz.y + (isin(a + 16) * r >> 8) + fizz.t * fizz.t / 40;
				hspan(x, x + 1, y, c), hspan(x, x + 1, y + 1, c);
			}
		}
		if (!pip.inv || (pip.inv / 4) % 2)
			draw_pip(pip.x >> FP, pip.y >> FP, pip.face);
		for (int i = 0; i < NFT; i++)
			if (fts[i].on)
				text(fts[i].x - text_w(fts[i].s, fts[i].scale) / 2, fts[i].y >> FP, fts[i].s, fts[i].c, fts[i].scale);
		if (cur_on) {
			int x = cxs / S, y = cys / S;
			ring_line(x, y, 4, 0x9ff3ff);
			put(x, y, 0xffffff);
			put(x + (isin(anim * 2) * 8 >> 8), y + (isin(anim * 2 + 16) * 8 >> 8), 0xd0ffff);
			put(x - (isin(anim * 2) * 8 >> 8), y - (isin(anim * 2 + 16) * 8 >> 8), 0xd0ffff);
		}
	}
	draw_hud();
}

static void render(void)
{
	int tiles = TW * TH;
	marking = 1;
	scene();
	marking = 0;
	for (int t = 0; t < tiles; t++)
		if ((tdirty[t] = tprev[t] | tcur[t] | tforce[t])) {
			int x0 = t % TW * TS, y0 = t / TW * TS, n = imin(TS, LW - x0) * 4;
			for (int y = y0; y < imin(y0 + TS, LH); y++)
				memcpy(&PX(scr, x0, y), &PX(bg, x0, y), n);
		}
	scene();
	for (int t = 0; t < tiles; t++) {
		if (tdirty[t])
			blit_tile(t % TW, t / TW);
		tprev[t] = tcur[t];
		tcur[t] = tforce[t] = 0;
	}
}

/* ---- sound ---------------------------------------------------------------- */

/* A few voices mixed in software into 22050 Hz stereo S16_LE and written to
 * the ALSA PCM with the raw ioctls (the image has no alsa-lib). The device
 * is non-blocking: every frame, snd_pump() tops the queue up to SND_FILL
 * frames (46 ms) and returns; an underrun (a frame that came late) shows
 * as EPIPE or the XRUN state and is fixed with PREPARE. No device, or any
 * error, means silence. */
#define SR 22050
#define SND_PERIOD 256          /* frames, 11.6 ms (kwsnd ticks every 10 ms) */
#define SND_PERIODS 8           /* a ring of 2048 frames, 93 ms */
#define SND_FILL 1024           /* frames queued after each pump, 46 ms */
#define NVOICE 8
#define BLK 32                  /* envelope and slide step, in samples */
#define ECHO_LEN (SR * 3 / 20)  /* 150 ms */
#define ECHO_WET 80             /* first echo, of 256 */
#define ECHO_FB 100             /* each later one, of 256 */

enum { W_SINE, W_TRI, W_BELL, W_SQ, W_NOISE };

struct voice {
	int wait, t, len, att;  /* samples: delay, position, length, attack */
	uint32_t ph, step;      /* phase (2^32 a cycle) and its step per sample */
	int dstep;              /* change of step every BLK samples (a slide) */
	int wave, vol, gl, gr;  /* vol: peak of 32767; gl, gr: gains of 256 */
	uint32_t nz;            /* W_NOISE: the held random value */
};

static struct voice voices[NVOICE];
static int16_t sintab[256], snd_buf[2 * SND_FILL];
static int32_t acc[2 * SND_FILL], echo_l[ECHO_LEN], echo_r[ECHO_LEN];
static int echo_p, snd_quiet, snd_err;
static unsigned snd_buffer;
static unsigned long snd_xruns, snd_written;
static uint32_t nrs = 0x2545f491;

/* sin(2 pi i / n) without libm: a Taylor series on [-pi, pi] (error under
 * 1e-15), for the sine table and the test signal. */
static double sin_turn(long i, long n)
{
	double x = 6.283185307179586 * (double)(i % n) / n, t, s, x2;
	if (x > 3.141592653589793)
		x -= 6.283185307179586;
	t = s = x, x2 = x * x;
	for (int k = 1; k < 15; k++)
		s += t *= -x2 / ((2 * k) * (2 * k + 1));
	return s;
}

/* v * 32767, rounded half away from zero. */
static int16_t q15(double v) { return (int16_t)(v * 32767 + (v < 0 ? -0.5 : 0.5)); }

static uint32_t hz_step(int hz) { return (uint32_t)(((uint64_t)hz << 32) / SR); }

/* Start a note after delay_ms: len_ms long with an att_ms attack and a
 * quadratic fade to zero, sliding linearly from hz0 to hz1, peak vol (of
 * 32767), panned towards logical x (-1: the middle). */
static void note(int wave, int delay_ms, int len_ms, int att_ms, int hz0, int hz1, int vol, int x)
{
	struct voice *v = NULL;
	if (snd_fd < 0 || snd_muted)
		return;
	for (int i = 0; i < NVOICE; i++) { /* a free voice, else the one nearest its end */
		struct voice *c = &voices[i];
		if (!c->len) {
			v = c;
			break;
		}
		if (!v || c->wait + c->len - c->t < v->wait + v->len - v->t)
			v = c;
	}
	int p = x < 0 ? 128 : clamp(x * 256 / imax(LW, 1), 0, 256);
	*v = (struct voice){ .wait = delay_ms * SR / 1000, .len = imax(len_ms * SR / 1000, 2 * BLK),
			     .step = hz_step(hz0), .wave = wave, .vol = vol, .nz = 0,
			     .gl = 256 - imax(0, p - 128), .gr = 256 - imax(0, 128 - p) };
	v->att = clamp(att_ms * SR / 1000, 64, v->len / 2); /* >= 3 ms: no click */
	v->dstep = (int)(((int64_t)hz_step(hz1) - (int64_t)v->step) * BLK / v->len);
}

static int env_at(const struct voice *v, int t)
{
	if (t >= v->len)
		return 0;
	if (t < v->att)
		return t * 32767 / v->att;
	int r = (int)((int64_t)(v->len - t) * 32767 / (v->len - v->att));
	return r * r >> 15;
}

/* n frames of the voices and the echo, interleaved, into out. */
static void mix(int16_t *out, int n)
{
	int active = 0;
	for (int i = 0; i < NVOICE; i++)
		active |= voices[i].len;
	if (!active && snd_quiet > ECHO_LEN * 16) { /* the echo has died away */
		memset(out, 0, (size_t)n * 4);
		return;
	}
	memset(acc, 0, (size_t)n * 8);
	for (int j = 0; j < NVOICE; j++) {
		struct voice *v = &voices[j];
		int i = 0;
		if (!v->len)
			continue;
		if (v->wait) {
			i = imin(v->wait, n);
			v->wait -= i;
		}
		while (i < n && v->t < v->len) {
			int b = imin(imin(n - i, BLK - v->t % BLK), v->len - v->t);
			int e = env_at(v, v->t), de = (env_at(v, v->t + b) - e) / b;
			for (int k = 0; k < b; k++, i++, e += de) {
				uint32_t ph = v->ph;
				int s;
				switch (v->wave) {
				case W_SINE:
					s = sintab[ph >> 24];
					break;
				case W_TRI:
					s = (int)((ph + 0x40000000u) >> 16);
					s = s < 32768 ? s * 2 - 32767 : 98303 - s * 2;
					break;
				case W_BELL: /* with its octave, a little brighter */
					s = (sintab[ph >> 24] * 3 + sintab[(ph >> 23) & 255]) / 4;
					break;
				case W_SQ:
					s = ph < 0x80000000u ? 20000 : -20000;
					break;
				default: /* noise, a new value every cycle */
					if (ph + v->step < ph) {
						nrs ^= nrs << 13, nrs ^= nrs >> 17, nrs ^= nrs << 5;
						v->nz = nrs;
					}
					s = (int16_t)(v->nz >> 16);
					break;
				}
				v->ph = ph + v->step;
				s = (s * e >> 15) * v->vol >> 15;
				acc[2 * i] += s * v->gl >> 8;
				acc[2 * i + 1] += s * v->gr >> 8;
			}
			v->t += b;
			if (!(v->t % BLK))
				v->step += v->dstep;
		}
		if (v->t >= v->len)
			v->len = 0;
	}
	/* a soft ping-pong echo: left at 150 ms, right at 300 ms, ... (the
	 * division rounds towards zero, so it dies away to exactly 0) */
	for (int i = 0; i < n; i++) {
		int el = echo_l[echo_p], er = echo_r[echo_p];
		echo_l[echo_p] = ((acc[2 * i] + acc[2 * i + 1]) / 2 * ECHO_WET + er * ECHO_FB) / 256;
		echo_r[echo_p] = el * ECHO_FB / 256;
		if (++echo_p == ECHO_LEN)
			echo_p = 0;
		out[2 * i] = (int16_t)clamp(acc[2 * i] + el, -32767, 32767);
		out[2 * i + 1] = (int16_t)clamp(acc[2 * i + 1] + er, -32767, 32767);
	}
	snd_quiet = active ? 0 : snd_quiet + n;
}

static struct snd_mask *hw_mask(struct snd_pcm_hw_params *p, int var) { return &p->masks[var - SNDRV_PCM_HW_PARAM_FIRST_MASK]; }
static struct snd_interval *hw_iv(struct snd_pcm_hw_params *p, int var) { return &p->intervals[var - SNDRV_PCM_HW_PARAM_FIRST_INTERVAL]; }

static void hw_any(struct snd_pcm_hw_params *p)
{
	memset(p, 0, sizeof(*p));
	for (int i = 0; i <= SNDRV_PCM_HW_PARAM_LAST_MASK - SNDRV_PCM_HW_PARAM_FIRST_MASK; i++)
		memset(p->masks[i].bits, 0xff, sizeof(p->masks[i].bits));
	for (int i = 0; i <= SNDRV_PCM_HW_PARAM_LAST_INTERVAL - SNDRV_PCM_HW_PARAM_FIRST_INTERVAL; i++)
		p->intervals[i].max = UINT32_MAX;
	p->rmask = ~0u;
	p->info = ~0u;
}

static void hw_set(struct snd_pcm_hw_params *p, int var, unsigned v)
{
	if (var <= SNDRV_PCM_HW_PARAM_LAST_MASK) {
		struct snd_mask *m = hw_mask(p, var);
		memset(m->bits, 0, sizeof(m->bits));
		m->bits[v / 32] = 1u << (v % 32);
	} else {
		struct snd_interval *i = hw_iv(p, var);
		i->min = i->max = v;
		i->openmin = i->openmax = 0;
		i->integer = 1;
	}
}

/* Open the PCM non-blocking and set it up: 0, or -1 with snd_err set to
 * errno and *what to the step that failed. */
static int snd_open(const char **what)
{
	struct snd_pcm_hw_params hw;
	struct snd_pcm_sw_params sw = { 0 };
	int fd = open("/dev/snd/pcmC0D0p", O_WRONLY | O_NONBLOCK | O_CLOEXEC), pver = SNDRV_PCM_VERSION;

	*what = "/dev/snd/pcmC0D0p";
	if (fd < 0)
		goto fail;
	ioctl(fd, SNDRV_PCM_IOCTL_USER_PVERSION, &pver);
	hw_any(&hw);
	hw_set(&hw, SNDRV_PCM_HW_PARAM_ACCESS, SNDRV_PCM_ACCESS_RW_INTERLEAVED);
	hw_set(&hw, SNDRV_PCM_HW_PARAM_FORMAT, SNDRV_PCM_FORMAT_S16_LE);
	hw_set(&hw, SNDRV_PCM_HW_PARAM_SUBFORMAT, SNDRV_PCM_SUBFORMAT_STD);
	hw_set(&hw, SNDRV_PCM_HW_PARAM_CHANNELS, 2);
	hw_set(&hw, SNDRV_PCM_HW_PARAM_RATE, SR);
	hw_set(&hw, SNDRV_PCM_HW_PARAM_PERIOD_SIZE, SND_PERIOD);
	hw_set(&hw, SNDRV_PCM_HW_PARAM_PERIODS, SND_PERIODS);
	*what = "HW_PARAMS";
	if (ioctl(fd, SNDRV_PCM_IOCTL_HW_PARAMS, &hw) < 0)
		goto fail;
	snd_buffer = hw_iv(&hw, SNDRV_PCM_HW_PARAM_BUFFER_SIZE)->min;
	sw.tstamp_mode = SNDRV_PCM_TSTAMP_NONE;
	sw.period_step = 1;
	sw.avail_min = SND_PERIOD;
	sw.xfer_align = 1;
	sw.start_threshold = 1;          /* start with the first write */
	sw.stop_threshold = snd_buffer;  /* stop (XRUN) when it runs dry */
	*what = "SW_PARAMS";
	if (ioctl(fd, SNDRV_PCM_IOCTL_SW_PARAMS, &sw) < 0)
		goto fail;
	*what = "PREPARE";
	if (ioctl(fd, SNDRV_PCM_IOCTL_PREPARE) < 0)
		goto fail;
	for (int i = 0; i < 256; i++)
		sintab[i] = q15(sin_turn(i, 256));
	snd_fd = fd;
	return 0;
fail:
	snd_err = errno;
	if (fd >= 0)
		close(fd);
	return -1;
}

static void snd_close(void)
{
	if (snd_fd >= 0)
		close(snd_fd); /* drops what is queued and releases the device */
	snd_fd = -1;
}

/* Top the queue up to SND_FILL frames with gen(), at most max frames; never
 * blocks. Returns the frames written. */
static long snd_pump(void (*gen)(int16_t *, int), long max)
{
	struct snd_pcm_status st;
	struct snd_xferi x = { .buf = snd_buf };

	if (snd_fd < 0 || snd_muted)
		return 0;
	memset(&st, 0, sizeof(st));
	if (ioctl(snd_fd, SNDRV_PCM_IOCTL_STATUS, &st) < 0)
		goto fail;
	if (st.state == SNDRV_PCM_STATE_XRUN || st.state == SNDRV_PCM_STATE_SETUP) {
		snd_xruns += st.state == SNDRV_PCM_STATE_XRUN;
		if (ioctl(snd_fd, SNDRV_PCM_IOCTL_PREPARE) < 0)
			goto fail;
		st.avail = snd_buffer;
	}
	long n = SND_FILL - ((long)snd_buffer - (long)st.avail);
	if (n > max)
		n = max;
	if (n < (max < SND_PERIOD / 4 ? max : SND_PERIOD / 4) || n <= 0)
		return 0;
	gen(snd_buf, (int)n);
	x.frames = n;
	if (ioctl(snd_fd, SNDRV_PCM_IOCTL_WRITEI_FRAMES, &x) < 0) {
		if (errno == EAGAIN)
			return 0;
		if (errno != EPIPE || ioctl(snd_fd, SNDRV_PCM_IOCTL_PREPARE) < 0 ||
		    ioctl(snd_fd, SNDRV_PCM_IOCTL_WRITEI_FRAMES, &x) < 0)
			goto fail;
		snd_xruns++;
	}
	snd_written += x.result;
	return x.result;
fail:
	snd_err = errno;
	snd_close(); /* give up quietly: the game goes on without sound */
	return 0;
}

static void snd_mute(int on)
{
	snd_muted = on;
	if (on && snd_fd >= 0) {
		ioctl(snd_fd, SNDRV_PCM_IOCTL_DROP);
		memset(voices, 0, sizeof(voices));
		memset(echo_l, 0, sizeof(echo_l));
		memset(echo_r, 0, sizeof(echo_r));
	}
}

/* The effects. x is where it happens (logical pixels), for the panning. */
static const short penta[9] = { 784, 880, 1047, 1175, 1319, 1568, 1760, 2093, 2349 }; /* G5 .. D7 */

static void sfx_catch(int chain, int x) /* higher up the scale as a chain grows */
{
	int f = penta[imin(chain, 16) / 2];
	note(W_BELL, 0, 130, 2, f, f, 6500, x);
}

static void sfx_bloom(int x)
{
	note(W_TRI, 0, 280, 20, 262, 784, 6500, x);
	note(W_NOISE, 0, 220, 30, 2500, 9000, 1500, x);
}

static void sfx_empty(int x) { note(W_SQ, 0, 110, 4, 156, 117, 3500, x); }

static void sfx_flower(int x)
{
	note(W_BELL, 0, 150, 2, 1047, 1047, 5000, x);
	note(W_BELL, 55, 150, 2, 1319, 1319, 5000, x);
	note(W_BELL, 110, 220, 2, 1568, 1568, 5000, x);
}

static void sfx_ouch(int x)
{
	note(W_TRI, 0, 340, 4, 523, 175, 8000, x);
	note(W_NOISE, 0, 90, 2, 1600, 500, 2500, x);
}

static void sfx_heart(int x)
{
	note(W_BELL, 0, 160, 2, 1319, 1319, 5000, x);
	note(W_BELL, 80, 260, 2, 1760, 1760, 5000, x);
}

static void sfx_level(void)
{
	static const short f[4] = { 523, 659, 784, 1047 };
	for (int i = 0; i < 4; i++)
		note(W_TRI, i * 85, i < 3 ? 150 : 420, 4, f[i], f[i], 6000, -1);
	note(W_BELL, 255, 420, 2, 2093, 2093, 2500, -1);
}

static void sfx_over(void)
{
	static const short f[4] = { 392, 330, 262, 196 };
	for (int i = 0; i < 4; i++)
		note(W_TRI, i * 230, i < 3 ? 280 : 800, 6, f[i], f[i], 7000, -1);
}

static void sfx_start(void)
{
	note(W_BELL, 0, 130, 2, 1047, 1047, 5500, -1);
	note(W_BELL, 90, 240, 2, 1568, 1568, 5500, -1);
}

static void sfx_pause(int down)
{
	note(W_TRI, 0, 90, 4, down ? 784 : 587, down ? 784 : 587, 5000, -1);
	note(W_TRI, 70, 130, 4, down ? 587 : 784, down ? 587 : 784, 5000, -1);
}

/* ---- the game ------------------------------------------------------------- */

static void ft_add(int x, int y, const char *s, uint32_t c, int scale)
{
	for (int i = 0; i < NFT; i++)
		if (!fts[i].on) {
			fts[i].on = 1, fts[i].x = x, fts[i].y = y << FP, fts[i].t = 45, fts[i].c = c, fts[i].scale = scale;
			snprintf(fts[i].s, sizeof(fts[i].s), "%s", s);
			return;
		}
}

static void set_state(int s)
{
	state = s;
	state_t = 0;
	make_bg();
}

static void new_game(void)
{
	memset(motes, 0, sizeof(motes));
	memset(glooms, 0, sizeof(glooms));
	memset(rings, 0, sizeof(rings));
	memset(fts, 0, sizeof(fts));
	memset(&pip, 0, sizeof(pip));
	pip.x = (LW / 2) << FP, pip.y = ((TOP + GROUND) / 2 + 20) << FP, pip.face = 1;
	score = combo = flowers = bar_flash = new_best = 0;
	hearts = 3, energy = 1000, level = 1, next_heart = 60, mote_t = 20, gloom_t = 150;
	games++;
	memset(&fizz, 0, sizeof(fizz));
	make_base();
	set_state(PLAY);
	sfx_start();
}

static void game_over(void)
{
	new_best = score > best;
	best = imax(best, score);
	set_state(OVER);
	sfx_over();
}

/* A bloom at x, y (fixed point). Without the energy for one it fizzles
 * where it was asked for: a puff of dim sparks, "NEED STARS" (once per
 * flash) and the energy bar flashing red. */
static void try_bloom(int x, int y)
{
	if (energy < BLOOM_COST) {
		if (!bar_flash)
			ft_add(x >> FP, (y >> FP) - 16, "NEED STARS", 0xff8a8a, 1);
		bar_flash = 30;
		fizz.on = 1, fizz.x = x >> FP, fizz.y = y >> FP, fizz.t = 0;
		sfx_empty(x >> FP);
		return;
	}
	for (int i = 0; i < NRING; i++)
		if (!rings[i].on) {
			rings[i] = (struct obj){ .on = 1, .x = x, .y = y, .k = 4 << FP };
			energy -= BLOOM_COST;
			sfx_bloom(x >> FP);
			return;
		}
}

static void game_tick(void)
{
	char s[16];
	int ax = (key[KEY_RIGHT] | key[KEY_D]) - (key[KEY_LEFT] | key[KEY_A]);
	int ay = (key[KEY_DOWN] | key[KEY_S]) - (key[KEY_UP] | key[KEY_W]);
	int acc = sc(ax && ay ? 51 : 72);

	pip.vx = (pip.vx + ax * acc) * 7 / 8;
	pip.vy = (pip.vy + ay * acc) * 7 / 8;
	if (ax)
		pip.face = ax;
	pip.x = clamp(pip.x + pip.vx, 8 << FP, (LW - 8) << FP);
	pip.y = clamp(pip.y + pip.vy, (TOP + 10) << FP, (GROUND - 8) << FP);
	if (pip.inv)
		pip.inv--;
	if (bar_flash)
		bar_flash--;
	if (fizz.on && ++fizz.t >= 20)
		fizz.on = 0;
	energy = imin(energy + 2, 1000);
	if (hit[KEY_SPACE] || hit[KEY_LEFTCTRL] || hit[KEY_RIGHTCTRL])
		try_bloom(pip.x, pip.y);
	if (click)
		try_bloom((cxs / S) << FP, (cys / S) << FP);

	if (--mote_t <= 0) {
		for (int i = 0; i < NMOTE; i++)
			if (!motes[i].on) {
				int sp = sc(90 + rn(130) + imin(level * 6, 60));
				motes[i] = (struct obj){ .on = 1, .x = (8 + rn(LW - 16)) << FP, .y = (TOP + 4) << FP,
							 .vy = sp, .sp = sp, .ph = rn(64), .k = rn(3), .life = 1500 };
				break;
			}
		mote_t = imax(8, (26 + rn(36) - imin(level * 2, 16)) * 320 / LW);
	}
	int ng = 0;
	for (int i = 0; i < NGLOOM; i++)
		ng += glooms[i].on;
	if (ng < imin(level + 1, NGLOOM) && --gloom_t <= 0) {
		for (int i = 0; i < NGLOOM; i++)
			if (!glooms[i].on) {
				int left = rn(2);
				glooms[i] = (struct obj){ .on = 1, .x = (left ? -8 : LW + 8) << FP,
							  .y = (TOP + 24 + rn(GROUND - TOP - 50)) << FP, .vx = left ? 64 : -64,
							  .ph = rn(64), .sp = sc(imin(100 + level * 16, 320) + rn(30)) };
				break;
			}
		gloom_t = 100 + rn(80) - imin(level * 8, 90);
	}

	for (int i = 0; i < NMOTE; i++) {
		struct obj *m = &motes[i];
		if (!m->on)
			continue;
		m->ph++;
		int dx = cxs / S - (m->x >> FP), dy = cys / S - (m->y >> FP);
		if (cur_on && dx * dx + dy * dy < 72 * 72) {
			m->vx = (m->vx + dx) * 14 / 16;
			m->vy = (m->vy + dy) * 14 / 16;
		} else {
			m->vx = m->vx * 15 / 16;
			m->vy += (m->sp - m->vy) / 16;
		}
		m->vx = clamp(m->vx, -3 * ONE, 3 * ONE);
		m->vy = clamp(m->vy, -3 * ONE, 3 * ONE);
		m->x = clamp(m->x + m->vx + isin(m->ph / 2) / 4, 4 << FP, (LW - 5) << FP);
		m->y = imax(m->y + m->vy, (TOP + 4) << FP);
		dx = (m->x - pip.x) >> FP, dy = (m->y - pip.y) >> FP;
		if (dx * dx + dy * dy < 12 * 12) {
			int mult = 1 + imin(combo / 4, 4);
			sfx_catch(combo, m->x >> FP);
			score += mult;
			combo++;
			energy = imin(energy + 70, 1000);
			snprintf(s, sizeof(s), "+%d", mult);
			ft_add(m->x >> FP, (m->y >> FP) - 10, s, 0xffe680, 1);
			m->on = 0;
		} else if (m->y >= (GROUND - 2) << FP || --m->life <= 0) {
			combo = 0;
			m->on = 0;
		}
	}

	for (int i = 0; i < NGLOOM; i++) {
		struct obj *g = &glooms[i];
		if (!g->on)
			continue;
		g->ph += 2;
		int dx = (pip.x - g->x) >> FP, dy = (pip.y - g->y) >> FP;
		int d = isqrt((unsigned)(dx * dx + dy * dy)) + 1;
		g->vx += (g->sp * dx / d - g->vx) / 24;
		g->vy += (g->sp * dy / d - g->vy) / 24;
		g->x += g->vx;
		g->y = clamp(g->y + g->vy + isin(g->ph) / 8, (TOP + 10) << FP, (GROUND - 8) << FP);
		if (!pip.inv && d < 13) {
			g->on = 0;
			hearts--;
			combo = 0;
			pip.inv = 120;
			ft_add(pip.x >> FP, (pip.y >> FP) - 18, "OUCH", 0xff7a7a, 1);
			if (hearts)
				sfx_ouch(pip.x >> FP);
			if (!hearts) {
				game_over();
				return;
			}
		}
	}

	int chimed = 0;
	for (int i = 0; i < NRING; i++) {
		struct obj *r = &rings[i];
		if (!r->on)
			continue;
		if ((r->k += 2 * KS) > 56 * KS) {
			r->on = 0;
			continue;
		}
		int rr = (r->k >> FP) + 7;
		for (int j = 0; j < NGLOOM; j++) {
			struct obj *g = &glooms[j];
			int dx = (g->x - r->x) >> FP, dy = (g->y - r->y) >> FP;
			if (g->on && dx * dx + dy * dy <= rr * rr) {
				g->on = 0;
				score += 5;
				flowers++;
				plant_flower(g->x >> FP);
				if (!chimed++) /* one chime a tick, however many turn */
					sfx_flower(g->x >> FP);
				ft_add(g->x >> FP, (g->y >> FP) - 12, "+5", 0xa0f0b0, 1);
			}
		}
	}

	if (score >= next_heart) {
		next_heart += 60;
		if (hearts < 5) {
			hearts++;
			ft_add(pip.x >> FP, (pip.y >> FP) - 18, "+@", 0xff7aa8, 1);
			sfx_heart(pip.x >> FP);
		}
	}
	if (1 + score / 30 > level) {
		level = 1 + score / 30;
		snprintf(s, sizeof(s), "LEVEL %d", level);
		ft_add(LW / 2, TOP + (GROUND - TOP) / 3, s, 0xffe27a, 2);
		sfx_level();
	}
	for (int i = 0; i < NFT; i++)
		if (fts[i].on) {
			fts[i].y -= ONE / 2;
			fts[i].on = --fts[i].t > 0;
		}
}

static void update(void)
{
	int confirm = hit[KEY_ENTER] || hit[KEY_KPENTER] || hit[KEY_SPACE];

	anim++;
	state_t++;
	if ((hit[KEY_M] || hit[KEY_TAB]) && snd_fd >= 0) {
		snd_mute(!snd_muted);
		if (!snd_muted)
			note(W_BELL, 0, 160, 2, 880, 880, 5000, -1);
		if (state == PLAY)
			ft_add(pip.x >> FP, (pip.y >> FP) - 18, snd_muted ? "SOUND OFF" : "SOUND ON", 0x9fe8ff, 1);
		else
			make_bg(); /* the panel says what M does */
	}
	switch (state) {
	case TITLE:
		if (hit[KEY_ESC])
			quit = 1;
		else if (confirm || click)
			new_game();
		break;
	case PLAY:
		if (hit[KEY_ESC]) {
			set_state(PAUSE);
			sfx_pause(1);
		} else {
			game_tick();
		}
		break;
	case PAUSE:
		if (hit[KEY_ESC])
			quit = 1;
		else if (hit[KEY_SPACE])
			new_game();
		else if (hit[KEY_ENTER] || hit[KEY_KPENTER]) {
			state = PLAY;
			make_bg();
			sfx_pause(0);
		}
		break;
	case OVER:
		if (state_t == 60)
			make_bg();
		if (hit[KEY_ESC])
			quit = 1;
		else if (state_t > 60 && (confirm || click))
			new_game();
		break;
	}
	memset(hit, 0, sizeof(hit));
	click = 0;
}

/* ---- devices -------------------------------------------------------------- */

static void read_input(void)
{
	struct input_event e[64];
	ssize_t n;

	while (kfd >= 0 && (n = read(kfd, e, sizeof(e))) > 0)
		for (size_t i = 0; i < (size_t)n / sizeof(e[0]); i++) {
			unsigned c = e[i].code;
			if (e[i].type != EV_KEY || c >= 256)
				continue;
			if (e[i].value == 1) {
				hit[c] |= !key[c];
				key[c] = 1;
			} else if (e[i].value == 0) {
				key[c] = 0;
			}
		}
	while (mfd >= 0 && (n = read(mfd, e, sizeof(e))) > 0)
		for (size_t i = 0; i < (size_t)n / sizeof(e[0]); i++) {
			/* absolute: the pointer's pixel on the device, into the field */
			if (e[i].type == EV_ABS && e[i].code == ABS_X && abs_x.maximum > abs_x.minimum)
				cxs = (int)((int64_t)(e[i].value - abs_x.minimum) * disp_w /
					    (abs_x.maximum - abs_x.minimum + 1)) - (int)ox, cur_on = 1;
			else if (e[i].type == EV_ABS && e[i].code == ABS_Y && abs_y.maximum > abs_y.minimum)
				cys = (int)((int64_t)(e[i].value - abs_y.minimum) * disp_h /
					    (abs_y.maximum - abs_y.minimum + 1)) - (int)oy, cur_on = 1;
			else if (e[i].type == EV_REL && e[i].code == REL_X)
				cxs += e[i].value, cur_on = 1;
			else if (e[i].type == EV_REL && e[i].code == REL_Y)
				cys += e[i].value, cur_on = 1;
			else if (e[i].type == EV_KEY && e[i].value == 1 && e[i].code >= BTN_LEFT && e[i].code <= BTN_MIDDLE)
				click = cur_on = 1;
		}
	cxs = clamp(cxs, 0, LW * S - 1);
	cys = clamp(cys, TOP * S, GROUND * S - 1);
	if (tty_raw) {
		char junk[64];
		while (read(0, junk, sizeof(junk)) > 0)
			;
	}
}

/* Open /dev/fb0 and check it is XRGB8888; the descriptor, or -1. */
static int fb_open(struct fb_var_screeninfo *var, struct fb_fix_screeninfo *fix)
{
	int fd = open("/dev/fb0", O_RDWR | O_CLOEXEC);

	if (fd < 0 && errno == EBUSY) {
		/* kwfb gives the display to one program at a time. */
		fprintf(stderr, "glimmer: /dev/fb0 is busy: another program has the display; quit it first\n");
		return -1;
	}
	if (fd < 0) {
		fprintf(stderr, "glimmer: cannot open /dev/fb0: %s (it needs a display: the page, or the CLI's --display)\n",
			strerror(errno));
		return -1;
	}
	if (ioctl(fd, FBIOGET_VSCREENINFO, var) || ioctl(fd, FBIOGET_FSCREENINFO, fix)) {
		fprintf(stderr, "glimmer: /dev/fb0: %s\n", strerror(errno));
		close(fd);
		return -1;
	}
	if (var->bits_per_pixel != 32 || var->red.offset != 16 || var->green.offset != 8 || var->blue.offset != 0 ||
	    fix->line_length < var->xres * 4 || fix->smem_len < (size_t)fix->line_length * var->yres) {
		fprintf(stderr, "glimmer: /dev/fb0 is %ux%u at %u bpp (rgb %u/%u/%u); it needs XRGB8888\n", var->xres,
			var->yres, var->bits_per_pixel, var->red.offset, var->green.offset, var->blue.offset);
		close(fd);
		return -1;
	}
	return fd;
}

/* GLIMMER_MODE=WxH: 1 and the size if set and valid, 0 if unset, -1 if bad. */
static int pretend_mode(unsigned *w, unsigned *h)
{
	const char *e = getenv("GLIMMER_MODE");
	char *p, *q;

	if (!e || !*e)
		return 0;
	unsigned long a = strtoul(e, &p, 10), b = *p == 'x' ? strtoul(p + 1, &q, 10) : 0;
	if (!b || *q || a < MINW || b < MINH || a > 8192 || b > 8192) {
		fprintf(stderr, "glimmer: GLIMMER_MODE=%s: want WxH, from %ux%u to 8192x8192\n", e, MINW, MINH);
		return -1;
	}
	*w = a, *h = b;
	return 1;
}

/* Map the device, choose the mode (GLIMMER_MODE or the device's) and set
 * the layout. */
static int setup_display(void)
{
	struct fb_var_screeninfo var;
	struct fb_fix_screeninfo fix;
	int fd = fb_open(&var, &fix), p;

	if (fd < 0)
		return -1;
	mode_w = disp_w = var.xres, mode_h = disp_h = var.yres;
	if ((p = pretend_mode(&mode_w, &mode_h)) < 0) {
		close(fd);
		return -1;
	}
	if (mode_w < MINW || mode_h < MINH) {
		fprintf(stderr, "glimmer: the mode %ux%u is too small (at least %ux%u)\n", mode_w, mode_h, MINW, MINH);
		close(fd);
		return -1;
	}
	map_len = fix.smem_len;
	map = mmap(NULL, map_len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	close(fd);
	if (map == MAP_FAILED) {
		map = NULL;
		fprintf(stderr, "glimmer: mmap /dev/fb0: %s\n", strerror(errno));
		return -1;
	}
	memset(map, 0, map_len);
	if (mode_w <= var.xres && mode_h <= var.yres) {
		fb = map;
		fb_stride = fix.line_length / 4;
	} else {
		fb_fake = 1;
		fb_stride = mode_w;
		fb = calloc((size_t)mode_w * mode_h, 4);
	}
	choose_scale(mode_w, mode_h);
	if (!fb || layout()) {
		fprintf(stderr, "glimmer: out of memory\n");
		return -1;
	}
	ox = (mode_w - LW * S) / 2;
	oy = (mode_h - LH * S) / 2;
	if (p)
		printf("glimmer: GLIMMER_MODE %ux%u on the %ux%u display%s\n", mode_w, mode_h, var.xres, var.yres,
		       fb_fake ? ", drawn off screen" : ", at its top left");
	return 0;
}

static int is_keyboard(int fd)
{
	unsigned long ev[BITS(EV_MAX + 1)] = { 0 }, keys[BITS(KEY_MAX + 1)] = { 0 };
	ioctl(fd, EVIOCGBIT(0, sizeof(ev)), ev);
	ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keys)), keys);
	return TEST(EV_KEY, ev) && TEST(KEY_ESC, keys) && TEST(KEY_SPACE, keys);
}

static int is_mouse(int fd)
{
	unsigned long ev[BITS(EV_MAX + 1)] = { 0 }, rel[BITS(REL_MAX + 1)] = { 0 };
	ioctl(fd, EVIOCGBIT(0, sizeof(ev)), ev);
	ioctl(fd, EVIOCGBIT(EV_REL, sizeof(rel)), rel);
	return TEST(EV_REL, ev) && TEST(REL_X, rel);
}

static int is_tablet(int fd)
{
	unsigned long ev[BITS(EV_MAX + 1)] = { 0 }, abs[BITS(ABS_MAX + 1)] = { 0 }, keys[BITS(KEY_MAX + 1)] = { 0 };
	ioctl(fd, EVIOCGBIT(0, sizeof(ev)), ev);
	ioctl(fd, EVIOCGBIT(EV_ABS, sizeof(abs)), abs);
	ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keys)), keys);
	return TEST(EV_ABS, ev) && TEST(ABS_X, abs) && TEST(ABS_Y, abs) && TEST(BTN_LEFT, keys);
}

/* The first evdev device with Esc and Space is the keyboard; the mouse is
 * the first absolute pointer (ABS_X, ABS_Y and BTN_LEFT), or without one
 * the first device with REL_X. The relative mouse is closed again when
 * there is an absolute one: a host locks its pointer for a program that
 * reads only the relative mouse. */
static void open_input(void)
{
	int rfd = -1;

	for (int i = 0; i < 16; i++) {
		char path[32];
		snprintf(path, sizeof(path), "/dev/input/event%d", i);
		int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
		if (fd < 0)
			continue;
		if (kfd < 0 && is_keyboard(fd))
			kfd = fd;
		else if (mfd < 0 && is_tablet(fd) && !ioctl(fd, EVIOCGABS(ABS_X), &abs_x) &&
			 !ioctl(fd, EVIOCGABS(ABS_Y), &abs_y))
			mfd = fd, mabs = 1;
		else if (rfd < 0 && is_mouse(fd))
			rfd = fd;
		else
			close(fd);
	}
	if (mfd < 0)
		mfd = rfd;
	else if (rfd >= 0)
		close(rfd);
}

static void cleanup(void)
{
	if (map) {
		memset(map, 0, map_len);
		munmap(map, map_len);
		map = NULL;
	}
	if (fb_fake)
		free(fb);
	fb = NULL, fb_fake = 0;
	if (kfd >= 0)
		close(kfd);
	if (mfd >= 0)
		close(mfd);
	kfd = mfd = -1, mabs = 0;
	snd_close();
	if (tty_raw) {
		tcflush(0, TCIFLUSH);
		tcsetattr(0, TCSANOW, &tty_saved);
		tty_raw = 0;
	}
}

static void on_signal(int sig)
{
	(void)sig;
	quit = 1;
}

/* ---- the self-test -------------------------------------------------------- */

static uint32_t test_pixel(unsigned x, unsigned y, unsigned w, unsigned h)
{
	static const uint32_t bars[8] = { 0xffffff, 0xffff00, 0x00ffff, 0x00ff00, 0xff00ff, 0xff0000, 0x0000ff, 0x000000 };
	if (x >= w || y >= h)
		return 0;
	if (x == 0 || y == 0 || x == w - 1 || y == h - 1)
		return 0xffffff;
	if (x < 9 && y < 9)
		return 0xff0000;
	if (x >= w - 9 && y < 9)
		return 0x00ff00;
	if (x < 9 && y >= h - 9)
		return 0x0000ff;
	if (x >= w - 9 && y >= h - 9)
		return 0xffff00;
	if (y < h / 4)
		return bars[x * 8 / w];
	if (y < h / 2)
		return x * 255 / (w - 1) * 0x010101u;
	if (y < h * 3 / 4)
		return (x / 8 + y / 8) & 1 ? 0xff8000 : 0x000040;
	unsigned v = y * 255 / (h - 1);
	return v << 8 | (255 - v);
}

static const char *type_name(unsigned t)
{
	static const char *names[] = { "EV_SYN", "EV_KEY", "EV_REL", "EV_ABS", "EV_MSC", "EV_SW" };
	return t < 6 ? names[t] : t == EV_REP ? "EV_REP" : t == EV_LED ? "EV_LED" : "EV_?";
}

/* "keys 3 (272 273 274)" or "keys 255 (1..255)" for a capability set. */
static void print_caps(int fd, const char *what, unsigned type, unsigned max)
{
	unsigned long bits[BITS(KEY_MAX + 1)] = { 0 };
	unsigned n = 0, first = 0, last = 0;
	if (ioctl(fd, EVIOCGBIT(type, sizeof(bits)), bits) < 0)
		return;
	for (unsigned c = 0; c <= max; c++)
		if (TEST(c, bits))
			last = c, first = n++ ? first : c;
	if (!n)
		return;
	printf(", %s %u (", what, n);
	if (n <= 8 || last - first + 1 != n) {
		for (unsigned c = 0, k = 0; c <= max; c++)
			if (TEST(c, bits) && k++ < 16)
				printf("%s%u", k > 1 ? " " : "", c);
	} else {
		printf("%u..%u", first, last);
	}
	printf(")");
}

/* The test signal (see the top of the file): 1 s each of 440 Hz on both
 * channels, 660 Hz on the left only and 880 Hz on the right only. */
#define TSIG_FRAMES (3 * SR)
static unsigned long tsig_frame;

static void test_signal(int16_t *out, int n)
{
	static const int hz[3] = { 440, 660, 880 };
	for (int i = 0; i < n; i++, tsig_frame++) {
		unsigned long f = tsig_frame;
		int seg = (int)(f / SR);
		int16_t v = seg < 3 ? q15(0.5 * sin_turn((long)(hz[seg] * f % SR), SR)) : 0;
		out[2 * i] = seg == 2 ? 0 : v;
		out[2 * i + 1] = seg == 1 ? 0 : v;
	}
}

/* Print the sound card and set up the PCM: 1 if the signal can play, 0 if
 * not (no device: not a failure; *ok = 0 when a step failed). */
static int test_sound_begin(int *ok)
{
	struct snd_ctl_card_info ci = { 0 };
	struct snd_pcm_info pi = { .stream = SNDRV_PCM_STREAM_PLAYBACK };
	struct snd_pcm_hw_params hw;
	const char *what;
	int fd, ver = 0;

	if (no_sound) {
		printf("glimmer: test sound skipped (--no-sound)\n");
		return 0;
	}
	fd = open("/dev/snd/pcmC0D0p", O_WRONLY | O_NONBLOCK | O_CLOEXEC);
	if (fd < 0) {
		int e = errno;
		if (e == ENOENT || e == ENODEV || e == ENXIO) {
			printf("glimmer: test sound: no sound device (/dev/snd/pcmC0D0p: %s)\n", strerror(e));
		} else {
			printf("glimmer: test sound /dev/snd/pcmC0D0p FAILED: %s\n", strerror(e));
			*ok = 0;
		}
		return 0;
	}
	int cfd = open("/dev/snd/controlC0", O_RDONLY | O_CLOEXEC);
	if (cfd >= 0 && !ioctl(cfd, SNDRV_CTL_IOCTL_CARD_INFO, &ci))
		printf("glimmer: test sound card %d: id \"%s\", driver \"%s\", name \"%s\", longname \"%s\"\n", ci.card,
		       ci.id, ci.driver, ci.name, ci.longname);
	if (cfd >= 0 && !ioctl(cfd, SNDRV_CTL_IOCTL_PCM_INFO, &pi))
		printf("glimmer: test sound pcm 0: id \"%s\", name \"%s\", %u subdevice(s)\n", pi.id, pi.name,
		       pi.subdevices_count);
	if (cfd >= 0)
		close(cfd);
	ioctl(fd, SNDRV_PCM_IOCTL_PVERSION, &ver);
	hw_any(&hw);
	if (!ioctl(fd, SNDRV_PCM_IOCTL_HW_REFINE, &hw)) {
		unsigned f = hw_mask(&hw, SNDRV_PCM_HW_PARAM_FORMAT)->bits[0];
		printf("glimmer: test sound protocol %d.%d.%d, formats%s%s, channels %u-%u, rate %u-%u Hz, "
		       "period %u-%u us, buffer up to %u bytes\n",
		       SNDRV_PROTOCOL_MAJOR(ver), SNDRV_PROTOCOL_MINOR(ver), SNDRV_PROTOCOL_MICRO(ver),
		       f & (1u << SNDRV_PCM_FORMAT_U8) ? " U8" : "", f & (1u << SNDRV_PCM_FORMAT_S16_LE) ? " S16_LE" : "",
		       hw_iv(&hw, SNDRV_PCM_HW_PARAM_CHANNELS)->min, hw_iv(&hw, SNDRV_PCM_HW_PARAM_CHANNELS)->max,
		       hw_iv(&hw, SNDRV_PCM_HW_PARAM_RATE)->min, hw_iv(&hw, SNDRV_PCM_HW_PARAM_RATE)->max,
		       hw_iv(&hw, SNDRV_PCM_HW_PARAM_PERIOD_TIME)->min, hw_iv(&hw, SNDRV_PCM_HW_PARAM_PERIOD_TIME)->max,
		       hw_iv(&hw, SNDRV_PCM_HW_PARAM_BUFFER_BYTES)->max);
	}
	close(fd);
	if (snd_open(&what)) {
		printf("glimmer: test sound %s FAILED: %s\n", what, strerror(snd_err));
		*ok = 0;
		return 0;
	}
	printf("glimmer: test sound signal %u Hz, 2 ch, S16_LE, period %u, buffer %u frames: 440 Hz both 1 s, "
	       "660 Hz left 1 s, 880 Hz right 1 s, amplitude 0.5, %u frames\n", SR, SND_PERIOD, snd_buffer, TSIG_FRAMES);
	return 1;
}

/* Feed the signal; at its end, wait for it to play out and close the PCM.
 * Returns 1 while it is still playing. */
static int test_sound_step(int *ok, int64_t t0)
{
	if (snd_fd >= 0 && snd_written < TSIG_FRAMES)
		snd_pump(test_signal, TSIG_FRAMES - (long)snd_written);
	if (snd_fd < 0) {
		printf("glimmer: test sound FAILED after %lu frames: %s\n", snd_written, strerror(snd_err));
		*ok = 0;
		return 0;
	}
	if (snd_written < TSIG_FRAMES)
		return 1;
	fcntl(snd_fd, F_SETFL, 0); /* blocking, for the drain */
	if (ioctl(snd_fd, SNDRV_PCM_IOCTL_DRAIN) < 0 && errno != EPIPE) {
		printf("glimmer: test sound DRAIN FAILED: %s\n", strerror(errno));
		*ok = 0;
	}
	snd_close();
	printf("glimmer: test sound done, %lu frames in %.2f s, %lu underrun(s)\n", snd_written, (now_ns() - t0) / 1e9,
	       snd_xruns);
	return 0;
}

static int run_test(double secs)
{
	struct fb_var_screeninfo var;
	struct fb_fix_screeninfo fix;
	int fd = fb_open(&var, &fix), ok = 1;
	unsigned w, h, stride;

	if (fd < 0)
		return 1;
	printf("glimmer: test fb \"%.16s\" %ux%u, %u bpp, rgb %u/%u/%u, stride %u, smem_len %u\n", fix.id, var.xres,
	       var.yres, var.bits_per_pixel, var.red.offset, var.green.offset, var.blue.offset, fix.line_length,
	       fix.smem_len);
	w = var.xres, h = var.yres;
	int p = pretend_mode(&w, &h);
	if (p < 0 || w > var.xres || h > var.yres) {
		if (p > 0)
			fprintf(stderr, "glimmer: GLIMMER_MODE is larger than the display\n");
		close(fd);
		return 1;
	}
	stride = fix.line_length / 4;
	printf("glimmer: test pattern %ux%u at 0,0\n", w, h);

	/* write() path: the first rows, then read them back */
	unsigned rows = h < 16 ? h : 16;
	size_t band = (size_t)fix.line_length * rows;
	uint32_t *row = calloc(band, 1), *back = calloc(band, 1);
	for (unsigned y = 0; y < rows; y++)
		for (unsigned x = 0; x < stride; x++)
			row[y * stride + x] = test_pixel(x, y, w, h);
	if (pwrite(fd, row, band, 0) != (ssize_t)band || pread(fd, back, band, 0) != (ssize_t)band ||
	    memcmp(row, back, band)) {
		printf("glimmer: test pwrite/pread of rows 0..%u FAILED: %s\n", rows - 1, strerror(errno));
		ok = 0;
	} else {
		printf("glimmer: test pwrite/pread of rows 0..%u ok\n", rows - 1);
	}

	/* mmap path: check the band shows, then draw everything below */
	map_len = fix.smem_len;
	map = mmap(NULL, map_len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	close(fd);
	if (map == MAP_FAILED) {
		map = NULL;
		printf("glimmer: test mmap FAILED: %s\n", strerror(errno));
		return 1;
	}
	if (memcmp(map, row, band)) {
		printf("glimmer: test the mapping does not show the written rows: FAILED\n");
		ok = 0;
	}
	for (unsigned y = rows; y < var.yres; y++)
		for (unsigned x = 0; x < stride; x++)
			map[(size_t)y * stride + x] = test_pixel(x, y, w, h);
	printf("glimmer: test mmap %s, pattern drawn\n", ok ? "ok" : "done");
	free(row);
	free(back);

	/* every input device, and its events */
	struct pollfd pfd[16];
	char names[16][12];
	int n = 0;
	for (int i = 0; i < 16; i++) {
		char path[32], name[64] = "?";
		struct input_id id = { 0 };
		unsigned long ev[BITS(EV_MAX + 1)] = { 0 };
		snprintf(path, sizeof(path), "/dev/input/event%d", i);
		int efd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
		if (efd < 0)
			continue;
		ioctl(efd, EVIOCGNAME(sizeof(name)), name);
		ioctl(efd, EVIOCGID, &id);
		ioctl(efd, EVIOCGBIT(0, sizeof(ev)), ev);
		printf("glimmer: test input event%d \"%s\" bus 0x%x vendor 0x%x product 0x%x version %u, types", i, name,
		       id.bustype, id.vendor, id.product, id.version);
		for (unsigned t = 0; t <= EV_MAX; t++)
			if (TEST(t, ev))
				printf(" %s", type_name(t));
		print_caps(efd, "keys", EV_KEY, KEY_MAX);
		print_caps(efd, "rel", EV_REL, REL_MAX);
		print_caps(efd, "abs", EV_ABS, ABS_MAX);
		for (unsigned a = ABS_X; a <= ABS_Y; a++) {
			struct input_absinfo ai;
			if (TEST(EV_ABS, ev) && !ioctl(efd, EVIOCGABS(a), &ai) && ai.maximum > ai.minimum)
				printf(", abs%u %d..%d", a, ai.minimum, ai.maximum);
		}
		printf("\n");
		snprintf(names[n], sizeof(names[n]), "event%d", i);
		pfd[n].fd = efd;
		pfd[n].events = POLLIN;
		n++;
	}
	if (!n)
		printf("glimmer: test no /dev/input/event* devices\n");
	int playing = test_sound_begin(&ok);
	printf("glimmer: test ready, holding for %.1f s\n", secs);
	fflush(stdout);

	unsigned count = 0;
	int64_t t0 = now_ns(), end = t0 + (int64_t)(secs * 1e9);
	for (int64_t left; !quit && (left = end - now_ns()) > 0;) {
		if (playing) {
			playing = test_sound_step(&ok, t0);
			fflush(stdout);
		}
		if (playing && left > 10000000)
			left = 10000000; /* top the sound up every 10 ms */
		if (poll(pfd, n, (int)(left / 1000000) + 1) <= 0)
			continue;
		for (int d = 0; d < n; d++) {
			struct input_event e[64];
			ssize_t r;
			if (!(pfd[d].revents & POLLIN))
				continue;
			while ((r = read(pfd[d].fd, e, sizeof(e))) > 0)
				for (size_t k = 0; k < (size_t)r / sizeof(e[0]); k++, count++)
					printf("glimmer: event %s %s %u %d\n", names[d], type_name(e[k].type), e[k].code,
					       e[k].value);
		}
		fflush(stdout);
	}
	while (playing && !quit) { /* a hold shorter than the signal */
		struct timespec ts = { 0, 10000000 };
		nanosleep(&ts, NULL);
		playing = test_sound_step(&ok, t0);
	}
	for (int d = 0; d < n; d++)
		close(pfd[d].fd);
	cleanup();
	printf("glimmer: test done, %u events%s\n", count, ok ? "" : ", FAILED");
	return ok ? 0 : 1;
}

/* ---- main ----------------------------------------------------------------- */

int main(int argc, char **argv)
{
	struct sigaction sa = { .sa_handler = on_signal };

	sigaction(SIGINT, &sa, NULL);
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGHUP, &sa, NULL);
	signal(SIGTSTP, SIG_IGN);
	double test = -1;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--test")) {
			test = i + 1 < argc && argv[i + 1][0] != '-' ? atof(argv[++i]) : 10;
		} else if (!strcmp(argv[i], "--no-sound")) {
			no_sound = 1;
		} else {
			printf("usage: glimmer [--no-sound]             play Glimmer Meadow (on /dev/fb0, the evdev keyboard\n"
			       "                                        and mouse, and the ALSA PCM hw:0,0 if there is one)\n"
			       "       glimmer --test [s] [--no-sound]  draw a check pattern, play a test signal and print\n"
			       "                                        input events for s seconds (10)\n"
			       "GLIMMER_MODE=WxH uses a WxH mode instead of the display's.\n");
			return strcmp(argv[i], "-h") && strcmp(argv[i], "--help") ? 2 : 0;
		}
	}
	if (test >= 0)
		return run_test(test);

	open_input();
	if (kfd < 0) {
		fprintf(stderr, "glimmer: no evdev keyboard in /dev/input (it needs a display: the page, or the CLI's --display)\n");
		cleanup();
		return 1;
	}
	if (setup_display()) {
		cleanup();
		return 1;
	}
	atexit(cleanup);
	if (isatty(0) && !tcgetattr(0, &tty_saved)) {
		struct termios t = tty_saved;
		t.c_lflag &= ~(ICANON | ECHO);
		t.c_cc[VMIN] = 0;
		t.c_cc[VTIME] = 0;
		tty_raw = !tcsetattr(0, TCSANOW, &t);
	}

	const char *what = "";
	char sound[96];
	if (!no_sound && snd_open(&what) && snd_err != ENOENT)
		snprintf(sound, sizeof(sound), " (No sound: %s: %s.)", what, strerror(snd_err));
	else
		snprintf(sound, sizeof(sound), "%s", snd_fd >= 0 ? " M or Tab mutes the sound." : no_sound ? "" : " (No sound device.)");
	int had_sound = snd_fd >= 0;
	printf("glimmer: Glimmer Meadow, %ux%u (%dx%d x%d). Arrows/WASD float, Space/Ctrl bloom, the mouse"
	       " pulls stars and a click blooms, Enter starts, Esc pauses (twice quits).%s%s\n",
	       mode_w, mode_h, LW, LH, S, sound, mfd < 0 ? " (No mouse found.)" : "");
	fflush(stdout);

	rs = (uint32_t)now_ns() | 1;
	make_base();
	set_state(TITLE);

	int64_t start = now_ns(), last = start, acc = 0, fps_t0 = start;
	int frames = 0, total = 0;
	while (!quit) {
		read_input();
		int64_t t = now_ns();
		acc += t - last;
		if (acc > 6 * TICK_NS)
			acc = 6 * TICK_NS; /* after a stall, catch up at most 6 ticks */
		last = t;
		int ticks = 0;
		for (; acc >= TICK_NS && !quit; acc -= TICK_NS, ticks++)
			update();
		if (ticks && !quit) {
			render();
			frames++, total++;
		}
		snd_pump(mix, SND_FILL);
		if (t - fps_t0 >= 1000000000) {
			fps = (int)((frames * 1000000000LL + (t - fps_t0) / 2) / (t - fps_t0));
			frames = 0;
			fps_t0 = t;
		}
		int64_t wait = TICK_NS - acc;
		struct timespec ts = { 0, (long)(wait > 1000000 ? wait : 1000000) };
		nanosleep(&ts, NULL);
	}
	int64_t ran = now_ns() - start;
	cleanup();
	best = imax(best, score);
	printf("glimmer: final score %d (best %d, %d game%s), %d frames in %.1f s, %d fps average",
	       score, best, games, games == 1 ? "" : "s", total, ran / 1e9,
	       (int)(total * 1000000000LL / (ran ? ran : 1)));
	if (had_sound)
		printf(", sound %lu frames, %lu underrun(s)", snd_written, snd_xruns);
	printf("\n");
	return 0;
}
