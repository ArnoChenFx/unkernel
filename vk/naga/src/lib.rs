// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// kwvk-naga: translates Vulkan SPIR-V to WGSL for the WebGPU host renderer
// (js/core/vk-shader.ts, contract in vk/PROTOCOL.md "Shaders and
// coordinates"). A plain C ABI, no wasm-bindgen:
//
//   kwvk_alloc(len) -> ptr, kwvk_free(ptr, len)
//   kwvk_translate(spv, spv_len, opts, opts_len) -> ptr to [u32 len][JSON]
//
// opts is "key=value" lines: stage, entry, flipY, pushGroup, spec.<id>.
// The result is {"wgsl","entryPoint","bindings",["pushConstantSize"]} or
// {"error"}; the caller frees it with kwvk_free(ptr, 4 + len).
//
// Before naga (spirv.rs): spec constants are baked and OpSpecConstantOp
// folded, combined image samplers split, every binding doubled, output
// blocks given per-member locations, std140 scalar/vec2 arrays wrapped.
// On naga's IR: gl_PointSize dropped, input blocks split, push constants
// become a uniform buffer, only the requested entry point kept. On the
// WGSL text: struct padding for Vulkan offsets, and fragment shaders turn
// off derivative_uniformity. flipY is spv-in's adjust_coordinate_space.

mod small;
mod spirv;

use naga::{AddressSpace, ImageClass, ImageDimension, ScalarKind, StorageAccess, TypeInner};
use std::fmt::Write as _;

#[no_mangle]
pub extern "C" fn kwvk_alloc(len: usize) -> *mut u8 {
	let mut v: Vec<u8> = Vec::with_capacity(len.max(1));
	let p = v.as_mut_ptr();
	std::mem::forget(v);
	p
}

