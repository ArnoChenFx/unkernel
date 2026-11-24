// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk, the guest's Vulkan ICD: shared declarations. The ICD keeps
// guest-side state (memory shadows, fences, command recording) and sends
// everything else to the page's VkRenderer as framed JSON (vk/PROTOCOL.md).
#ifndef KWVK_H
#define KWVK_H

#define VK_USE_PLATFORM_WAYLAND_KHR 1
#define VK_NO_PROTOTYPES 1
#include <vulkan/vulkan.h>
#include <vulkan/vk_icd.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

#define KW_EXPORT __attribute__((visibility("default")))

void kw_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/* growable byte/JSON buffer */
struct jb {
	char *p;
	size_t n, cap;
};
void jb_put(struct jb *b, const void *s, size_t n);
/* a string literal */
#define JS(b, lit) jb_put(b, lit, sizeof(lit) - 1)
void jb_printf(struct jb *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void jb_float(struct jb *b, double f);
void jb_str(struct jb *b, const char *s);
void jb_free(struct jb *b);
void jb_reset(struct jb *b);

/* minimal JSON reading (replies only) */
const char *js_get(const char *obj, const char *key);
const char *js_skip(const char *p);
const char *js_member(const char *p, const char **k, size_t *kl, const char **v);
double js_num(const char *v, double dflt);
void js_strcpy(const char *v, char *out, size_t cap);

/* link */
struct kw_reply {
	uint32_t r;
	char *json;
	uint8_t *bin;
	size_t binlen;
	struct kw_reply *next;
};
struct kw_link {
	int fd;
	int dead;
	pthread_mutex_t send_mu;
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int reading;
	uint32_t next_r;
	uint32_t next_id;
	struct kw_reply *done; /* replies not yet claimed */
};
struct kw_link *link_open(void);
void link_close(struct kw_link *l);
uint32_t link_id(struct kw_link *l);
/* send b (a JSON object); with want_reply, adds "r" and returns it */
uint32_t link_send(struct kw_link *l, struct jb *b, const void *bin, size_t binlen, int want_reply);
/* wait for the reply to r; caller frees with reply_free */
struct kw_reply *link_wait(struct kw_link *l, uint32_t r);
/* timeout_ns < 0: forever; NULL on timeout (*timed_out = 1) or a dead link */
struct kw_reply *link_wait_timeout(struct kw_link *l, uint32_t r, int64_t timeout_ns, int *timed_out);
/* has r been replied to? reads what is available without blocking */
int link_poll(struct kw_link *l, uint32_t r);
struct kw_reply *link_call(struct kw_link *l, struct jb *b, const void *bin, size_t binlen);
void reply_free(struct kw_reply *rep);

/* objects */
struct kw_instance;
struct kw_physical_device {
	VK_LOADER_DATA loader;
	struct kw_instance *inst;
	VkPhysicalDeviceProperties props;
	VkPhysicalDeviceFeatures features;
	VkPhysicalDeviceMemoryProperties mem;
	uint32_t fmtcaps[256];
	uint32_t max2d;
	uint32_t timestamp_bits;
	int f16;
	uint64_t max_alloc;
};
struct kw_instance {
	VK_LOADER_DATA loader;
	struct kw_link *link;
	struct kw_physical_device pd;
};
struct kw_buffer;
struct kw_device {
	VK_LOADER_DATA loader;
	struct kw_physical_device *pd;
	struct kw_link *link;
	struct kw_queue *queue;
	pthread_mutex_t mu; /* buffer and memory lists */
	pthread_mutex_t rb_mu; /* one readback at a time */
	struct kw_buffer *buffers;
	struct kw_memory *mems;
};
struct kw_queue {
	VK_LOADER_DATA loader;
	struct kw_device *dev;
};
struct kw_memory {
	uint32_t type;
	VkDeviceSize size;
	uint8_t *shadow, *sent;
	int mapped, touched;
	struct kw_memory *next, *prev;
};
struct kw_buffer {
	uint32_t id;
	VkDeviceSize size;
	VkBufferUsageFlags usage;
	struct kw_memory *mem;
	VkDeviceSize offset;
	int gpu_dirty;
	int fresh; /* bound while its memory had no last-sent copy */
	struct kw_buffer *next, *prev;
};
struct kw_image {
	uint32_t id;
	VkFormat format;
	VkExtent3D extent;
	int swapchain;
};
struct kw_obj { /* every other host object */
	uint32_t id;
};
struct kw_dslot {
	uint32_t binding, elem;
	struct kw_buffer *buf;
};
struct kw_dset {
	uint32_t id;
	struct kw_dpool *pool;
	struct kw_dset *next, *prev;
	struct kw_dslot *slots; /* storage buffers written into this set */
	size_t nslots;
};
struct kw_dpool {
	struct kw_dset *sets;
};
struct kw_fence {
	int signaled;
	uint32_t r; /* pending submit reply */
};
struct kw_shader {
	uint32_t id;
	int nw; /* writable storage bindings (set << 16 | binding), -1 unknown */
	uint32_t w[];
};
struct kw_pipe {
	uint32_t id;
	int nw;
	uint32_t w[];
};
#define KW_MAX_SETS 8
struct kw_cmdbuf {
	VK_LOADER_DATA loader;
	struct kw_device *dev;
	struct kw_cmdpool *pool;
	struct kw_cmdbuf *next, *prev;
	struct jb cmds; /* comma-separated command objects */
	struct kw_buffer **written;
	size_t nwritten, capwritten;
	struct kw_pipe *pipe[2]; /* bound graphics, compute pipeline */
	struct kw_dset *sets[2][KW_MAX_SETS];
};
struct kw_cmdpool {
	struct kw_cmdbuf *bufs;
};

#define HANDLE(T, h) ((T *)(uintptr_t)(h))

void kw_flush_writes(struct kw_device *d, struct kw_memory *only);
void kw_readback(struct kw_device *d, struct kw_memory *only);
uint32_t kw_create_image_msg(struct kw_device *d, const VkImageCreateInfo *ci);

/* KWVK_STATS=1: where the ICD's time goes, printed every 2 s at present */
struct kw_stats {
	int64_t flush_ns, scan_bytes, write_bytes, writes;
	int64_t readback_ns, read_bytes;
	int64_t submit_ns, submit_json, submits;
	int64_t present_ns, present_bytes, presents;
	int64_t wait_ns;
};
extern struct kw_stats kw_stats;
extern int kw_stats_on;
int64_t kw_now(void);
void kw_stats_tick(void);

/* WSI (wsi.c) */
PFN_vkVoidFunction kw_wsi_proc(const char *name);

#endif
