// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kwtty: terminal sessions over AF_VSOCK (static aarch64 musl),
 * /usr/bin/kwtty in the Alpine initramfs, started by inittab as
 * "::respawn:/usr/bin/kwtty serve". The host side is js/core/tty.ts.
 *
 *   kwtty serve [PORT]   serve the host (CID 2) on PORT (default 1022, so
 *                        only root can bind it); without a vsock device
 *                        (no kwvsock) it sleeps forever, so respawn does
 *                        not loop
 *
 * Each connection is one session: its own pty with its own size, and root's
 * login shell on it, or the program OPEN names (no authentication: only the
 * host can connect). With the PIPES option there is no pty: the program's
 * stdin, stdout and stderr are pipes, and it runs in a session of its own.
 * With the CONNECT option there is no program: kwtty connects to a TCP
 * port on 127.0.0.1 and, after OPENED, relays raw bytes both ways.
 * Frames,
 * both directions: u8 type, u8 flags (bit 0 critical: a receiver that does
 * not know the type sends ERROR and closes; unknown other types are
 * skipped), u16 payload length, payload. Integers are little-endian.
 *
 *   host -> guest  1 OPEN    u16 max_version (1), rows, cols, xpixel,
 *                            ypixel, then options to the end: u8 tag (bit 7
 *                            critical), u16 length, value; tag 1 TERM
 *                            (default xterm-256color), 2 ENV (one KEY=VALUE,
 *                            repeatable, over the defaults), 3 ARG (one
 *                            argument, repeatable: the first is the program,
 *                            looked up in PATH; none: root's login shell),
 *                            4 CWD (default root's home), 5 PIPES (empty:
 *                            pipes instead of a pty; the size is ignored,
 *                            and TERM is set only when given), 6 CONNECT
 *                            (u16 TCP port: connect to 127.0.0.1:port
 *                            before OPENED; the other options are ignored)
 *                  2 DATA    bytes for the pty, or stdin (zero length: no-op)
 *                  3 RESIZE  u16 rows, cols, xpixel, ypixel (pty only)
 *                  6 SIGNAL  a signal name without "SIG" ("INT", "TERM"),
 *                            sent to the program; unknown names are ignored
 *                  7 EOF     with PIPES: close the program's stdin; ignored
 *                            on a pty
 *   guest -> host  1 OPENED  u16 version, u32 features (bit 0: PIPES, EOF
 *                            and STDERR; bit 1: CONNECT), u32 program pid
 *                            (0 with CONNECT), u32 pts number (0xffffffff
 *                            with PIPES or CONNECT)
 *                  2 DATA    bytes from the pty, or stdout
 *                  4 EXIT    u8 how (0 exited, 1 signal), u8 exit status or
 *                            signal number, u8 core dumped
 *                  5 ERROR   a message; the guest closes after it
 *                  8 STDERR  with PIPES: bytes from stderr
 *
 * OPEN comes first, once, within 10 s. The guest closes the connection
 * right after EXIT, once the pty (or both pipes) has no more output. When
 * the host closes the connection, the session is hung up (SIGHUP; with
 * PIPES to the program's process group).
 *
 * CONNECT: a failed connect is an ERROR whose message starts with the errno
 * name (EOTHER for one without a name here) and ": " ("ECONNREFUSED:
 * connect to 127.0.0.1:80: Connection refused"). After OPENED there are no more frames either way: the
 * connection is a raw byte stream to the TCP socket. EOF on one side is a
 * shutdown(SHUT_WR) on the other, so half-closes pass through; the relay
 * ends once both directions are done, or at the first error or reset
 * (then both sockets are closed).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <linux/vm_sockets.h>

/* The default port; js/core/tty.ts has it as TTY_PORT. */
#define KWTTY_PORT	1022
#define KWTTY_VERSION	1

/* Frame types: host -> guest, then guest -> host (DATA is 2 both ways). */
#define T_OPEN		1
#define T_DATA		2
#define T_RESIZE	3
#define T_SIGNAL	6
#define T_EOF		7
#define T_OPENED	1
#define T_EXIT		4
#define T_ERROR		5
#define T_STDERR	8
#define F_CRITICAL	0x01
#define TAG_TERM	1
#define TAG_ENV		2
#define TAG_ARG		3
#define TAG_CWD		4
#define TAG_PIPES	5
#define TAG_CONNECT	6
#define TAG_CRITICAL	0x80
#define FEAT_PIPES	0x01		/* OPENED: PIPES, EOF and STDERR */
#define FEAT_CONNECT	0x02		/* OPENED: CONNECT */
#define NO_PTS		0xffffffffU

#define HDR		4
#define OUT_MAX		16384		/* pty output per DATA frame */
#define OPEN_MS		10000		/* time the host has for OPEN */
#define DRAIN_MS	50		/* output after the shell exited */
#define DRAIN_MAX	(1 << 20)	/* and at most this much of it */
#define HANGUP_MS	1000		/* wait for the shell after a hangup */
#define CONNECT_MS	10000		/* CONNECT: time for the TCP connect */
#define RELAY_BUF	65536		/* CONNECT: bytes in flight per direction */
#define PROBE_MS	1000		/* CONNECT: how often to check an idle host side */

static unsigned int get16(const unsigned char *p)
{
	return p[0] | p[1] << 8;
}

static void put16(unsigned char *p, unsigned int v)
{
	p[0] = v;
	p[1] = v >> 8;
}

static void put32(unsigned char *p, uint32_t v)
{
	put16(p, v);
	put16(p + 2, v >> 16);
}

static int64_t now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1000LL + t.tv_nsec / 1000000;
}

static void __attribute__((noreturn)) idle(void)
{
	for (;;)
		pause();
}

/* Before OPENED: blocking I/O on the non-blocking socket, with a deadline. */
static int send_all(int s, const unsigned char *p, size_t len, int64_t end)
{
	while (len) {
		struct pollfd pf = { .fd = s, .events = POLLOUT };
		ssize_t n = send(s, p, len, MSG_NOSIGNAL);
		int64_t left;

		if (n > 0) {
			p += n;
			len -= n;
			continue;
		}
		if (errno != EAGAIN && errno != EINTR)
			return -1;
		left = end - now_ms();
		if (left <= 0 || (poll(&pf, 1, left) < 0 && errno != EINTR))
			return -1;
	}
	return 0;
}

static int recv_all(int s, unsigned char *p, size_t len, int64_t end)
{
	while (len) {
		struct pollfd pf = { .fd = s, .events = POLLIN };
		ssize_t n = recv(s, p, len, 0);
		int64_t left;

		if (n > 0) {
			p += n;
			len -= n;
			continue;
		}
		if (n == 0 || (errno != EAGAIN && errno != EINTR))
			return -1;
		left = end - now_ms();
		if (left <= 0) {
			errno = ETIMEDOUT;
			return -1;
		}
		if (poll(&pf, 1, left) < 0 && errno != EINTR)
			return -1;
	}
	return 0;
}

/* ERROR before OPENED, then close. */
static void __attribute__((noreturn, format(printf, 2, 3)))
refuse(int s, const char *fmt, ...)
{
	unsigned char f[HDR + 256];
	va_list ap;
	int n;

	va_start(ap, fmt);
	n = vsnprintf((char *)f + HDR, sizeof(f) - HDR, fmt, ap);
	va_end(ap);
	if (n < 0)
		n = 0;
	if (n > (int)(sizeof(f) - HDR - 1))
		n = sizeof(f) - HDR - 1;
	f[0] = T_ERROR;
	f[1] = 0;
	put16(f + 2, n);
	send_all(s, f, HDR + n, now_ms() + 2000);
	close(s);
	_exit(0);
}

struct open_req {
	struct winsize ws;
	char term[65];
	char **env;			/* ENV options, in order */
	int nenv;
	char **argv;			/* ARG options, NULL-terminated; none: a login shell */
	int nargv;
	char *cwd;
	int pipes;			/* PIPES: no pty */
	int has_term;			/* TERM was given */
	int connect;			/* CONNECT: relay to a TCP port */
	unsigned int port;		/* its port */
};

/* Parses OPEN's payload; NULL, or what is wrong with it. */
static const char *parse_open(const unsigned char *p, size_t len, struct open_req *o)
{
	size_t off;

	if (len < 10)
		return "OPEN is too short";
	if (get16(p) < 1)
		return "unsupported version (max_version 0)";
	o->ws.ws_row = get16(p + 2);
	o->ws.ws_col = get16(p + 4);
	o->ws.ws_xpixel = get16(p + 6);
	o->ws.ws_ypixel = get16(p + 8);
	strcpy(o->term, "xterm-256color");
	o->env = calloc(len / 3 + 1, sizeof(*o->env));
	o->argv = calloc(len / 3 + 1, sizeof(*o->argv));
	if (!o->env || !o->argv)
		return "out of memory";
	for (off = 10; off < len;) {
		const unsigned char *v, *eq;
		unsigned int tag;
		size_t vlen;

		if (len - off < 3)
			return "truncated OPEN option";
		tag = p[off];
		vlen = get16(p + off + 1);
		off += 3;
		if (vlen > len - off)
			return "truncated OPEN option";
		v = p + off;
		off += vlen;
		switch (tag & ~TAG_CRITICAL) {
		case TAG_TERM:
			if (vlen > 64)
				return "TERM is longer than 64 bytes";
			for (size_t i = 0; i < vlen; i++)
				if (v[i] < 0x20 || v[i] > 0x7e)
					return "TERM is not printable ASCII";
			memcpy(o->term, v, vlen);
			o->term[vlen] = 0;
			o->has_term = 1;
			break;
		case TAG_ENV:
			eq = memchr(v, '=', vlen);
			if (!eq || eq == v || memchr(v, 0, vlen))
				return "ENV is not KEY=VALUE";
			o->env[o->nenv] = strndup((const char *)v, vlen);
			if (!o->env[o->nenv++])
				return "out of memory";
			break;
		case TAG_ARG:
			if (memchr(v, 0, vlen) || (!o->nargv && !vlen))
				return "ARG has a NUL, or the program is empty";
			o->argv[o->nargv] = strndup((const char *)v, vlen);
			if (!o->argv[o->nargv++])
				return "out of memory";
			break;
		case TAG_CWD:
			if (!vlen || memchr(v, 0, vlen))
				return "CWD is empty or has a NUL";
			free(o->cwd);
			o->cwd = strndup((const char *)v, vlen);
			if (!o->cwd)
				return "out of memory";
			break;
		case TAG_PIPES:
			o->pipes = 1;
			break;
		case TAG_CONNECT:
			if (vlen != 2 || !get16(v))
				return "CONNECT is not a u16 port from 1";
			o->connect = 1;
			o->port = get16(v);
			break;
		default:
			if (tag & TAG_CRITICAL)
				return "unknown critical OPEN option";
		}
	}
	return NULL;
}

/* Adds KEY=VALUE to env, replacing an earlier KEY. */
static void env_set(char **env, int *n, char *kv)
{
	size_t k = strchr(kv, '=') - kv + 1;

	for (int i = 0; i < *n; i++) {
		if (!strncmp(env[i], kv, k)) {
			env[i] = kv;
			return;
		}
	}
	env[(*n)++] = kv;
}

/* The program, in the child: the pty or the pipes are its stdio already. */
static void __attribute__((noreturn))
shell_child(int ep, const char *file, char **argv, char **env)
{
	struct sigaction sa = { .sa_handler = SIG_DFL };
	struct termios t;
	sigset_t none;
	int e;

	for (int i = 1; i < _NSIG; i++)
		sigaction(i, &sa, NULL);
	sigemptyset(&none);
	sigprocmask(SIG_SETMASK, &none, NULL);
	if (!tcgetattr(0, &t)) {
		t.c_iflag |= IUTF8;
		tcsetattr(0, TCSANOW, &t);
	}
	/* Only 0-2 stay, and the error pipe (close-on-exec) as 3. */
	if (ep != 3 && dup3(ep, 3, O_CLOEXEC) == 3)
		ep = 3;
	if (ep == 3)
		syscall(SYS_close_range, 4, ~0U, 0);
	/* execvp looks file up in the PATH of the environment it gets. */
	environ = env;
	execvp(file, argv);
	e = errno;
	write(ep, &e, sizeof(e));
	_exit(127);
}

struct session {
	int s, m, pfd;			/* socket, pty master (-1 with PIPES), pidfd of the program */
	int ifd;			/* the program's input: the master or the stdin pipe; -1 once closed */
	int ofd[2];			/* its output: the master or the stdout pipe, and the stderr pipe (-1 on a pty) */
	int oend[2];			/* that output has ended (EIO on the master, EOF on a pipe) */
	int in_dead;			/* writes to `in` fail (nobody has the pty open, or EPIPE): discard input */
	int pipes, next;		/* PIPES; which output to read first */
	pid_t pid;
	int status, reaped, final;
	int64_t quiet_at;		/* since when output is drained */
	size_t drained;			/* output bytes since the shell exited */
	char err[200];			/* a protocol error, sent as ERROR */
	unsigned char out[HDR + OUT_MAX];	/* the frame being sent */
	size_t olen, ooff;
	unsigned char in[16384];	/* socket bytes not yet parsed */
	size_t ilen, ioff;
	enum { ST_HDR, ST_DATA, ST_ARG, ST_SKIP } st;
	unsigned char hdr[HDR], arg[16];	/* RESIZE's or SIGNAL's payload */
	size_t have, want, rem;		/* bytes in hdr or arg, of arg wanted, payload left */
};

static struct session x;

/*
 * Close the program's side: closing the master hangs up the pty's session
 * (SIGHUP); pipes do not, so their process group gets SIGHUP instead.
 */
static void hangup(void)
{
	if (x.m >= 0)
		close(x.m);
	if (x.pipes) {
		if (x.ifd >= 0)
			close(x.ifd);
		for (int i = 0; i < 2; i++)
			if (x.ofd[i] >= 0)
				close(x.ofd[i]);
		if (!x.reaped)
			kill(-x.pid, SIGHUP);
	}
	x.m = x.ifd = x.ofd[0] = x.ofd[1] = -1;
}

/*
 * Hangup or end: drop what is not sent, hang up the program, close the
 * socket, give the program a moment, and exit; init reaps what is left.
 */
static void __attribute__((noreturn)) end_session(void)
{
	hangup();
	close(x.s);
	if (!x.reaped) {
		struct pollfd pf = { .fd = x.pfd, .events = POLLIN };

		if (poll(&pf, 1, HANGUP_MS) > 0)
			waitpid(x.pid, NULL, WNOHANG);
	}
	_exit(0);
}

static void flush_out(void)
{
	while (x.ooff < x.olen) {
		ssize_t n = send(x.s, x.out + x.ooff, x.olen - x.ooff, MSG_NOSIGNAL);

		if (n < 0) {
			if (errno == EAGAIN || errno == EINTR)
				return;
			end_session();	/* EPIPE, ECONNRESET: the host hung up */
		}
		x.ooff += n;
	}
	x.olen = x.ooff = 0;
	x.quiet_at = now_ms();
}

static void queue(unsigned int type, const void *p, size_t len)
{
	x.out[0] = type;
	x.out[1] = 0;
	put16(x.out + 2, len);
	memmove(x.out + HDR, p, len);	/* p may be x.out + HDR */
	x.olen = HDR + len;
	x.ooff = 0;
	flush_out();
}

/* A protocol error: hang up the program now, send ERROR after the frame in flight. */
static void __attribute__((format(printf, 1, 2))) protocol_error(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(x.err, sizeof(x.err), fmt, ap);
	va_end(ap);
	hangup();
	x.ilen = x.ioff = 0;
}

static const struct { const char *name; int sig; } signals[] = {
	{ "HUP", SIGHUP }, { "INT", SIGINT }, { "QUIT", SIGQUIT }, { "ILL", SIGILL },
	{ "TRAP", SIGTRAP }, { "ABRT", SIGABRT }, { "BUS", SIGBUS }, { "FPE", SIGFPE },
	{ "KILL", SIGKILL }, { "USR1", SIGUSR1 }, { "SEGV", SIGSEGV }, { "USR2", SIGUSR2 },
	{ "PIPE", SIGPIPE }, { "ALRM", SIGALRM }, { "TERM", SIGTERM }, { "CHLD", SIGCHLD },
	{ "CONT", SIGCONT }, { "STOP", SIGSTOP }, { "TSTP", SIGTSTP }, { "TTIN", SIGTTIN },
	{ "TTOU", SIGTTOU }, { "URG", SIGURG }, { "XCPU", SIGXCPU }, { "XFSZ", SIGXFSZ },
	{ "VTALRM", SIGVTALRM }, { "PROF", SIGPROF }, { "WINCH", SIGWINCH }, { "IO", SIGIO },
	{ "PWR", SIGPWR }, { "SYS", SIGSYS },
};

/* SIGNAL: by name, to the program (until it is reaped); unknown names are ignored. */
static void do_signal(const unsigned char *name, size_t len)
{
	for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
		if (strlen(signals[i].name) == len && !memcmp(signals[i].name, name, len)) {
			if (!x.reaped)
				kill(x.pid, signals[i].sig);
			return;
		}
	}
}

/* Feeds socket bytes through the frame parser; stops where the master is full. */
static void parse_input(void)
{
	while (x.ioff < x.ilen && !x.err[0]) {
		const unsigned char *p = x.in + x.ioff;
		size_t avail = x.ilen - x.ioff, n;
		ssize_t w;

		switch (x.st) {
		case ST_HDR:
			n = HDR - x.have < avail ? HDR - x.have : avail;
			memcpy(x.hdr + x.have, p, n);
			x.have += n;
			x.ioff += n;
			if (x.have < HDR)
				break;
			x.have = 0;
			x.rem = get16(x.hdr + 2);
			if (x.hdr[0] == T_DATA) {
				x.st = ST_DATA;
			} else if (x.hdr[0] == T_RESIZE) {
				if (x.rem < 8) {
					protocol_error("RESIZE is too short");
					return;
				}
				x.want = 8;
				x.st = ST_ARG;
			} else if (x.hdr[0] == T_SIGNAL) {
				x.want = x.rem < sizeof(x.arg) ? x.rem : sizeof(x.arg);
				x.st = ST_ARG;
			} else if (x.hdr[0] == T_EOF) {
				/* In order behind the DATA before it, which is written by now. */
				if (x.pipes && x.ifd >= 0) {
					close(x.ifd);
					x.ifd = -1;
				}
				x.st = ST_SKIP;
			} else if (x.hdr[0] == T_OPEN) {
				protocol_error("OPEN after OPEN");
				return;
			} else if (x.hdr[1] & F_CRITICAL) {
				protocol_error("unknown critical frame type %u", x.hdr[0]);
				return;
			} else {
				x.st = ST_SKIP;
			}
			break;
		case ST_DATA:
			n = x.rem < avail ? x.rem : avail;
			w = n;
			if (x.ifd >= 0 && !x.in_dead) {
				w = write(x.ifd, p, n);
				if (w < 0 && (errno == EAGAIN || errno == EINTR))
					return;
				if (w < 0) {
					/* EIO: nobody has the pty open; EPIPE: nobody reads stdin */
					if (errno == EPIPE)
						x.in_dead = 1;
					w = n;
				}
			}
			x.ioff += w;
			x.rem -= w;
			if ((size_t)w < n)
				return;
			break;
		case ST_ARG:
			n = x.want - x.have < avail ? x.want - x.have : avail;
			memcpy(x.arg + x.have, p, n);
			x.have += n;
			x.ioff += n;
			x.rem -= n;
			if (x.have < x.want)
				break;
			x.have = 0;
			if (x.hdr[0] == T_SIGNAL)
				do_signal(x.arg, x.want);
			else if (x.m >= 0) {
				struct winsize ws = {
					.ws_row = get16(x.arg), .ws_col = get16(x.arg + 2),
					.ws_xpixel = get16(x.arg + 4), .ws_ypixel = get16(x.arg + 6),
				};

				ioctl(x.m, TIOCSWINSZ, &ws);
			}
			x.st = ST_SKIP;
			break;
		case ST_SKIP:
			n = x.rem < avail ? x.rem : avail;
			x.ioff += n;
			x.rem -= n;
			break;
		}
		if ((x.st == ST_DATA || x.st == ST_SKIP) && !x.rem)
			x.st = ST_HDR;
	}
	if (x.ioff == x.ilen)
		x.ilen = x.ioff = 0;
}

static void __attribute__((noreturn)) session_loop(void)
{
	for (;;) {
		/* socket, the two outputs, the input, the pidfd */
		struct pollfd p[5] = { { .fd = x.s }, { .fd = -1 }, { .fd = -1 }, { .fd = -1 }, { .fd = -1 } };
		int open[2], rd[2];
		int mwrite = x.ifd >= 0 && !x.in_dead && x.ioff < x.ilen;
		int sread = !x.err[0] && x.ioff == x.ilen;
		int timeout = -1;

		for (int i = 0; i < 2; i++) {
			open[i] = x.ofd[i] >= 0 && !x.oend[i];
			rd[i] = open[i] && !x.olen && !x.final;
		}

		if (x.final && !x.olen)
			end_session();
		if (x.err[0] && !x.olen) {
			queue(T_ERROR, x.err, strlen(x.err));
			x.final = 1;
			continue;
		}
		/*
		 * The program has exited: the output ends with EIO once
		 * nothing has the pty open (EOF on both pipes), or, while
		 * background jobs keep it open, after DRAIN_MS without output
		 * (EAGAIN right after the exit is not the end: the flip buffer
		 * may still be in flight), or after DRAIN_MAX bytes: what the
		 * program's own children left behind is far less, and a
		 * background job that keeps printing (yes & exit) must not
		 * keep the session open.
		 */
		if (x.reaped && !x.final && !x.olen) {
			int64_t left = x.quiet_at + DRAIN_MS - now_ms();

			if (!(open[0] || open[1]) || left <= 0 || x.drained > DRAIN_MAX) {
				unsigned char e[3] = { 0, WEXITSTATUS(x.status), 0 };

				if (WIFSIGNALED(x.status)) {
					e[0] = 1;
					e[1] = WTERMSIG(x.status);
					e[2] = !!WCOREDUMP(x.status);
				}
				queue(T_EXIT, e, sizeof(e));
				x.final = 1;
				continue;
			}
			timeout = left;
		}
		/*
		 * The host's close is a SHUTDOWN, which vsock_poll() reports as
		 * POLLRDHUP (with POLLIN), not POLLHUP: ask for it always, so a
		 * hangup is seen while socket reads are paused.
		 */
		p[0].events = POLLRDHUP | (sread ? POLLIN : 0) | (x.olen ? POLLOUT : 0);
		/*
		 * A master or pipe with nothing asked would spin on POLLHUP:
		 * leave it out then. On a pty the master is in twice, once per
		 * direction.
		 */
		for (int i = 0; i < 2; i++) {
			if (rd[i]) {
				p[1 + i].fd = x.ofd[i];
				p[1 + i].events = POLLIN;
			}
		}
		if (mwrite) {
			p[3].fd = x.ifd;
			p[3].events = POLLOUT;
		}
		if (!x.reaped) {
			p[4].fd = x.pfd;
			p[4].events = POLLIN;
		}
		if (poll(p, 5, timeout) < 0) {
			if (errno == EINTR)
				continue;
			end_session();
		}
		if (p[0].revents & (POLLHUP | POLLERR) || (p[0].revents & POLLRDHUP && !sread))
			end_session();
		if (p[4].revents) {
			pid_t r = waitpid(x.pid, &x.status, WNOHANG);

			if (r == x.pid || (r < 0 && errno == ECHILD)) {
				x.reaped = 1;
				x.quiet_at = now_ms();
				close(x.pfd);
			}
		}
		/* One output per frame; take turns, so neither starves the other. */
		for (int k = 0; k < 2; k++) {
			int i = (x.next + k) & 1;
			ssize_t n;

			if (!rd[i] || x.olen || !(p[1 + i].revents & (POLLIN | POLLHUP | POLLERR)))
				continue;
			n = read(x.ofd[i], x.out + HDR, OUT_MAX);
			if (n > 0) {
				if (x.reaped)
					x.drained += n;
				x.next = i ^ 1;
				queue(i ? T_STDERR : T_DATA, x.out + HDR, n);
			} else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
				/* EIO: the pty's slave side is closed; 0: EOF on the pipe */
				x.oend[i] = 1;
				if (!x.pipes)
					x.in_dead = 1;
			}
		}
		if (p[3].revents & (POLLOUT | POLLHUP | POLLERR) && mwrite)
			parse_input();
		if (p[0].revents & POLLOUT)
			flush_out();
		if (p[0].revents & (POLLIN | POLLRDHUP) && sread) {
			ssize_t n = recv(x.s, x.in, sizeof(x.in), 0);

			if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR))
				end_session();	/* EOF or ECONNRESET: the host hung up */
			if (n > 0) {
				x.ilen = n;
				x.ioff = 0;
				parse_input();
			}
		}
	}
}