#[no_mangle]
pub unsafe extern "C" fn kwvk_free(ptr: *mut u8, len: usize) {
	drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub unsafe extern "C" fn kwvk_translate(spv: *const u8, spv_len: usize, opts: *const u8, opts_len: usize) -> *mut u8 {
	let spv = std::slice::from_raw_parts(spv, spv_len);
	let opts = std::str::from_utf8(std::slice::from_raw_parts(opts, opts_len)).unwrap_or("");
	let json = match translate(spv, &Opts::parse(opts)) {
		Ok(s) => s,
		Err(e) => {
			let mut s = String::from("{\"error\":");
			json_str(&mut s, &e);
			s.push('}');
			s
		}
	};
	let mut out = Vec::with_capacity(4 + json.len());
	out.extend_from_slice(&(json.len() as u32).to_le_bytes());
	out.extend_from_slice(json.as_bytes());
	let len = out.len();
	let p = kwvk_alloc(len);
	std::ptr::copy_nonoverlapping(out.as_ptr(), p, len);
	p
}

struct Opts {
	stage: naga::ShaderStage,
	entry: String,
	flip_y: bool,
	push_group: u32,
	spec: Vec<(String, f64)>,
	arrays: Vec<(u32, u32, u32, u32)>,
	dump: bool,
	link: Vec<(u32, String, String)>,
	storage_formats: Vec<(u32, u32, u32)>,
	features: Vec<String>,
	limits: Option<[u32; 4]>,
}

impl Opts {
	fn parse(s: &str) -> Opts {
		NO_VALIDATE.store(false, std::sync::atomic::Ordering::Relaxed);
		let mut o = Opts { stage: naga::ShaderStage::Vertex, entry: "main".into(), flip_y: false, push_group: 0, spec: Vec::new(), arrays: Vec::new(), dump: false, link: Vec::new(), storage_formats: Vec::new(), features: Vec::new(), limits: None };
		for line in s.lines() {
			let Some((k, v)) = line.split_once('=') else { continue };
			match k {
				"stage" => {
					o.stage = match v {
						"fragment" => naga::ShaderStage::Fragment,
						"compute" => naga::ShaderStage::Compute,
						_ => naga::ShaderStage::Vertex,
					}
				}
				"entry" => o.entry = v.into(),
				"flipY" => o.flip_y = v == "1" || v == "true",
				"dump" => o.dump = v == "1",
				"limits" => {
					let n: Vec<u32> = v.split(',').filter_map(|x| x.parse().ok()).collect();
					if n.len() == 4 {
						o.limits = Some([n[0], n[1], n[2], n[3]]);
					}
				}
				"features" => o.features = v.split(',').filter(|x| !x.is_empty()).map(String::from).collect(),
				"noValidate" => NO_VALIDATE.store(v == "1", std::sync::atomic::Ordering::Relaxed),
				"pushGroup" => o.push_group = v.parse().unwrap_or(0),
				_ => {
					// format.<set>.<binding>=<SPIR-V ImageFormat>
					if let Some(sb) = k.strip_prefix("format.") {
						let n: Vec<u32> = sb.split('.').chain(std::iter::once(v)).filter_map(|x| x.parse().ok()).collect();
						if n.len() == 3 {
							o.storage_formats.push((n[0], n[1], n[2]));
						}
					}
					// link.<location>=<interpolation>,<sampling>
					if let Some(l) = k.strip_prefix("link.").and_then(|l| l.parse().ok()) {
						let (i, smp) = v.split_once(',').unwrap_or((v, ""));
						o.link.push((l, i.into(), smp.into()));
					}
					// array.<set>.<binding>=<base>,<count>
					if let Some(sb) = k.strip_prefix("array.") {
						let n: Vec<u32> = sb.split('.').chain(v.split(',')).filter_map(|x| x.parse().ok()).collect();
						if n.len() == 4 {
							o.arrays.push((n[0], n[1], n[2], n[3]));
						}
					}
					if let Some(id) = k.strip_prefix("spec.") {
						let val = match v {
							"true" => 1.0,
							"false" => 0.0,
							_ => v.parse().unwrap_or(0.0),
						};
						o.spec.push((id.into(), val));
					}
				}
			}
		}
		o
	}
}

fn err_chain(e: &dyn std::error::Error) -> String {
	let mut s = e.to_string();
	let mut cur = e.source();
	while let Some(c) = cur {
		let t = c.to_string();
		if !s.contains(&t) {
			s.push_str(": ");
			s.push_str(&t);
		}
		cur = c.source();
	}
	s
}

static NO_VALIDATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn validate(module: &naga::Module) -> Result<naga::valid::ModuleInfo, String> {
	// Layouts are left to WebGPU: push constants are std430 (arrays of
	// stride 4 in a uniform buffer), which WGSL's
	// uniform_buffer_standard_layout allows (Chrome has it) and naga's
	// check refuses.
	let mut flags = naga::valid::ValidationFlags::all() & !naga::valid::ValidationFlags::CONTROL_FLOW_UNIFORMITY & !naga::valid::ValidationFlags::STRUCT_LAYOUTS;
	if NO_VALIDATE.load(std::sync::atomic::Ordering::Relaxed) {
		// Debugging (opts noValidate=1): see the WGSL naga would reject.
		flags = naga::valid::ValidationFlags::empty();
	}
	naga::valid::Validator::new(flags, naga::valid::Capabilities::all())
		.validate(module)
		.map_err(|e| format!("validation: {}", err_chain(&e)))
}

fn translate(spv: &[u8], o: &Opts) -> Result<String, String> {
	if spv.len() % 4 != 0 || spv.len() < 20 {
		return Err("SPIR-V: bad length".into());
	}
	let words: Vec<u32> = spv.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
	spirv::check(&words)?;
	let words = spirv::bake_spec_constants(words, &o.spec);
	let words = spirv::fold_spec_ops(words);
	let words = spirv::misc_fixes(words);
	let words = spirv::strip_memory_operands(words);
	let words = spirv::lower_umul_extended(words);
	let words = spirv::localize_subgroup_operands(words);
	let words = small::lower_small_storage(words, o.features.iter().any(|f| f == "shader-f16"))?;
	let words = spirv::merge_aliased_buffers(words);
	let words = spirv::storage_image_formats(words, &o.storage_formats);
	let words = spirv::subpass_inputs(words);
	let words = spirv::flatten_io_arrays(words)?;
	let (words, flats) = spirv::flatten_descriptor_arrays(words, &o.arrays)?;
	let fixed: std::collections::HashMap<u32, u32> = flats.iter().map(|f| (f.var, f.wgsl_binding)).collect();
	let words = spirv::split_combined_samplers(words, &fixed)?;
	let words = spirv::wrap_strided_arrays(words)?;
	let words = spirv::split_misaligned_vectors(words);
	if o.dump {
		// Debugging: the pre-passes' SPIR-V instead of a translation.
		return Err(format!("dump:{}", words.iter().map(|w| format!("{:08x}", w)).collect::<String>()));
	}
	let popts = naga::front::spv::Options {
		adjust_coordinate_space: o.flip_y && o.stage == naga::ShaderStage::Vertex,
		strict_capabilities: false,
		block_ctx_dump_prefix: None,
	};
	let mut module = naga::front::spv::Frontend::new(words.into_iter(), &popts)
		.parse()
		.map_err(|e| format!("SPIR-V parse: {}", err_chain(&e)))?;

	let nep = module.entry_points.len();
	module.entry_points.retain(|ep| ep.name == o.entry && ep.stage == o.stage);
	if module.entry_points.is_empty() {
		return Err(format!("no {:?} entry point named {:?} (module has {})", o.stage, o.entry, nep));
	}

	drop_point_size(&mut module)?;
	if o.stage == naga::ShaderStage::Compute && inline_compute_main(&mut module) {
		// Branches on constants (baked spec constants) go, so resources
		// only they use drop out of the reflection with the compaction.
		let consts = module.constants.clone();
		let gexp = module.global_expressions.clone();
		for ep in module.entry_points.iter_mut() {
			let f = &mut ep.function;
			prune_constant_ifs(&mut f.body, &f.expressions, &consts, &gexp);
		}
		// The old inner main is unused now but would still be analyzed by
		// Tint: drop unused functions (and with them unused globals).
		naga::compact::compact(&mut module, naga::compact::KeepUnused::No);
	}
	split_input_blocks(&mut module);
	flat_integer_varyings(&mut module, &o.link);
	for (_, f) in module.functions.iter_mut() {
		fix_switch_fallthrough(&mut f.body);
	}
	for ep in module.entry_points.iter_mut() {
		fix_switch_fallthrough(&mut ep.function.body);
	}
	for (_, gv) in module.global_variables.iter_mut() {
		// WGSL has no write-only storage buffers.
		if let AddressSpace::Storage { access } = &mut gv.space {
			if !access.contains(StorageAccess::LOAD) {
				*access |= StorageAccess::LOAD;
			}
		}
	}

	// Push constants -> uniform buffer at @group(pushGroup) @binding(0).
	let mut push_size = None;
	let mut layouter = naga::proc::Layouter::default();
	layouter.update(module.to_ctx()).map_err(|e| format!("layout: {}", e))?;
	for (_, gv) in module.global_variables.iter_mut() {
		if gv.space == AddressSpace::Immediate {
			push_size = Some(layouter[gv.ty].size);
			gv.space = AddressSpace::Uniform;
			gv.binding = Some(naga::ResourceBinding { group: o.push_group, binding: 0 });
		}
	}

	let info = validate(&module)?;
	let mut pc = naga::back::PipelineConstants::default();
	for (k, v) in &o.spec {
		// Ids the shader does not declare are ignored, as in Vulkan.
		if module.overrides.iter().any(|(_, ov)| ov.id.map(|id| id.to_string()).as_deref() == Some(k.as_str())) {
			pc.insert(k.clone(), *v);
		}
	}
	// Spec constants the host did not set keep their defaults, baked too.
	let (module, info) = naga::back::pipeline_constants::process_overrides(&module, &info, Some((o.stage, &o.entry)), &pc)
		.map_err(|e| format!("specialization: {}", err_chain(&e)))?;
	// The overrides are all baked into constants now; drop their now unused
	// declarations so the host has nothing to feed.
	let (module, info) = if module.overrides.is_empty() {
		(module, info)
	} else {
		let mut m = module.into_owned();
		m.overrides = naga::Arena::new();
		let i = validate(&m)?;
		(std::borrow::Cow::Owned(m), std::borrow::Cow::Owned(i))
	};

	let mut module = module.into_owned();
	let pads = struct_paddings(&mut module)?;
	let mut wgsl = naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
		.map_err(|e| format!("WGSL: {}", err_chain(&e)))?;
	apply_paddings(&mut wgsl, &pads);
	if !wgsl.contains("binding_array<") {
		// Left over from flattened descriptor arrays' unused array types.
		wgsl = wgsl.replace("enable wgpu_binding_array;\n", "");
	}
	if o.stage == naga::ShaderStage::Fragment {
		wgsl.insert_str(0, "diagnostic(off, derivative_uniformity);\n");
	}
	if !wgsl.contains("enable subgroups;") && (wgsl.contains("@builtin(subgroup_") || wgsl.contains(" subgroup") || wgsl.contains("(subgroup") || wgsl.contains("quadSwap") || wgsl.contains("quadBroadcast")) {
		// naga's writer uses subgroup builtins without enabling them.
		wgsl.insert_str(0, "enable subgroups;\n");
	}
	let dispatch_scale = match (o.stage, o.limits) {
		(naga::ShaderStage::Compute, Some(l)) => fit_workgroup(&mut wgsl, l)?,
		_ => None,
	};
	let attr = match o.stage {
		naga::ShaderStage::Vertex => "@vertex",
		naga::ShaderStage::Fragment => "@fragment",
		_ => "@compute",
	};
	let entry = wgsl
		.find(attr)
		.and_then(|i| wgsl[i..].find("fn ").map(|j| i + j + 3))
		.map(|i| wgsl[i..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect::<String>())
		.unwrap_or_else(|| o.entry.clone());

	let mut s = String::with_capacity(wgsl.len() + 256);
	s.push_str("{");
	if let Some([x, y, z]) = dispatch_scale {
		let _ = write!(s, "\"dispatchScale\":[{},{},{}],", x, y, z);
	}
	s.push_str("\"wgsl\":");
	json_str(&mut s, &wgsl);
	s.push_str(",\"entryPoint\":");
	json_str(&mut s, &entry);
	s.push_str(",\"bindings\":[");
	let mut first = true;
	for (_, gv) in module.global_variables.iter() {
		let Some(rb) = gv.binding else { continue };
		if push_size.is_some() && gv.space == AddressSpace::Uniform && rb.group == o.push_group && rb.binding == 0 {
			continue;
		}
		if !first {
			s.push(',');
		}
		first = false;
		let is_sampler = matches!(module.types[gv.ty].inner, TypeInner::Sampler { .. });
		let flat = flats
			.iter()
			.find(|f| f.set == rb.group && (f.wgsl_binding == rb.binding || (is_sampler && f.wgsl_binding + 1 == rb.binding)));
		let _ = write!(s, "{{\"set\":{},\"binding\":{},\"group\":{},\"wgslBinding\":{},", rb.group, flat.map(|f| f.binding).unwrap_or(rb.binding >> 1), rb.group, rb.binding);
		if let Some(f) = flat {
			let _ = write!(s, "\"arrayIndex\":{},", f.index);
		}
		s.push_str("\"kind\":");
		match gv.space {
			AddressSpace::Uniform => s.push_str("\"uniform\""),
			AddressSpace::Storage { access } => {
				s.push_str(if access.contains(StorageAccess::STORE) { "\"storage\"" } else { "\"read-only-storage\"" })
			}
			_ => match &module.types[gv.ty].inner {
				TypeInner::Sampler { comparison } => {
					s.push_str(if *comparison { "\"comparison-sampler\"" } else { "\"sampler\"" })
				}
				TypeInner::Image { dim, arrayed, class } => {
					let vd = match (dim, arrayed) {
						(ImageDimension::D1, _) => "1d",
						(ImageDimension::D2, false) => "2d",
						(ImageDimension::D2, true) => "2d-array",
						(ImageDimension::D3, _) => "3d",
						(ImageDimension::Cube, false) => "cube",
						(ImageDimension::Cube, true) => "cube-array",
					};
					match class {
						ImageClass::Sampled { kind, multi } => {
							let st = match kind {
								ScalarKind::Sint => "sint",
								ScalarKind::Uint => "uint",
								_ => "float",
							};
							let _ = write!(s, "\"texture\",\"viewDimension\":\"{}\",\"sampleType\":\"{}\",\"multisampled\":{}", vd, st, multi);
						}
						ImageClass::Depth { multi } => {
							let _ = write!(s, "\"texture\",\"viewDimension\":\"{}\",\"sampleType\":\"depth\",\"multisampled\":{}", vd, multi);
						}
						ImageClass::Storage { format, access } => {
							let acc = if access.contains(StorageAccess::LOAD | StorageAccess::STORE) {
								"read-write"
							} else if access.contains(StorageAccess::STORE) {
								"write-only"
							} else {
								"read-only"
							};
							let fmt = format!("{:?}", format).to_lowercase();
							let _ = write!(s, "\"storage-texture\",\"viewDimension\":\"{}\",\"format\":\"{}\",\"access\":\"{}\"", vd, fmt, acc);
						}
						_ => s.push_str("\"texture\""),
					}
				}
				_ => return Err("descriptor arrays are not supported".into()),
			},
		}
		s.push('}');
	}
	s.push(']');
	// The vertex stage's outputs, for the host to pass the fragment stage
	// as opts.link.
	if o.stage == naga::ShaderStage::Vertex {
		s.push_str(",\"varyings\":[");
		let mut first = true;
		if let Some(r) = module.entry_points.first().and_then(|ep| ep.function.result.as_ref()) {
			let mut bs: Vec<naga::Binding> = r.binding.iter().cloned().collect();
			if let TypeInner::Struct { members, .. } = &module.types[r.ty].inner {
				bs.extend(members.iter().filter_map(|m| m.binding.clone()));
			}
			for b in bs {
				if let naga::Binding::Location { location, interpolation, sampling, .. } = b {
					let i = match interpolation {
						Some(naga::Interpolation::Flat) => "flat",
						Some(naga::Interpolation::Linear) => "linear",
						_ => "perspective",
					};
					let smp = match sampling {
						Some(naga::Sampling::Centroid) => "centroid",
						Some(naga::Sampling::Sample) => "sample",
						_ if i == "flat" => "",
						_ => "center",
					};
					let _ = write!(s, "{}{{\"location\":{},\"interpolation\":\"{}\",\"sampling\":\"{}\"}}", if first { "" } else { "," }, location, i, smp);
					first = false;
				}
			}
		}
		s.push(']');
	}
	// WebGPU features the WGSL needs (from its enable directives).
	s.push_str(",\"requires\":[");
	let mut first = true;
	for line in wgsl.lines().filter(|l| l.starts_with("enable ")) {
		for ext in line["enable ".len()..].trim_end_matches(';').split(',') {
			let feat = match ext.trim() {
				"f16" => "shader-f16",
				"subgroups" => "subgroups",
				"clip_distances" => "clip-distances",
				"dual_source_blending" => "dual-source-blending",
				other => other, // not a WebGPU feature (e.g. naga's wgpu_*): cannot run
			};
			let _ = write!(s, "{}\"{}\"", if first { "" } else { "," }, feat);
			first = false;
		}
	}
	s.push(']');
	if let Some(n) = push_size {
		let _ = write!(s, ",\"pushConstantSize\":{}", n);
	}
	s.push('}');
	Ok(s)
}

// naga's WGSL writer ignores member offsets, so a buffer struct whose
// SPIR-V Offsets differ from WGSL's natural layout (layout(offset = N) push
// constants of a later stage, explicit offsets, HLSL packing) would read
// the wrong bytes. Such structs get a marker name here; apply_paddings then
// adds @size to the member before each gap and, for a gap before the first
// member, padding members (accesses are by name, so they shift nothing).
struct Padding {
	name: String,
	front: u32,
	sizes: Vec<Option<u32>>,
}

fn struct_paddings(module: &mut naga::Module) -> Result<Vec<Padding>, String> {
	let mut layouter = naga::proc::Layouter::default();
	layouter.update(module.to_ctx()).map_err(|e| format!("layout: {}", e))?;
	let mut pads = Vec::new();
	let handles: Vec<_> = module.types.iter().map(|(h, _)| h).collect();
	// A struct array's ArrayStride (std140 rounds struct sizes up to 16)
	// sets the size the struct must have.
	let mut want: std::collections::HashMap<naga::Handle<naga::Type>, u32> = Default::default();
	for (_, t) in module.types.iter() {
		if let TypeInner::Array { base, stride, .. } = t.inner {
			if matches!(module.types[base].inner, TypeInner::Struct { .. }) {
				let w = want.entry(base).or_insert(0);
				*w = (*w).max(stride);
			}
		}
	}
	for h in handles {
		let TypeInner::Struct { members, span } = &module.types[h].inner else { continue };
		let span = &(*span).max(want.get(&h).copied().unwrap_or(0));
		if members.iter().any(|m| m.binding.is_some()) {
			continue;
		}
		let mut sizes = vec![None; members.len()];
		let mut front = 0;
		let mut pos = 0u32;
		let mut changed = false;
		for (i, m) in members.iter().enumerate() {
			let l = &layouter[m.ty];
			let at = l.alignment.round_up(pos);
			if m.offset > at {
				changed = true;
				if i == 0 {
					front = m.offset;
				} else {
					sizes[i - 1] = Some(m.offset - members[i - 1].offset);
				}
			}
			pos = m.offset.max(at) + l.size;
		}
		let align = members.iter().map(|m| layouter[m.ty].alignment).max();
		if let (Some(last), Some(align)) = (members.last(), align) {
			if *span > align.round_up(pos) && *span >= last.offset + layouter[last.ty].size {
				changed = true;
				sizes[members.len() - 1] = Some(*span - last.offset);
			}
		}
		if changed {
			let name = format!("kwvkpad{}x", h.index());
			let mut t = module.types[h].clone();
			t.name = Some(name.clone());
			replace_type(&mut module.types, h, t);
			pads.push(Padding { name, front, sizes });
		}
	}
	Ok(pads)
}

fn apply_paddings(wgsl: &mut String, pads: &[Padding]) {
	for p in pads {
		let head = format!("struct {} {{\n", p.name);
		let Some(start) = wgsl.find(&head) else { continue };
		let mut at = start + head.len();
		let mut ins = String::new();
		let (vecs, words) = (p.front / 16, p.front % 16 / 4);
		if vecs > 0 {
			let _ = writeln!(ins, "    _kwvk_pad: array<vec4<u32>, {}>,", vecs);
		}
		for i in 0..words {
			let _ = writeln!(ins, "    _kwvk_pad{}: u32,", i);
		}
		wgsl.insert_str(at, &ins);
		at += ins.len();
		for sz in &p.sizes {
			let indent = wgsl[at..].len() - wgsl[at..].trim_start().len();
			if let Some(n) = sz {
				let attr = format!("@size({}) ", n);
				wgsl.insert_str(at + indent, &attr);
			}
			match wgsl[at..].find('\n') {
				Some(e) => at += e + 1,
				None => break,
			}
		}
	}
}

// An input interface block (GLSL `in V { ... } v;`) reaches the entry point
// as one struct argument with the block's Location; WGSL wants a location
// per member: give member i location + i and drop the argument's.
// spv-in marks a switch case as falling through when its body ends in an
// if/else whose branches all return (GTK's border shader); WGSL's writer
// rejects non-empty fall-through cases. Such a body never falls through.
fn fix_switch_fallthrough(block: &mut naga::Block) {
	fn ends(b: &naga::Block) -> bool {
		match b.last() {
			Some(naga::Statement::Return { .. } | naga::Statement::Kill | naga::Statement::Break | naga::Statement::Continue) => true,
			Some(naga::Statement::If { accept, reject, .. }) => ends(accept) && ends(reject),
			Some(naga::Statement::Block(inner)) => ends(inner),
			_ => false,
		}
	}
	for st in block.iter_mut() {
		match st {
			naga::Statement::Block(b) => fix_switch_fallthrough(b),
			naga::Statement::If { accept, reject, .. } => {
				fix_switch_fallthrough(accept);
				fix_switch_fallthrough(reject);
			}
			naga::Statement::Loop { body, continuing, .. } => {
				fix_switch_fallthrough(body);
				fix_switch_fallthrough(continuing);
			}
			naga::Statement::Switch { cases, .. } => {
				for c in cases.iter_mut() {
					fix_switch_fallthrough(&mut c.body);
					if c.fall_through && !c.body.is_empty() && ends(&c.body) {
						c.fall_through = false;
					}
				}
			}
			_ => {}
		}
	}
}

// Vulkan needs Flat only on integer fragment inputs, WGSL on both sides.
fn flat_integer_varyings(module: &mut naga::Module, link: &[(u32, String, String)]) {
	let fix = |b: &mut Option<naga::Binding>, inner: &TypeInner| {
		if let Some(naga::Binding::Location { location, interpolation, sampling, .. }) = b {
			if matches!(inner.scalar_kind(), Some(ScalarKind::Sint | ScalarKind::Uint | ScalarKind::Bool)) {
				*interpolation = Some(naga::Interpolation::Flat);
			} else if let Some((_, i, smp)) = link.iter().find(|l| l.0 == *location) {
				// Match the other stage (opts.link): WebGPU wants equal
				// interpolation on both sides of each location.
				*interpolation = Some(match i.as_str() {
					"flat" => naga::Interpolation::Flat,
					"linear" => naga::Interpolation::Linear,
					_ => naga::Interpolation::Perspective,
				});
				*sampling = match smp.as_str() {
					"centroid" => Some(naga::Sampling::Centroid),
					"sample" => Some(naga::Sampling::Sample),
					_ => Some(naga::Sampling::Center),
				};
			}
			if *interpolation == Some(naga::Interpolation::Flat) {
				*sampling = None;
			}
		}
	};
	for ep in module.entry_points.iter_mut() {
		let mut tys = Vec::new();
		for arg in ep.function.arguments.iter_mut() {
			let inner = module.types[arg.ty].inner.clone();
			fix(&mut arg.binding, &inner);
			tys.push(arg.ty);
		}
		if let Some(r) = ep.function.result.as_mut() {
			let inner = module.types[r.ty].inner.clone();
			fix(&mut r.binding, &inner);
			tys.push(r.ty);
		}
		for ty in tys {
			let mut t = module.types[ty].clone();
			let TypeInner::Struct { members, .. } = &mut t.inner else { continue };
			for m in members.iter_mut() {
				let inner = module.types[m.ty].inner.clone();
				fix(&mut m.binding, &inner);
			}
			replace_type(&mut module.types, ty, t);
		}
	}
}

fn split_input_blocks(module: &mut naga::Module) {
	for ep in module.entry_points.iter_mut() {
		for arg in ep.function.arguments.iter_mut() {
			let Some(naga::Binding::Location { location, interpolation, sampling, .. }) = arg.binding else { continue };
			let mut t = module.types[arg.ty].clone();
			let TypeInner::Struct { members, .. } = &mut t.inner else { continue };
			for (i, m) in members.iter_mut().enumerate() {
				if m.binding.is_some() {
					continue;
				}
				let float = module.types[m.ty].inner.scalar_kind() == Some(ScalarKind::Float);
				m.binding = Some(naga::Binding::Location {
					location: location + i as u32,
					interpolation: if float { Some(interpolation.unwrap_or(naga::Interpolation::Perspective)) } else { Some(naga::Interpolation::Flat) },
					sampling: if float { Some(sampling.unwrap_or(naga::Sampling::Center)) } else { None },
					blend_src: None,
					per_primitive: false,
				});
			}
			replace_type(&mut module.types, arg.ty, t);
			arg.binding = None;
		}
	}
}

// WGSL has no point size: drop gl_PointSize from the entry point's result
// struct and from the values spv-in's wrapper composes for it.
fn drop_point_size(module: &mut naga::Module) -> Result<(), String> {
	let is_ps = |b: &Option<naga::Binding>| matches!(b, Some(naga::Binding::BuiltIn(naga::BuiltIn::PointSize)));
	for ep in module.entry_points.iter_mut() {
		let Some(res) = ep.function.result.as_mut() else { continue };
		if is_ps(&res.binding) {
			return Err("gl_PointSize as the only vertex output".into());
		}
		let ty = res.ty;
		let t = &module.types[ty];
		let TypeInner::Struct { members, span } = &t.inner else { continue };
		let Some(idx) = members.iter().position(|m| is_ps(&m.binding)) else { continue };
		let mut members = members.clone();
		members.remove(idx);
		let new = naga::Type { name: t.name.clone(), inner: TypeInner::Struct { members, span: *span } };
		replace_type(&mut module.types, ty, new);
		for (_, e) in ep.function.expressions.iter_mut() {
			if let naga::Expression::Compose { ty: cty, components } = e {
				if *cty == ty {
					components.remove(idx);
				}
			}
		}
	}
	// Other structs (gl_PerVertex as a private variable) keep the member
	// but lose the builtin decoration, which the WGSL writer rejects.
	let fix: Vec<_> = module
		.types
		.iter()
		.filter(|(_, t)| matches!(&t.inner, TypeInner::Struct { members, .. } if members.iter().any(|m| is_ps(&m.binding))))
		.map(|(h, _)| h)
		.collect();
	for h in fix {
		let mut t = module.types[h].clone();
		if let TypeInner::Struct { members, .. } = &mut t.inner {
			for m in members.iter_mut() {
				if is_ps(&m.binding) {
					m.binding = None;
				}
			}
		}
		replace_type(&mut module.types, h, t);
	}
	Ok(())
}

// spv-in copies a compute shader's builtins (workgroup_id, ...) into
// private globals and calls the real `main` from a wrapper. Tint treats
// every private load as non-uniform, so a barrier after
// `if (row >= n) return;` on a workgroup_id-derived row fails WGSL's
// uniformity rule (llama.cpp's norm, soft_max, matmul). The wrapper is
// replaced by the inner function's body, with those globals read through
// function-local variables set from the arguments (flow-tracked by Tint).
// The private globals are still written for the helpers that read them.
fn inline_compute_main(module: &mut naga::Module) -> bool {
	use naga::{Expression, Statement};
	let mut done = false;
	for ep in module.entry_points.iter_mut() {
		let body: Vec<&Statement> = ep.function.body.iter().collect();
		let mut stores: Vec<(naga::Handle<naga::GlobalVariable>, u32)> = Vec::new();
		let mut callee = None;
		for st in body {
			match st {
				Statement::Store { pointer, value } => {
					match (&ep.function.expressions[*pointer], &ep.function.expressions[*value]) {
						(Expression::GlobalVariable(g), Expression::FunctionArgument(i)) => stores.push((*g, *i)),
						_ => {}
					}
				}
				Statement::Call { function, arguments, result: None } if arguments.is_empty() && callee.is_none() => callee = Some(*function),
				Statement::Emit(_) | Statement::Return { value: None } => {}
				_ => return done,
			}
		}
		let Some(f) = callee else { continue };
		let mut new = module.functions[f].clone();
		new.name = ep.function.name.clone();
		new.arguments = ep.function.arguments.clone();
		new.result = None;
		let mut pre = Vec::new();
		for (g, i) in stores {
			let ty = module.global_variables[g].ty;
			let l = new.local_variables.append(naga::LocalVariable { name: module.global_variables[g].name.clone(), ty, init: None }, naga::Span::UNDEFINED);
			for (_, e) in new.expressions.iter_mut() {
				if matches!(e, Expression::GlobalVariable(h) if *h == g) {
					*e = Expression::LocalVariable(l);
				}
			}
			let arg = new.expressions.append(Expression::FunctionArgument(i), naga::Span::UNDEFINED);
			let lp = new.expressions.append(Expression::LocalVariable(l), naga::Span::UNDEFINED);
			let gp = new.expressions.append(Expression::GlobalVariable(g), naga::Span::UNDEFINED);
			pre.push(Statement::Store { pointer: lp, value: arg });
			pre.push(Statement::Store { pointer: gp, value: arg });
		}
		let mut b = naga::Block::from_vec(pre);
		b.extend_block(std::mem::take(&mut new.body));
		new.body = b;
		ep.function = new;
		done = true;
	}
	done
}

// A compute workgroup larger than the device allows (ggml hardcodes 512,
// SwiftShader's WebGPU allows 256): when the shader depends on the
// workgroup only through global_invocation_id (no local/workgroup ids, no
// workgroup memory, barriers or subgroups), shrink each axis by a power
// of two; the host multiplies the dispatch by the returned factors, which
// gives exactly the same global invocation ids.
fn fit_workgroup(wgsl: &mut String, l: [u32; 4]) -> Result<Option<[u32; 3]>, String> {
	let Some(at) = wgsl.find("@workgroup_size(") else { return Ok(None) };
	let start = at + "@workgroup_size(".len();
	let end = start + wgsl[start..].find(')').ok_or("workgroup_size")?;
	let mut size: Vec<u32> = wgsl[start..end].split(',').filter_map(|x| x.trim().trim_end_matches('u').parse().ok()).collect();
	if size.is_empty() {
		return Ok(None);
	}
	size.resize(3, 1);
	let fits = |s: &[u32]| s[0] <= l[0] && s[1] <= l[1] && s[2] <= l[2] && s[0] * s[1] * s[2] <= l[3];
	if fits(&size) {
		return Ok(None);
	}
	let what = format!(
		"workgroup size {}x{}x{} exceeds the device's limits (maxComputeWorkgroupSize {}x{}x{}, maxComputeInvocationsPerWorkgroup {})",
		size[0], size[1], size[2], l[0], l[1], l[2], l[3]
	);
	for t in ["var<workgroup>", "Barrier(", "workgroupUniformLoad", "subgroup"] {
		if wgsl.contains(t) {
			return Err(format!("{} and the shader uses {} (cannot split its workgroups)", what, t.trim_end_matches('(')));
		}
	}
	let mut k = [1u32; 3];
	for a in 0..3 {
		while size[a] / k[a] > l[a] && size[a] % (k[a] * 2) == 0 {
			k[a] *= 2;
		}
	}
	while !fits(&[size[0] / k[0], size[1] / k[1], size[2] / k[2]]) {
		// The total still too large: halve the largest axis that can be.
		let a = (0..3).filter(|&a| size[a] % (k[a] * 2) == 0 && size[a] / k[a] > 1).max_by_key(|&a| size[a] / k[a]);
		match a {
			Some(a) => k[a] *= 2,
			None => return Err(format!("{} (not divisible by a power of two to fit)", what)),
		}
	}
	let new = format!("{}, {}, {}", size[0] / k[0], size[1] / k[1], size[2] / k[2]);
	wgsl.replace_range(start..end, &new);
	derive_workgroup_builtins(wgsl, end, [size[0], size[1], size[2]], k)?;
	Ok(Some(k))
}

// After a split, the entry point's local_invocation_id/index, workgroup_id
// and num_workgroups parameters are recomputed from global_invocation_id
// and the ORIGINAL local size S: local = gid % S, group = gid / S,
// num_workgroups = the split's num_workgroups / k (exact: the host
// dispatched count * k). Barriers, workgroup memory and subgroups are
// refused before this (they need the real workgroup).
fn derive_workgroup_builtins(wgsl: &mut String, from: usize, sz: [u32; 3], k: [u32; 3]) -> Result<(), String> {
	let fn_at = from + wgsl[from..].find("fn ").ok_or("entry fn")?;
	let open = fn_at + wgsl[fn_at..].find('(').ok_or("entry (")?;
	let mut depth = 0;
	let mut close = open;
	for (i, c) in wgsl[open..].char_indices() {
		match c {
			'(' => depth += 1,
			')' => {
				depth -= 1;
				if depth == 0 {
					close = open + i;
					break;
				}
			}
			_ => {}
		}
	}
	let params_text = wgsl[open + 1..close].to_string();
	let mut params: Vec<String> = Vec::new();
	let (mut cur, mut d) = (String::new(), 0);
	for c in params_text.chars() {
		match c {
			'<' | '(' => d += 1,
			'>' | ')' => d -= 1,
			_ => {}
		}
		if c == ',' && d == 0 {
			params.push(cur.trim().to_string());
			cur.clear();
		} else {
			cur.push(c);
		}
	}
	if !cur.trim().is_empty() {
		params.push(cur.trim().to_string());
	}
	let name_of = |p: &str| p.rsplit_once(')').map(|x| x.1).unwrap_or(p).split(':').next().unwrap_or("").trim().to_string();
	let derived = ["local_invocation_id", "local_invocation_index", "workgroup_id", "num_workgroups"];
	if !params.iter().any(|p| derived.iter().any(|b| p.contains(&format!("@builtin({})", b)))) {
		return Ok(());
	}
	let mut gid = params.iter().find(|p| p.contains("@builtin(global_invocation_id)")).map(|p| name_of(p));
	let mut keep: Vec<String> = Vec::new();
	let mut lets = String::new();
	let s = format!("vec3<u32>({}u, {}u, {}u)", sz[0], sz[1], sz[2]);
	for p in &params {
		if let Some(b) = derived.iter().find(|b| p.contains(&format!("@builtin({})", b))) {
			let n = name_of(p);
			let g = gid.get_or_insert_with(|| "kwvk_gid".to_string()).clone();
			let e = match *b {
				"local_invocation_id" => format!("{} % {}", g, s),
				"workgroup_id" => format!("{} / {}", g, s),
				"local_invocation_index" => format!("dot({} % {}, vec3<u32>(1u, {}u, {}u))", g, s, sz[0], sz[0] * sz[1]),
				_ => {
					keep.push("@builtin(num_workgroups) kwvk_nwg: vec3<u32>".to_string());
					format!("kwvk_nwg / vec3<u32>({}u, {}u, {}u)", k[0], k[1], k[2])
				}
			};
			let _ = writeln!(lets, "    let {} = {};", n, e);
		} else {
			keep.push(p.clone());
		}
	}
	if gid.as_deref() == Some("kwvk_gid") && !keep.iter().any(|p| p.contains("@builtin(global_invocation_id)")) {
		keep.push("@builtin(global_invocation_id) kwvk_gid: vec3<u32>".to_string());
	}
	let body = close + wgsl[close..].find('{').ok_or("entry body")? + 1;
	wgsl.insert_str(body, &format!("\n{}", lets));
	wgsl.replace_range(open + 1..close, &keep.join(", "));
	Ok(())
}

fn prune_constant_ifs(block: &mut naga::Block, ex: &naga::Arena<naga::Expression>, consts: &naga::Arena<naga::Constant>, gexp: &naga::Arena<naga::Expression>) {
	let value = |h: naga::Handle<naga::Expression>| -> Option<bool> {
		match &ex[h] {
			naga::Expression::Literal(naga::Literal::Bool(b)) => Some(*b),
			naga::Expression::Constant(c) => match gexp[consts[*c].init] {
				naga::Expression::Literal(naga::Literal::Bool(b)) => Some(b),
				_ => None,
			},
			_ => None,
		}
	};
	for st in block.iter_mut() {
		if let naga::Statement::If { condition, accept, reject } = st {
			if let Some(b) = value(*condition) {
				let mut keep = std::mem::take(if b { accept } else { reject });
				prune_constant_ifs(&mut keep, ex, consts, gexp);
				*st = naga::Statement::Block(keep);
				continue;
			}
		}
		match st {
			naga::Statement::Block(b) => prune_constant_ifs(b, ex, consts, gexp),
			naga::Statement::If { accept, reject, .. } => {
				prune_constant_ifs(accept, ex, consts, gexp);
				prune_constant_ifs(reject, ex, consts, gexp);
			}
			naga::Statement::Loop { body, continuing, .. } => {
				prune_constant_ifs(body, ex, consts, gexp);
				prune_constant_ifs(continuing, ex, consts, gexp);
			}
			naga::Statement::Switch { cases, .. } => {
				for c in cases.iter_mut() {
					prune_constant_ifs(&mut c.body, ex, consts, gexp);
				}
			}
			_ => {}
		}
	}
}

// UniqueArena::replace panics when the new type already exists (unchanged,
// or equal to another): skip the former, give the latter a distinct name.
fn replace_type(types: &mut naga::UniqueArena<naga::Type>, h: naga::Handle<naga::Type>, mut t: naga::Type) {
	if types[h] == t {
		return;
	}
	while types.get(&t).is_some() {
		t.name = Some(format!("{}_", t.name.as_deref().unwrap_or("T")));
	}
	types.replace(h, t);
}

fn json_str(s: &mut String, v: &str) {
	s.push('"');
	for c in v.chars() {
		match c {
			'"' => s.push_str("\\\""),
			'\\' => s.push_str("\\\\"),
			'\n' => s.push_str("\\n"),
			'\r' => s.push_str("\\r"),
			'\t' => s.push_str("\\t"),
			c if (c as u32) < 0x20 => {
				let _ = write!(s, "\\u{:04x}", c as u32);
			}
			c => s.push(c),
		}
	}
	s.push('"');
}

#[cfg(test)]
mod tests {
	// KWVK_SPV=file.spv KWVK_OPTS='stage=compute' cargo test -- --nocapture
	// (native, so a naga panic shows its message and location).
	#[test]
	fn translate_file() {
		let Ok(f) = std::env::var("KWVK_SPV") else { return };
		let spv = std::fs::read(f).unwrap();
		let opts = std::env::var("KWVK_OPTS").unwrap_or_default().replace(';', "\n");
		match super::translate(&spv, &super::Opts::parse(&opts)) {
			Ok(s) => println!("{}", &s[..s.len().min(200)]),
			Err(e) => println!("error: {}", e),
		}
	}
}