static const char *errname(int e)
{
	switch (e) {
	case ECONNREFUSED: return "ECONNREFUSED";
	case ETIMEDOUT: return "ETIMEDOUT";
	case ECONNRESET: return "ECONNRESET";
	case ENETUNREACH: return "ENETUNREACH";
	case EHOSTUNREACH: return "EHOSTUNREACH";
	case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
	case EAFNOSUPPORT: return "EAFNOSUPPORT";
	case EACCES: return "EACCES";
	case EPERM: return "EPERM";
	case EMFILE: return "EMFILE";
	case ENFILE: return "ENFILE";
	case ENOBUFS: return "ENOBUFS";
	case ENOMEM: return "ENOMEM";
	default: return "EOTHER";
	}
}

/* CONNECT: a non-blocking TCP socket connected to 127.0.0.1:port, or ERROR. */
static int tcp_connect(int s, unsigned int port)
{
	struct sockaddr_in a = {
		.sin_family = AF_INET, .sin_port = htons(port),
		.sin_addr.s_addr = htonl(INADDR_LOOPBACK),
	};
	int64_t end = now_ms() + CONNECT_MS;
	int t, one = 1, e = 0;
	socklen_t elen = sizeof(e);

	t = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (t < 0)
		refuse(s, "%s: socket: %s", errname(errno), strerror(errno));
	setsockopt(t, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
	if (connect(t, (struct sockaddr *)&a, sizeof(a))) {
		if (errno != EINPROGRESS && errno != EINTR) {
			e = errno;
		} else {
			for (;;) {
				struct pollfd pf = { .fd = t, .events = POLLOUT };
				int64_t left = end - now_ms();
				int r;

				if (left <= 0) {
					e = ETIMEDOUT;
					break;
				}
				r = poll(&pf, 1, left);
				if (r < 0 && errno != EINTR) {
					e = errno;
					break;
				}
				if (r > 0) {
					if (getsockopt(t, SOL_SOCKET, SO_ERROR, &e, &elen))
						e = errno;
					break;
				}
			}
		}
	}
	if (e)
		refuse(s, "%s: connect to 127.0.0.1:%u: %s", errname(e), port, strerror(e));
	return t;
}

/* One direction of the relay: bytes read from one socket, not yet written to the other. */
struct pipe_dir {
	int from, to;
	int eof;			/* `from` reached EOF */
	int shut;			/* and `to` was shut down for writing after the last byte */
	size_t len, off;
	unsigned char buf[RELAY_BUF];
};

static struct pipe_dir dirs[2];

/*
 * CONNECT after OPENED: splice the vsock socket and the TCP socket, both
 * non-blocking, until both directions have ended (EOF read and passed on
 * as shutdown(SHUT_WR) once the bytes before it are written). An error or
 * a reset on either side ends both.
 */
static void __attribute__((noreturn)) relay(int s, int t)
{
	int hup[2] = { 0, 0 };

	dirs[0].from = dirs[1].to = s;
	dirs[0].to = dirs[1].from = t;
	for (;;) {
		struct pollfd p[2] = { { .fd = s }, { .fd = t } };
		int probe, r;

		for (int i = 0; i < 2; i++) {
			struct pipe_dir *d = &dirs[i];

			if (d->eof && !d->len && !d->shut) {
				shutdown(d->to, SHUT_WR);	/* ENOTCONN: gone already, as good */
				d->shut = 1;
			}
		}
		if (dirs[0].shut && dirs[1].shut)
			break;
		/*
		 * Each socket is polled while it is not finished (EOF read
		 * from it and shut down for writing), with no events when
		 * nothing is asked of it, so that POLLERR (a TCP reset) is
		 * seen. POLLHUP only says both directions are shut, with data
		 * possibly still to read: once seen, a socket with nothing
		 * asked is left out, or poll() would spin.
		 */
		for (int i = 0; i < 2; i++) {
			struct pipe_dir *in = &dirs[i], *out = &dirs[i ^ 1];

			if (in->eof && out->shut) {
				p[i].fd = -1;
				continue;
			}
			if (!in->eof && !in->len)
				p[i].events |= POLLIN;
			if (out->len)
				p[i].events |= POLLOUT;
			if (!p[i].events && hup[i])
				p[i].fd = -1;
		}
		/*
		 * A vsock socket shows no event when the host closes both
		 * ways or resets after it shut down its sending side (no
		 * POLLHUP while ours is open): while nothing else is asked of
		 * it, probe every PROBE_MS with an empty send, which fails
		 * with EPIPE once the host no longer reads.
		 */
		probe = p[0].fd >= 0 && !p[0].events && !dirs[1].shut;
		r = poll(p, 2, probe ? PROBE_MS : -1);
		if (r < 0) {
			if (errno == EINTR)
				continue;
			break;
		}
		if (!r) {
			if (send(s, "", 0, MSG_NOSIGNAL) < 0 && errno != EAGAIN && errno != EINTR)
				break;
			continue;
		}
		if ((p[0].revents | p[1].revents) & POLLERR)
			break;
		for (int i = 0; i < 2; i++)
			if (p[i].revents & POLLHUP)
				hup[i] = 1;
		/* dirs[i] reads p[i] and writes p[i ^ 1]. */
		for (int i = 0; i < 2; i++) {
			struct pipe_dir *d = &dirs[i];
			ssize_t n;

			if (d->len && p[i ^ 1].revents & (POLLOUT | POLLHUP)) {
				n = send(d->to, d->buf + d->off, d->len - d->off, MSG_NOSIGNAL);
				if (n < 0 && errno != EAGAIN && errno != EINTR)
					goto out;	/* EPIPE, ECONNRESET: that side no longer reads */
				if (n > 0) {
					d->off += n;
					if (d->off == d->len)
						d->len = d->off = 0;
				}
			}
			if (!d->eof && !d->len && p[i].revents & (POLLIN | POLLHUP)) {
				n = recv(d->from, d->buf, sizeof(d->buf), 0);
				if (n > 0)
					d->len = n;
				else if (n == 0)
					d->eof = 1;
				else if (errno != EAGAIN && errno != EINTR)
					goto out;
			}
		}
	}
out:
	close(t);
	close(s);
	_exit(0);
}

static void __attribute__((noreturn)) session(int s)
{
	const char *home = "/", *user = "root", *shell = "/bin/sh", *base, *file;
	unsigned char h[HDR], *p, opened[14];
	struct open_req o = { 0 };
	struct passwd *pw;
	char **env, *argv[2], **args = argv;
	const char *bad;
	int ep[2], e, n, nenv = 0;
	int64_t end = now_ms() + OPEN_MS;
	unsigned int pts = 0;
	ssize_t r;

	signal(SIGCHLD, SIG_DFL);	/* the server's SA_NOCLDWAIT */
	fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
	if (recv_all(s, h, HDR, end)) {
		if (errno == ETIMEDOUT)
			refuse(s, "no OPEN within %d s", OPEN_MS / 1000);
		_exit(0);
	}
	if (h[0] != T_OPEN)
		refuse(s, "expected OPEN, got frame type %u", h[0]);
	n = get16(h + 2);
	p = malloc(n + 1);
	if (!p)
		refuse(s, "out of memory");
	if (recv_all(s, p, n, end)) {
		if (errno == ETIMEDOUT)
			refuse(s, "no OPEN within %d s", OPEN_MS / 1000);
		_exit(0);
	}
	bad = parse_open(p, n, &o);
	if (bad)
		refuse(s, "%s", bad);
	if (o.connect) {
		int t = tcp_connect(s, o.port);

		put16(opened, KWTTY_VERSION);
		put32(opened + 2, FEAT_PIPES | FEAT_CONNECT);
		put32(opened + 6, 0);
		put32(opened + 10, NO_PTS);
		h[0] = T_OPENED;
		h[1] = 0;
		put16(h + 2, sizeof(opened));
		if (send_all(s, h, HDR, now_ms() + 2000) || send_all(s, opened, sizeof(opened), now_ms() + 2000))
			_exit(0);
		relay(s, t);
	}

	pw = getpwuid(0);
	if (pw && pw->pw_dir && *pw->pw_dir)
		home = pw->pw_dir;
	if (pw && pw->pw_name && *pw->pw_name)
		user = pw->pw_name;
	if (pw && pw->pw_shell && *pw->pw_shell)
		shell = pw->pw_shell;
	env = calloc(6 + o.nenv + 1, sizeof(*env));
	base = strrchr(shell, '/');
	if (!env || asprintf(&argv[0], "-%s", base ? base + 1 : shell) < 0)
		refuse(s, "out of memory");
	argv[1] = NULL;
	{
		char *d[6];

		/* PATH: a login shell's (/etc/profile, then kw-path.sh), so that
		 * programs started directly find /usr/local/bin and ~/.local/bin. */
		if (asprintf(&d[0], "HOME=%s", home) < 0 ||
		    asprintf(&d[1], "USER=%s", user) < 0 ||
		    asprintf(&d[2], "LOGNAME=%s", user) < 0 ||
		    asprintf(&d[3], "SHELL=%s", shell) < 0 ||
		    asprintf(&d[4], "TERM=%s", o.term) < 0 ||
		    asprintf(&d[5], "PATH=%s/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			     strcmp(home, "/") ? home : "") < 0)
			refuse(s, "out of memory");
		for (int i = 0; i < 4; i++)
			env_set(env, &nenv, d[i]);
		env_set(env, &nenv, d[5]);
		/* Programs on pipes get TERM only when the host gives it. */
		if (!o.pipes || o.has_term)
			env_set(env, &nenv, d[4]);
	}
	for (int i = 0; i < o.nenv; i++)
		env_set(env, &nenv, o.env[i]);
	file = shell;
	if (o.nargv) {
		file = o.argv[0];
		args = o.argv;
	}
	/* The session's own directory, which the program inherits. */
	if (o.cwd ? chdir(o.cwd) : chdir(home) && chdir("/"))
		refuse(s, "chdir %s: %s", o.cwd ? o.cwd : home, strerror(errno));

	if (pipe2(ep, O_CLOEXEC))
		refuse(s, "pipe: %s", strerror(errno));
	if (o.pipes) {
		/* fds 0-2 are taken (main), so none of these lands there. */
		int pin[2], pout[2], perr[2];

		if (pipe2(pin, O_CLOEXEC) || pipe2(pout, O_CLOEXEC) || pipe2(perr, O_CLOEXEC))
			refuse(s, "pipe: %s", strerror(errno));
		x.pid = fork();
		if (x.pid < 0)
			refuse(s, "fork: %s", strerror(errno));
		if (!x.pid) {
			/* Its own session, so that a hangup reaches its children. */
			setsid();
			if (dup2(pin[0], 0) < 0 || dup2(pout[1], 1) < 0 || dup2(perr[1], 2) < 0)
				_exit(127);
			shell_child(ep[1], file, args, env);
		}
		close(pin[0]);
		close(pout[1]);
		close(perr[1]);
		x.m = -1;
		x.ifd = pin[1];
		x.ofd[0] = pout[0];
		x.ofd[1] = perr[0];
		x.pipes = 1;
		pts = NO_PTS;
	} else {
		x.pid = forkpty(&x.m, NULL, NULL, &o.ws);
		if (x.pid < 0)
			refuse(s, "forkpty: %s", strerror(errno));
		if (!x.pid)
			shell_child(ep[1], file, args, env);
		x.ifd = x.ofd[0] = x.m;
		x.ofd[1] = -1;
	}
	close(ep[1]);
	do
		r = read(ep[0], &e, sizeof(e));
	while (r < 0 && errno == EINTR);
	close(ep[0]);
	if (r == sizeof(e)) {
		waitpid(x.pid, NULL, 0);
		refuse(s, "exec %s: %s", file, strerror(e));
	}
	x.s = s;
	x.pfd = syscall(SYS_pidfd_open, x.pid, 0);
	if (x.pfd < 0) {
		e = errno;
		kill(x.pid, SIGKILL);
		waitpid(x.pid, NULL, 0);
		refuse(s, "pidfd_open: %s", strerror(e));
	}
	if (x.m >= 0)
		ioctl(x.m, TIOCGPTN, &pts);
	/* On a pty these are all the master. */
	fcntl(x.ifd, F_SETFL, fcntl(x.ifd, F_GETFL) | O_NONBLOCK);
	for (int i = 0; i < 2; i++)
		if (x.ofd[i] >= 0)
			fcntl(x.ofd[i], F_SETFL, fcntl(x.ofd[i], F_GETFL) | O_NONBLOCK);
	put16(opened, KWTTY_VERSION);
	put32(opened + 2, FEAT_PIPES | FEAT_CONNECT);
	put32(opened + 6, x.pid);
	put32(opened + 10, pts);
	queue(T_OPENED, opened, sizeof(opened));
	session_loop();
}

static int usage(void)
{
	fprintf(stderr, "usage: kwtty serve [PORT]\n");
	return 2;
}

int main(int argc, char **argv)
{
	struct sockaddr_vm a = {
		.svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_ANY, .svm_port = KWTTY_PORT,
	};
	struct sigaction sa = { .sa_handler = SIG_IGN, .sa_flags = SA_NOCLDWAIT };
	unsigned int cid = VMADDR_CID_ANY;
	int fd, l;

	if (argc < 2 || argc > 3 || strcmp(argv[1], "serve"))
		return usage();
	if (argc == 3) {
		char *e;
		unsigned long port = strtoul(argv[2], &e, 0);

		if (!*argv[2] || *e || port >= VMADDR_PORT_ANY)
			return usage();
		a.svm_port = port;
	}
	/* Keep 0-2 taken, so that no socket or pty lands there. */
	do
		fd = open("/dev/null", O_RDWR);
	while (fd >= 0 && fd < 3);
	if (fd >= 0)
		close(fd);

	/*
	 * socket(AF_VSOCK) works without a transport; the local CID tells
	 * whether there is one (VMADDR_CID_ANY: none). Without one there is
	 * nothing to serve, and exiting would make init respawn us forever.
	 */
	fd = open("/dev/vsock", O_RDONLY | O_CLOEXEC);
	if (fd >= 0) {
		if (ioctl(fd, IOCTL_VM_SOCKETS_GET_LOCAL_CID, &cid))
			cid = VMADDR_CID_ANY;
		close(fd);
	}
	if (cid == VMADDR_CID_ANY)
		idle();

	sigaction(SIGCHLD, &sa, NULL);	/* sessions reap themselves */
	signal(SIGPIPE, SIG_IGN);
	l = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (l < 0 || bind(l, (struct sockaddr *)&a, sizeof(a)) || listen(l, 32)) {
		fprintf(stderr, "kwtty: vsock port %u: %s\n", a.svm_port, strerror(errno));
		idle();
	}
	for (;;) {
		struct sockaddr_vm peer = { 0 };
		socklen_t plen = sizeof(peer);
		int c = accept4(l, (struct sockaddr *)&peer, &plen, SOCK_CLOEXEC);

		if (c < 0) {
			if (errno != EINTR && errno != ECONNABORTED)
				usleep(100000);	/* EMFILE, ENOMEM: do not spin */
			continue;
		}
		/* Only the host: the shell is root, without authentication. */
		if (peer.svm_cid != VMADDR_CID_HOST) {
			close(c);
			continue;
		}
		if (!fork()) {
			close(l);
			session(c);
		}
		close(c);
	}
}
