import { tool, type Plugin } from "@kilocode/plugin";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// TCP client – communicates with the Blender add‑on server
// ---------------------------------------------------------------------------
const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 9876;
const TIMEOUT = 300_000;

function getHost(): string {
  return process.env.BLENDER_MCP_HOST ?? DEFAULT_HOST;
}
function getPort(): number {
  return parseInt(process.env.BLENDER_MCP_PORT ?? String(DEFAULT_PORT), 10);
}

const _PKG_DIR = dirname(fileURLToPath(import.meta.url));
const _DATA_DIR = join(_PKG_DIR, "..", "data");
const _API_DIR = join(_DATA_DIR, "api");
const _MANUAL_DIR = join(_DATA_DIR, "manual");

async function sendCode(
  code: string,
  strictJson: boolean,
): Promise<Record<string, unknown>> {
  const host = getHost();
  const port = getPort();
  const request =
    JSON.stringify({ type: "execute", code, strict_json: strictJson }) + "\0";

  return new Promise((resolve, reject) => {
    const sock = connect({ host, port }, () => {
      sock.write(request, "utf-8");
    });
    sock.setTimeout(TIMEOUT);
    const buf: Buffer[] = [];
    sock.on("data", (chunk) => {
      buf.push(chunk);
      const full = Buffer.concat(buf);
      if (full.includes(0)) {
        sock.end();
      }
    });
    sock.on("end", () => {
      const full = Buffer.concat(buf);
      const nulIdx = full.indexOf(0);
      const line = nulIdx >= 0 ? full.subarray(0, nulIdx) : full;
      try {
        resolve(JSON.parse(line.toString("utf-8")));
      } catch (e: unknown) {
        reject(
          new Error(
            `Invalid JSON from Blender: ${(e as Error).message}`,
          ),
        );
      }
    });
    sock.on("error", (err) => {
      reject(
        new ConnectionError(
          `Cannot connect to Blender at ${host}:${port} – ${err.message}`,
        ),
      );
    });
    sock.on("timeout", () => {
      sock.destroy();
      reject(
        new ConnectionError(`Blender connection timed out at ${host}:${port}`),
      );
    });
  });
}

class ConnectionError extends Error {
  override name = "ConnectionError";
}

// ---------------------------------------------------------------------------
// Helpers to build tool‑code strings
// ---------------------------------------------------------------------------
const IMAGE_DOWNSCALE = `
def _image_downscale_to_size_limit(
        tmpdir, filepath,
        size_limit_in_bytes,
        size_tolerance_in_bytes = 0,
):
    import os
    if os.path.getsize(filepath) <= size_limit_in_bytes:
        with open(filepath, "rb") as fh:
            return fh.read()
    import imbuf
    from bpy import context
    filepath_out = os.path.join(tmpdir, "downscaled.png")
    im = imbuf.load(filepath)
    pixel_size = context.preferences.system.pixel_size
    if pixel_size > 1.0:
        w, h = im.size
        im.resize((round(w / pixel_size), round(h / pixel_size)), method='BILINEAR')
    def _write_and_read(im_buf):
        imbuf.write(im_buf, filepath=filepath_out)
        with open(filepath_out, "rb") as fh:
            return fh.read()
    def _encode_at_divisor(divisor):
        new_w = orig_w // divisor
        new_h = orig_h // divisor
        if new_w <= 64 or new_h <= 64:
            return None
        im_copy = im.copy()
        im_copy.resize((new_w, new_h), method='BILINEAR')
        result = _write_and_read(im_copy)
        im_copy.free()
        return result
    try:
        data = _write_and_read(im)
        if len(data) <= size_limit_in_bytes:
            return data
        divisors = (2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64)
        orig_w, orig_h = im.size
        max_idx = -1
        for i, d in enumerate(divisors):
            if orig_w // d > 64 and orig_h // d > 64:
                max_idx = i
            else:
                break
        if max_idx < 0:
            return data
        import math
        lo, hi = 0, max_idx
        estimated = math.sqrt(len(data) / size_limit_in_bytes)
        while lo <= hi:
            if hi - lo >= 2:
                mid = min(hi - 1, max(lo + 1, min(
                    range(lo, hi + 1),
                    key=lambda i: abs(divisors[i] - estimated),
                )))
            else:
                mid = (lo + hi) // 2
            test_filedata_as_bytes = _encode_at_divisor(divisors[mid])
            if test_filedata_as_bytes is not None and len(test_filedata_as_bytes) <= size_limit_in_bytes:
                data = test_filedata_as_bytes
                if len(test_filedata_as_bytes) == size_limit_in_bytes:
                    break
                if size_tolerance_in_bytes > 0:
                    if len(test_filedata_as_bytes) < size_limit_in_bytes:
                        if len(test_filedata_as_bytes) >= size_limit_in_bytes - size_tolerance_in_bytes:
                            break
                hi = mid - 1
                estimated = divisors[mid] * math.sqrt(len(test_filedata_as_bytes) / size_limit_in_bytes)
            else:
                lo = mid + 1
                if test_filedata_as_bytes is not None:
                    estimated = divisors[mid] * math.sqrt(len(test_filedata_as_bytes) / size_limit_in_bytes)
    finally:
        im.free()
    return data
`;

const DEFERRED_CHECK = `
def _deferred_tool_check_for_file_output(
        job_type, output_path,
        restore_attrs = None,
):
    import os
    import bpy
    def check_is_finished():
        if bpy.app.is_job_running(job_type):
            return None
        if restore_attrs is not None:
            for obj, attr, value in restore_attrs:
                setattr(obj, attr, value)
        if os.path.exists(output_path):
            return {"status": "ok", "filepath": output_path}
        return {"status": "error", "message": "Job completed but output file was not created"}
    return check_is_finished
`;

const BACKUP_ATTRS_ASSIGN = `
import contextlib
@contextlib.contextmanager
def _backup_attrs_and_assign_multi(*obj_attrs):
    saved = []
    try:
        for obj, attrs in obj_attrs:
            saved.append((obj, {attr: getattr(obj, attr) for attr in attrs}))
            for attr, value in attrs.items():
                setattr(obj, attr, value)
        yield
    finally:
        for obj, attrs in saved:
            for attr, value in attrs.items():
                setattr(obj, attr, value)
`;

// ---------------------------------------------------------------------------
// Helpers to inject args into Python code
// ---------------------------------------------------------------------------
function pyBool(v: unknown): string {
  return v ? "True" : "False";
}

function spawnProcess(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------
const BlenderPlugin: Plugin = async () => {
  return {
    tool: {
      // --- execute_blender_code ---
      blender_execute_blender_code: tool({
        description:
          "Execute Python code in the connected Blender instance. " +
          "The code runs in Blender's Python environment with full access to bpy. " +
          "To return data, assign a JSON-serialisable dict to a variable named result. " +
          "Deferred completion via check_is_finished is only supported by the interactive addon server.",
        args: {
          code: tool.schema.string().describe("Python code to execute in Blender"),
        },
        async execute(args) {
          const resp = await sendCode(args.code, false);
          return JSON.stringify(resp);
        },
      }),

      // --- execute_blender_code_for_cli ---
      blender_execute_blender_code_for_cli: tool({
        description:
          "Execute Python code in a background Blender process. " +
          "Opens blend_file with blender --background and runs code. " +
          "Assign a dict to result to return data.",
        args: {
          blend_file: tool.schema.string().describe("Path to the .blend file to open"),
          code: tool.schema.string().describe("Python code to execute"),
        },
        async execute(args) {
          const pythonCode = `
import bpy, json, sys
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(args.blend_file)})
namespace = {"result": {}}
exec(${JSON.stringify(args.code)}, namespace)
print(json.dumps(namespace["result"], default=repr))
`;
          const blenderBin = process.env.BLENDER_BIN ?? "blender";
          const { stdout: out, stderr: err, exitCode } = await spawnProcess(blenderBin, [
            "--background",
            args.blend_file,
            "--python-expr",
            pythonCode,
          ]);
          if (exitCode !== 0) {
            return JSON.stringify({ status: "error", message: err || `Exit code ${exitCode}` });
          }
          try {
            return JSON.stringify(JSON.parse(out.trim().split("\n").pop() ?? "{}"));
          } catch {
            return JSON.stringify({ status: "error", message: `Invalid output: ${out.slice(0, 200)}` });
          }
        },
      }),

      // --- get_blendfile_summary_datablocks ---
      blender_get_blendfile_summary_datablocks: tool({
        description: "Return a summary of the blend file: data-block counts, active workspace, and render engine.",
        args: {},
        async execute() {
          const code = `
from typing import NamedTuple
class Result(NamedTuple):
    status: str
    datablock_counts: dict[str, int]
    render_engine: str
    scene_name: str
    workspaces: list[str]
    active_workspace: str | None
def main(params: None) -> Result:
    del params
    import bpy
    counts = {}
    for attr in sorted(dir(bpy.data)):
        val = getattr(bpy.data, attr, None)
        if hasattr(val, "__len__") and hasattr(val, "keys"):
            try:
                n = len(val)
                if n > 0:
                    counts[attr] = n
            except Exception:
                pass
    window = getattr(bpy.context, "window", None)
    return Result(
        status="ok",
        datablock_counts=counts,
        render_engine=bpy.context.scene.render.engine,
        scene_name=bpy.context.scene.name,
        workspaces=[ws.name for ws in bpy.data.workspaces],
        active_workspace=window.workspace.name if window else None,
    )
_rv = main(None)
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_blendfile_summary_datablocks_for_cli ---
      blender_get_blendfile_summary_datablocks_for_cli: tool({
        description: "Return a data-block summary by opening blend_file in background Blender.",
        args: {
          blend_file: tool.schema.string().describe("Path to the .blend file"),
        },
        async execute(args) {
          const pythonCode = `
import bpy, json
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(args.blend_file)})
counts = {}
for attr in sorted(dir(bpy.data)):
    val = getattr(bpy.data, attr, None)
    if hasattr(val, "__len__") and hasattr(val, "keys"):
        try:
            n = len(val)
            if n > 0:
                counts[attr] = n
        except Exception:
            pass
window = getattr(bpy.context, "window", None)
result = {
    "status": "ok",
    "datablock_counts": counts,
    "render_engine": bpy.context.scene.render.engine,
    "scene_name": bpy.context.scene.name,
    "workspaces": [ws.name for ws in bpy.data.workspaces],
    "active_workspace": window.workspace.name if window else None,
}
print(json.dumps(result))
`;
          const blenderBin = process.env.BLENDER_BIN ?? "blender";
          const { stdout: out, stderr: err, exitCode } = await spawnProcess(blenderBin, [
            "--background", args.blend_file,
            "--python-expr", pythonCode,
          ]);
          if (exitCode !== 0) return JSON.stringify({ status: "error", message: err || `Exit code ${exitCode}` });
          try { return JSON.stringify(JSON.parse(out.trim().split("\n").pop() ?? "{}")); }
          catch { return JSON.stringify({ status: "error", message: `Invalid output: ${out.slice(0, 200)}` }); }
        },
      }),

      // --- get_blendfile_summary_missing_files ---
      blender_get_blendfile_summary_missing_files: tool({
        description: "Report external file references that are missing from disk (images, libraries, fonts, sounds, movie clips, caches, sequences).",
        args: {},
        async execute() {
          const code = `
from typing import NamedTuple
import os
class Result(NamedTuple):
    status: str
    missing_files: list[dict[str, str]]
    total_checked: int
def _visit(id_data, path, _placeholder):
    global _checked, _missing
    _checked += 1
    filepath = bpy.path.abspath(path)
    if not os.path.exists(filepath):
        _missing.append({"id_type": type(id_data).__name__, "id_name": getattr(id_data, "name", ""), "path": filepath})
_checked = 0
_missing = []
import bpy
bpy.data.file_path_foreach(_visit, flags={"SKIP_PACKED", "SKIP_WEAK_REFERENCES", "RESOLVE_TOKEN"})
result = {"status": "ok", "missing_files": _missing, "total_checked": _checked}
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_blendfile_summary_missing_files_for_cli ---
      blender_get_blendfile_summary_missing_files_for_cli: tool({
        description: "Report missing file references by opening blend_file in background Blender.",
        args: { blend_file: tool.schema.string().describe("Path to the .blend file") },
        async execute(args) {
          const pythonCode = `
import bpy, json, os
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(args.blend_file)})
missing = []
checked = 0
def _visit(id_data, path, _p):
    global checked, missing
    checked += 1
    fp = bpy.path.abspath(path)
    if not os.path.exists(fp):
        missing.append({"id_type": type(id_data).__name__, "id_name": getattr(id_data, "name", ""), "path": fp})
bpy.data.file_path_foreach(_visit, flags={"SKIP_PACKED", "SKIP_WEAK_REFERENCES", "RESOLVE_TOKEN"})
print(json.dumps({"status": "ok", "missing_files": missing, "total_checked": checked}))
`;
          const blenderBin = process.env.BLENDER_BIN ?? "blender";
          const { stdout: out, stderr: err, exitCode } = await spawnProcess(blenderBin, ["--background", args.blend_file, "--python-expr", pythonCode]);
          if (exitCode !== 0) return JSON.stringify({ status: "error", message: err || `Exit code ${exitCode}` });
          try { return JSON.stringify(JSON.parse(out.trim().split("\n").pop() ?? "{}")); }
          catch { return JSON.stringify({ status: "error", message: `Invalid output: ${out.slice(0, 200)}` }); }
        },
      }),

      // --- get_blendfile_summary_of_linked_libraries ---
      blender_get_blendfile_summary_of_linked_libraries: tool({
        description: "Return a tree of directly and indirectly linked library files.",
        args: {},
        async execute() {
          const code = `
from typing import NamedTuple
class Result(NamedTuple):
    status: str
    direct_libraries: list[dict[str, object]]
    indirect_libraries: list[dict[str, object]]
    total_library_count: int
def main(params: None) -> Result:
    del params
    import bpy
    direct, indirect = [], []
    for lib in bpy.data.libraries:
        info = {"filepath": lib.filepath, "name": lib.name}
        count = 0
        for attr in dir(bpy.data):
            collection = getattr(bpy.data, attr, None)
            if not hasattr(collection, "__iter__"):
                continue
            try:
                for item in collection:
                    if hasattr(item, "library") and item.library == lib:
                        count += 1
            except Exception:
                pass
        info["linked_datablocks_count"] = count
        if lib.parent is None:
            direct.append(info)
        else:
            info["parent_library"] = lib.parent.name
            indirect.append(info)
    return Result(status="ok", direct_libraries=direct, indirect_libraries=indirect, total_library_count=len(bpy.data.libraries))
_rv = main(None)
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_blendfile_summary_of_linked_libraries_for_cli ---
      blender_get_blendfile_summary_of_linked_libraries_for_cli: tool({
        description: "Return linked-library info by opening blend_file in background Blender.",
        args: { blend_file: tool.schema.string().describe("Path to the .blend file") },
        async execute(args) {
          const pythonCode = `
import bpy, json
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(args.blend_file)})
direct, indirect = [], []
for lib in bpy.data.libraries:
    info = {"filepath": lib.filepath, "name": lib.name}
    count = 0
    for attr in dir(bpy.data):
        collection = getattr(bpy.data, attr, None)
        if not hasattr(collection, "__iter__"):
            continue
        try:
            for item in collection:
                if hasattr(item, "library") and item.library == lib:
                    count += 1
        except Exception:
            pass
    info["linked_datablocks_count"] = count
    if lib.parent is None:
        direct.append(info)
    else:
        info["parent_library"] = lib.parent.name
        indirect.append(info)
print(json.dumps({"status": "ok", "direct_libraries": direct, "indirect_libraries": indirect, "total_library_count": len(bpy.data.libraries)}))
`;
          const blenderBin = process.env.BLENDER_BIN ?? "blender";
          const { stdout: out, stderr: err, exitCode } = await spawnProcess(blenderBin, ["--background", args.blend_file, "--python-expr", pythonCode]);
          if (exitCode !== 0) return JSON.stringify({ status: "error", message: err || `Exit code ${exitCode}` });
          try { return JSON.stringify(JSON.parse(out.trim().split("\n").pop() ?? "{}")); }
          catch { return JSON.stringify({ status: "error", message: `Invalid output: ${out.slice(0, 200)}` }); }
        },
      }),

      // --- get_blendfile_summary_path_info ---
      blender_get_blendfile_summary_path_info: tool({
        description: "Simple/fast access to the blend file's path, save status, age, and backups.",
        args: {},
        async execute() {
          const code = `
from typing import NamedTuple
import os, time
class Result(NamedTuple):
    status: str
    filepath: str
    is_saved: bool
    is_dirty: bool
    age_seconds: float | None
    file_size_bytes: int | None
    backups: list[dict[str, object]] | None
def main(params: None) -> Result:
    del params
    import bpy
    filepath = bpy.data.filepath
    age, size, backups = None, None, None
    if filepath and os.path.exists(filepath):
        stat = os.stat(filepath)
        age = round(time.time() - stat.st_mtime, 1)
        size = stat.st_size
        backups = []
        for i in range(1, 33):
            bp = filepath + str(i)
            if not os.path.exists(bp): break
            bs = os.stat(bp)
            backups.append({"path": bp, "age_seconds": round(time.time() - bs.st_mtime, 1), "size_bytes": bs.st_size})
    return Result(status="ok", filepath=filepath, is_saved=bool(filepath), is_dirty=bpy.data.is_dirty, age_seconds=age, file_size_bytes=size, backups=backups)
_rv = main(None)
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_blendfile_summary_path_info_for_cli ---
      blender_get_blendfile_summary_path_info_for_cli: tool({
        description: "Return path info by opening blend_file in background Blender.",
        args: { blend_file: tool.schema.string().describe("Path to the .blend file") },
        async execute(args) {
          const pythonCode = `
import bpy, json, os, time
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(args.blend_file)})
fp = bpy.data.filepath
age, size, backups = None, None, None
if fp and os.path.exists(fp):
    s = os.stat(fp)
    age = round(time.time() - s.st_mtime, 1)
    size = s.st_size
    backups = []
    for i in range(1, 33):
        bp = fp + str(i)
        if not os.path.exists(bp): break
        bs = os.stat(bp)
        backups.append({"path": bp, "age_seconds": round(time.time() - bs.st_mtime, 1), "size_bytes": bs.st_size})
print(json.dumps({"status": "ok", "filepath": fp, "is_saved": bool(fp), "is_dirty": bpy.data.is_dirty, "age_seconds": age, "file_size_bytes": size, "backups": backups}))
`;
          const blenderBin = process.env.BLENDER_BIN ?? "blender";
          const { stdout: out, stderr: err, exitCode } = await spawnProcess(blenderBin, ["--background", args.blend_file, "--python-expr", pythonCode]);
          if (exitCode !== 0) return JSON.stringify({ status: "error", message: err || `Exit code ${exitCode}` });
          try { return JSON.stringify(JSON.parse(out.trim().split("\n").pop() ?? "{}")); }
          catch { return JSON.stringify({ status: "error", message: `Invalid output: ${out.slice(0, 200)}` }); }
        },
      }),

      // --- get_blendfile_summary_usage_guess ---
      blender_get_blendfile_summary_usage_guess: tool({
        description: "Guess the primary use-cases of the current blend file (scored 0-100 with certainty).",
        args: {},
        async execute() {
          const code = `
from typing import NamedTuple, Any
class Result(NamedTuple):
    status: str
    usage_guesses: dict[str, dict[str, int]]
def _summarize(signals):
    if not signals: return (0, 0)
    n = len(signals)
    return (round(100 * sum(c for c,_ in signals) / n), round(100 * sum(k for _,k in signals) / n))
def _summarize_as_dict(use_case, signals):
    s, c = _summarize(signals)
    return (use_case, {"score": s, "certainty": c})
def _usage_probability_for_animation(data, scene):
    del scene
    signals = [(float(bool(data.actions)), 1.0), (float(bool(data.armatures)), 1.0), (float(any(bool(obj.constraints) for obj in data.objects)), 0.5)]
    return _summarize_as_dict("Animation", signals)
def _usage_probability_for_rendering(data, scene):
    del data
    signals = [(float(scene.render.engine not in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE")), 0.5), (float(scene.render.filepath not in ("/tmp/", "/tmp\\\\", "")), 0.8)]
    nt = getattr(scene, "node_tree", None)
    signals.append((float(bool(nt and any(n.type == "R_LAYERS" for n in nt.nodes))), 1.0))
    return _summarize_as_dict("Rendering", signals)
def _usage_probability_for_scripting(data, scene):
    del scene
    return _summarize_as_dict("Scripting", [(float(bool(data.texts)), 1.0)])
def _usage_probability_for_video_editing(data, scene):
    del scene
    has_seq = any(s.sequence_editor and bool(getattr(s.sequence_editor, "strips", ())) for s in data.scenes)
    return _summarize_as_dict("Video Editing", [(float(has_seq), 1.0)])
def _usage_probability_for_modeling(data, scene):
    del scene
    non_default = [m for m in data.meshes if m.name != "Cube" or len(m.vertices) != 8]
    signals = [(float(bool(non_default)), 0.8), (float(bool(non_default and any(len(m.uv_layers) > 1 or bool(m.color_attributes) for m in non_default))), 0.7), (float(bool(data.curves) or bool(data.metaballs)), 0.7), (float(any(bool(obj.modifiers) for obj in data.objects)), 0.5)]
    return _summarize_as_dict("Modeling", signals)
def _usage_probability_for_grease_pencil(data, scene):
    del scene
    return _summarize_as_dict("Grease Pencil", [(float(bool(data.grease_pencils)), 1.0)])
def _usage_probability_for_geometry_nodes(data, scene):
    del scene
    has_gn = any(any(mod.type == "NODES" and mod.node_group for mod in obj.modifiers) for obj in data.objects)
    return _summarize_as_dict("Geometry Nodes", [(float(has_gn), 1.0)])
def _usage_probability_for_compositing(data, scene):
    del data
    nt = getattr(scene, "node_tree", None)
    return _summarize_as_dict("Compositing", [(float(bool(nt and scene.use_nodes and len(nt.nodes) > 2)), 1.0)])
def _usage_probability_for_uv_unwrapping(data, scene):
    del scene
    signals = [(float(any(len(m.uv_layers) > 1 for m in data.meshes)), 1.0), (float(any(any(uv.name != "UVMap" for uv in m.uv_layers) for m in data.meshes)), 0.7), (float(any(mat.node_tree and any(n.type == "TEX_IMAGE" and n.image for n in mat.node_tree.nodes) for mat in data.materials)), 0.7)]
    return _summarize_as_dict("UV Unwrapping", signals)
def _usage_probability_for_motion_tracking(data, scene):
    del scene
    return _summarize_as_dict("Motion Tracking", [(float(bool(data.movieclips)), 1.0)])
def _usage_probability_for_audio(data, scene):
    del scene
    return _summarize_as_dict("Audio", [(float(bool(data.sounds)), 1.0), (float(bool(data.speakers)), 1.0)])
def main(params: None) -> Result:
    del params
    import bpy
    data, scene = bpy.data, bpy.context.scene
    usages = {}
    for fn in [_usage_probability_for_animation, _usage_probability_for_rendering, _usage_probability_for_scripting, _usage_probability_for_video_editing, _usage_probability_for_modeling, _usage_probability_for_grease_pencil, _usage_probability_for_geometry_nodes, _usage_probability_for_compositing, _usage_probability_for_uv_unwrapping, _usage_probability_for_motion_tracking, _usage_probability_for_audio]:
        uc, scores = fn(data, scene)
        usages[uc] = scores
    return Result(status="ok", usage_guesses=usages)
_rv = main(None)
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_objects_summary ---
      blender_get_objects_summary: tool({
        description: "Return the scene's collection hierarchy and their objects.",
        args: {},
        async execute() {
          const code = `
from typing import NamedTuple, Any
class Result(NamedTuple):
    status: str
    scene_name: str
    active_workspace: str | None
    active_object: str | None
    object_mode: str | None
    camera_object: str | None
    collections: list[dict[str, Any]]
def _object_info(obj):
    info = {"name": obj.name, "type": obj.type, "parent": obj.parent.name if obj.parent else None, "data_name": obj.data.name if obj.data else None, "selected": obj.select_get(), "visible": obj.visible_get(), "hide_viewport": obj.hide_get()}
    if obj.type == "EMPTY" and obj.instance_type == "COLLECTION" and obj.instance_collection is not None:
        info["instance_collection"] = obj.instance_collection.name
    return info
def _layer_collection_tree(lc):
    col = lc.collection
    return {"name": col.name, "exclude": lc.exclude, "hide_viewport": col.hide_viewport, "objects": sorted([_object_info(obj) for obj in col.objects], key=lambda o: o["name"]), "children": sorted([_layer_collection_tree(child) for child in lc.children], key=lambda c: c["name"])}
def main(params: None) -> Result:
    del params
    from bpy import context
    scene, view_layer = context.scene, context.view_layer
    root = view_layer.layer_collection
    collections = sorted([_layer_collection_tree(root)], key=lambda c: c["name"])
    active = view_layer.objects.active
    window = getattr(context, "window", None)
    return Result(status="ok", scene_name=scene.name, active_workspace=window.workspace.name if window else None, active_object=active.name if active else None, object_mode=context.mode if active else None, camera_object=scene.camera.name if scene.camera else None, collections=collections)
_rv = main(None)
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_object_detail_summary ---
      blender_get_object_detail_summary: tool({
        description: "Return a structured summary of the object identified by name. Includes type, transforms, parent, children, modifiers, constraints, materials, visibility, data-block name, and collections.",
        args: {
          name: tool.schema.string().describe("Name of the object to inspect"),
        },
        async execute(args) {
          const code = `
from typing import NamedTuple
class Params(NamedTuple):
    name: str
class Result(NamedTuple):
    status: str
    name: str | None = None; type: str | None = None; location: list[float] | None = None
    rotation: list[float] | None = None; scale: list[float] | None = None
    dimensions: list[float] | None = None; parent: str | None = None
    children: list[str] | None = None; modifiers: list[dict[str, object]] | None = None
    constraints: list[dict[str, object]] | None = None; materials: list[str | None] | None = None
    visibility: dict[str, bool] | None = None; data_name: str | None = None
    collections: list[str] | None = None; message: str | None = None
def main(params: Params) -> Result:
    import bpy
    obj = bpy.data.objects.get(params.name)
    if obj is None:
        available = sorted(bpy.data.objects.keys())
        return Result(status="error", message="Object {!r} not found. Available: {:s}".format(params.name, ", ".join(available) if available else "(none)"))
    return Result(status="ok", name=obj.name, type=obj.type, location=list(obj.location), rotation=list(obj.rotation_euler), scale=list(obj.scale), dimensions=list(obj.dimensions), parent=obj.parent.name if obj.parent else None, children=[child.name for child in obj.children], modifiers=[{"name": m.name, "type": m.type, "show_viewport": m.show_viewport, "show_render": m.show_render} for m in obj.modifiers], constraints=[{"name": c.name, "type": c.type, "enabled": c.enabled} for c in obj.constraints], materials=[s.material.name if s.material else None for s in obj.material_slots], visibility={"hide_viewport": obj.hide_viewport, "hide_render": obj.hide_render, "hide_get": obj.hide_get()}, data_name=obj.data.name if obj.data else None, collections=[col.name for col in obj.users_collection])
_rv = main(Params(${JSON.stringify(args.name)}))
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_python_api_docs ---
      blender_get_python_api_docs: tool({
        description: "Return the Blender Python API docs for identifier, or list modules matching a trailing-* discovery pattern.",
        args: {
          identifier: tool.schema.string().describe("Fully-qualified Python name like bpy.app or bpy.types.Scene.frame_current, or a pattern like * or bpy.*"),
        },
        async execute(args) {
          const pythonCode = `
import json, os, re

API_DIR = ${JSON.stringify(_API_DIR)}
DATA_DIR = ${JSON.stringify(_DATA_DIR)}
TOPN_LEVEL = sorted(os.listdir(DATA_DIR)) if os.path.isdir(DATA_DIR) else []

def _file_for(ident):
    return os.path.join(API_DIR, ident + ".rst")

def _dir_for(ident):
    return os.path.join(API_DIR, ident.replace(".", os.sep))

def _files_matching(prefix):
    return sorted(f[:-4] for f in os.listdir(API_DIR) if f.startswith(prefix + ".") and f.endswith(".rst"))

def _read_rst(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def _extract_examples(content, base_dir):
    examples = []
    for m in re.finditer(r'\\.\\. literalinclude:: (\\S+)', content):
        ep = os.path.join(base_dir, m.group(1))
        if os.path.exists(ep):
            with open(ep, "r", encoding="utf-8") as f:
                examples.append({"path": m.group(1), "content": f.read()[:2000]})
    return examples

DEF_DIR_RE = re.compile(r'\\.\\. (?:class|function|method|attribute|data|property):: (\\S+)')

def _find_defs(content):
    return [m.group(1) for m in DEF_DIR_RE.finditer(content)]

def _list_submodules(parent_dir, parent_id):
    if not os.path.isdir(parent_dir):
        return None
    return sorted(f[:-4] for f in os.listdir(parent_dir) if f.endswith(".rst"))

ident = ${JSON.stringify(args.identifier)}

if ident == "*":
    result = {"kind": "namespace", "found": True, "identifier": "*", "submodules": TOPN_LEVEL}
elif ident.endswith(".*"):
    prefix = ident[:-2]
    sub = _list_submodules(_dir_for(prefix), prefix)
    if sub is not None:
        result = {"kind": "namespace", "found": True, "identifier": ident, "submodules": sub}
    else:
        matched = _files_matching(prefix)
        if matched:
            result = {"kind": "namespace", "found": True, "identifier": ident, "submodules": matched}
        else:
            rst = _file_for(prefix)
            if os.path.exists(rst):
                result = {"kind": "namespace", "found": True, "identifier": ident, "available": _find_defs(_read_rst(rst))}
            else:
                result = {"kind": "missing", "found": False, "identifier": ident}
else:
    rst = _file_for(ident)
    if os.path.exists(rst):
        content = _read_rst(rst)
        examples = _extract_examples(content, API_DIR)
        result = {"kind": "exact", "found": True, "identifier": ident, "content": content[:32000], "examples": examples}
    else:
        parts = ident.split(".")
        result = {"kind": "missing", "found": False, "identifier": ident}
        for i in range(len(parts) - 1, 0, -1):
            parent_rst = _file_for(".".join(parts[:i]))
            if os.path.exists(parent_rst):
                parent_content = _read_rst(parent_rst)
                child = ".".join(parts[i:])
                block_start = parent_content.find(":: " + child)
                if block_start >= 0:
                    block_end = parent_content.find("\\n.. ", block_start)
                    if block_end < 0:
                        block_end = len(parent_content)
                    result = {"kind": "definition", "found": True, "identifier": ident, "content": parent_content[block_start-10:block_end].strip()[:32000]}
                else:
                    parent_id = ".".join(parts[:i])
                    avail = _find_defs(parent_content)
                    subdir = _dir_for(parent_id)
                    submods = []
                    if os.path.isdir(subdir):
                        for f in sorted(os.listdir(subdir)):
                            if f.endswith(".rst"):
                                submods.append(parent_id + "." + f[:-4])
                    result = {"kind": "partial", "found": False, "identifier": ident, "parent": parent_id, "available": avail, "submodules": submods}
                break
`;
          const resp = await sendCode(pythonCode, true);
          return JSON.stringify(resp);
        },
      }),

      // --- search_api_docs ---
      blender_search_api_docs: tool({
        description:
          "Full-text search over the bundled Blender Python API reference. " +
          "Returns a ranked list of hits. Each hit has: path, text, breadcrumb, index, score. " +
          "The query is tokenised on whitespace and matched case-insensitively. " +
          "Read-only; consults bundled RST files only.",
        args: {
          query: tool.schema.string().describe("Search query"),
          max_results: tool.schema.number().optional().default(20).describe("Maximum number of results"),
          context: tool.schema.number().optional().default(0).describe("Number of context paragraphs around each hit"),
        },
        async execute(args) {
          const pythonCode = `
import json, os, re, math

SCOPE_DIR = ${JSON.stringify(_API_DIR)}

_STOPWORDS = frozenset({
    "a", "an", "and", "any", "are", "as", "at", "be", "by", "can",
    "do", "does", "for", "from", "how", "if", "in", "is", "it",
    "its", "not", "of", "on", "or", "that", "the", "this", "to",
    "was", "were", "what", "when", "where", "which", "why", "will",
    "with", "you", "your",
})

def _rst_files(dirpath):
    for dirpath, dirnames, fnames in os.walk(dirpath):
        dirnames.sort()
        for fn in sorted(fnames):
            if fn.endswith(".rst"):
                yield os.path.join(dirpath, fn)

def _tokenize(text):
    return [t for t in text.lower().split() if t and t not in _STOPWORDS]

query = ${JSON.stringify(args.query)}
max_results = max(1, ${JSON.stringify((args as any).max_results ?? 20)})
ctx = max(0, ${JSON.stringify((args as any).context ?? 0)})

tokens = _tokenize(query)
if not tokens:
    result = {"hits": [], "truncated": False}
else:
    patterns = [re.compile(re.escape(t), re.IGNORECASE) for t in tokens]
    n_files = 0
    per_token_df = [0] * len(patterns)
    pre_hits = []

    for fpath in _rst_files(SCOPE_DIR):
        try:
            text = open(fpath, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        n_files += 1
        body_present = [bool(p.search(text)) for p in patterns]
        for i in range(len(patterns)):
            if body_present[i]:
                per_token_df[i] += 1
        if not any(body_present):
            continue
        paragraphs = [p for p in re.split(r'\\n\\n+', text) if p.strip()]
        for idx, para in enumerate(paragraphs):
            counts = [len(p.findall(para)) for p in patterns]
            if any(counts):
                pre_hits.append((fpath, idx, paragraphs, counts))

    if n_files == 0:
        result = {"hits": [], "truncated": False}
    else:
        idfs = [math.log((n_files + 1) / (df + 1)) + 1 for df in per_token_df]
        hits = {}
        for fpath, idx, paragraphs, counts in pre_hits:
            score = sum(c * idf for c, idf in zip(counts, idfs))
            rel = os.path.relpath(fpath, SCOPE_DIR)
            lo = max(0, idx - ctx)
            hi = min(len(paragraphs), idx + ctx + 1)
            text_block = "\\n\\n".join(paragraphs[lo:hi])
            key = (rel, lo)
            existing = hits.get(key)
            if existing:
                existing["score"] += score
            else:
                hits[key] = {"path": rel, "text": text_block, "breadcrumb": "", "score": score, "_idx": idx}
        hit_list = sorted(hits.values(), key=lambda h: -h["score"])
        truncated = len(hit_list) > max_results
        hit_list = hit_list[:max_results]
        for i, h in enumerate(hit_list):
            h["index"] = i
            h["score"] = int(round(h["score"]))
            h.pop("_idx", None)
        result = {"hits": hit_list, "truncated": truncated}
`;
          const resp = await sendCode(pythonCode, true);
          return JSON.stringify(resp);
        },
      }),

      // --- search_manual_docs ---
      blender_search_manual_docs: tool({
        description:
          "Full-text search over the bundled Blender user manual. " +
          "Returns a ranked list of hits. Each hit has: path, text, breadcrumb, index, score. " +
          "The query is tokenised on whitespace and matched case-insensitively. " +
          "Read-only; consults bundled RST files only.",
        args: {
          query: tool.schema.string().describe("Search query"),
          max_results: tool.schema.number().optional().default(20).describe("Maximum number of results"),
          context: tool.schema.number().optional().default(0).describe("Number of context paragraphs around each hit"),
        },
        async execute(args) {
          const pythonCode = `
import json, os, re, math

SCOPE_DIR = ${JSON.stringify(_MANUAL_DIR)}

_STOPWORDS = frozenset({
    "a", "an", "and", "any", "are", "as", "at", "be", "by", "can",
    "do", "does", "for", "from", "how", "if", "in", "is", "it",
    "its", "not", "of", "on", "or", "that", "the", "this", "to",
    "was", "were", "what", "when", "where", "which", "why", "will",
    "with", "you", "your",
})

def _rst_files(dirpath):
    for dirpath, dirnames, fnames in os.walk(dirpath):
        dirnames.sort()
        for fn in sorted(fnames):
            if fn.endswith(".rst"):
                yield os.path.join(dirpath, fn)

def _tokenize(text):
    return [t for t in text.lower().split() if t and t not in _STOPWORDS]

query = ${JSON.stringify(args.query)}
max_results = max(1, ${JSON.stringify((args as any).max_results ?? 20)})
ctx = max(0, ${JSON.stringify((args as any).context ?? 0)})

tokens = _tokenize(query)
if not tokens:
    result = {"hits": [], "truncated": False}
else:
    patterns = [re.compile(re.escape(t), re.IGNORECASE) for t in tokens]
    n_files = 0
    per_token_df = [0] * len(patterns)
    pre_hits = []

    for fpath in _rst_files(SCOPE_DIR):
        try:
            text = open(fpath, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        n_files += 1
        body_present = [bool(p.search(text)) for p in patterns]
        for i in range(len(patterns)):
            if body_present[i]:
                per_token_df[i] += 1
        if not any(body_present):
            continue
        paragraphs = [p for p in re.split(r'\\n\\n+', text) if p.strip()]
        for idx, para in enumerate(paragraphs):
            counts = [len(p.findall(para)) for p in patterns]
            if any(counts):
                pre_hits.append((fpath, idx, paragraphs, counts))

    if n_files == 0:
        result = {"hits": [], "truncated": False}
    else:
        idfs = [math.log((n_files + 1) / (df + 1)) + 1 for df in per_token_df]
        hits = {}
        for fpath, idx, paragraphs, counts in pre_hits:
            score = sum(c * idf for c, idf in zip(counts, idfs))
            rel = os.path.relpath(fpath, SCOPE_DIR)
            lo = max(0, idx - ctx)
            hi = min(len(paragraphs), idx + ctx + 1)
            text_block = "\\n\\n".join(paragraphs[lo:hi])
            key = (rel, lo)
            existing = hits.get(key)
            if existing:
                existing["score"] += score
            else:
                hits[key] = {"path": rel, "text": text_block, "breadcrumb": "", "score": score, "_idx": idx}
        hit_list = sorted(hits.values(), key=lambda h: -h["score"])
        truncated = len(hit_list) > max_results
        hit_list = hit_list[:max_results]
        for i, h in enumerate(hit_list):
            h["index"] = i
            h["score"] = int(round(h["score"]))
            h.pop("_idx", None)
        result = {"hits": hit_list, "truncated": truncated}
`;
          const resp = await sendCode(pythonCode, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_screenshot_of_window_as_image ---
      blender_get_screenshot_of_window_as_image: tool({
        description: "Take a screenshot of the entire Blender window and return it as a PNG image.",
        args: {
          size_limit_in_bytes: tool.schema.number().optional().default(0).describe("Caps the image size in bytes. Zero uses the default limit."),
        },
        async execute(args) {
          const code = `
import base64, os, tempfile
from typing import NamedTuple
class Params(NamedTuple):
    size_limit_in_bytes: int
class Result(NamedTuple):
    status: str
    image_base64: str | None
    message: str | None
_IMAGE_SIZE_LIMIT_IN_BYTES = (1048576 * 3) // 4
${IMAGE_DOWNSCALE}
def main(params: Params) -> Result:
    import bpy
    from bpy import context
    if bpy.app.background:
        return Result(status="error", message="Screenshots are not available in background mode")
    window = context.window
    if window is None:
        return Result(status="error", message="No active window")
    size_limit = params.size_limit_in_bytes if params.size_limit_in_bytes > 0 else _IMAGE_SIZE_LIMIT_IN_BYTES
    with tempfile.TemporaryDirectory(prefix="blmcp_screenshot_") as tmpdir:
        fp = os.path.join(tmpdir, "screenshot.png")
        try:
            bpy.ops.screen.screenshot(filepath=fp)
        except RuntimeError as ex:
            return Result(status="error", message=str(ex))
        image_data = _image_downscale_to_size_limit(tmpdir, fp, size_limit_in_bytes=size_limit, size_tolerance_in_bytes=size_limit // 16)
        data = base64.b64encode(image_data).decode("ascii")
    return Result(status="ok", image_base64=data)
_rv = main(Params(${JSON.stringify(args.size_limit_in_bytes ?? 0)}))
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_screenshot_of_window_as_json ---
      blender_get_screenshot_of_window_as_json: tool({
        description: "Return a JSON description of the Blender window layout, areas, active object, and selection.",
        args: {},
        async execute() {
          const code = `
from typing import NamedTuple
class Result(NamedTuple):
    status: str
    window_width: int; window_height: int; screen_name: str; workspace: str; scene: str
    areas: list[dict[str, object]]
    active_object: dict[str, object] | None; selected_objects: list[dict[str, str]]
    message: str | None = None
def main(params: None) -> Result:
    del params
    import bpy
    from bpy import context
    error = None
    window = context.window
    if bpy.app.background:
        error = "Window layout is not available in background mode"
    elif window is None:
        error = "No active window"
    if error is not None:
        return Result(status="error", window_width=0, window_height=0, screen_name="", workspace="", scene="", areas=[], active_object=None, selected_objects=[], message=error)
    screen = window.screen
    areas = []
    for area in screen.areas:
        ai = {"type": area.type, "x": area.x, "y": area.y, "width": area.width, "height": area.height}
        space = area.spaces.active
        if space:
            si = {"type": space.type}
            if space.type == "VIEW_3D":
                r3d = space.region_3d
                if r3d:
                    si["view_perspective"] = r3d.view_perspective; si["view_location"] = list(r3d.view_location)
                if hasattr(space, "shading"): si["shading_type"] = space.shading.type
                si["show_overlays"] = space.overlay.show_overlays
            elif space.type == "PROPERTIES": si["context"] = space.context
            elif space.type == "OUTLINER": si["display_mode"] = space.display_mode
            elif space.type == "TEXT_EDITOR":
                if space.text: si["text_name"] = space.text.name
            elif space.type == "NODE_EDITOR":
                si["tree_type"] = space.tree_type
                if space.node_tree: si["node_tree_name"] = space.node_tree.name
            ai["space"] = si
        regions = [{"type": r.type, "x": r.x, "y": r.y, "width": r.width, "height": r.height} for r in area.regions if r.width > 0 and r.height > 0]
        ai["regions"] = regions
        areas.append(ai)
    active = context.active_object
    active_info = {"name": active.name, "type": active.type, "mode": context.mode, "location": list(active.location)} if active else None
    selected = [{"name": o.name, "type": o.type} for o in context.selected_objects]
    return Result(status="ok", window_width=window.width, window_height=window.height, screen_name=screen.name, workspace=window.workspace.name, scene=context.scene.name, areas=areas, active_object=active_info, selected_objects=selected)
_rv = main(None)
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- get_screenshot_of_area_as_image ---
      blender_get_screenshot_of_area_as_image: tool({
        description: "Take a screenshot of a single Blender area and return it as a PNG image. area_ui_type matches the area's ui_type.",
        args: {
          area_ui_type: tool.schema.string().describe("Area ui_type (e.g. VIEW_3D, IMAGE_EDITOR, ShaderNodeTree, etc.)"),
          size_limit_in_bytes: tool.schema.number().optional().default(0).describe("Caps the image size in bytes."),
        },
        async execute(args) {
          const code = `
import base64, os, tempfile
from typing import NamedTuple
class Params(NamedTuple):
    area_ui_type: str
    size_limit_in_bytes: int
class Result(NamedTuple):
    status: str
    image_base64: str | None; message: str | None
_IMAGE_SIZE_LIMIT_IN_BYTES = (1048576 * 3) // 4
${IMAGE_DOWNSCALE}
def _find_area(screen, ui_type):
    from bpy import context
    area = context.area
    if area is not None and area.ui_type == ui_type:
        return area
    for a in screen.areas:
        if a.ui_type == ui_type:
            return a
    return None
def main(params: Params) -> Result:
    import bpy
    from bpy import context
    if bpy.app.background:
        return Result(status="error", message="Screenshots not available in background mode")
    window = context.window
    if window is None:
        return Result(status="error", message="No active window")
    screen = window.screen
    area = _find_area(screen, params.area_ui_type)
    if area is None:
        avail = sorted({a.ui_type for a in screen.areas})
        return Result(status="error", message="No area with type {!r} found. Available: {:s}".format(params.area_ui_type, ", ".join(avail)))
    size_limit = params.size_limit_in_bytes if params.size_limit_in_bytes > 0 else _IMAGE_SIZE_LIMIT_IN_BYTES
    with tempfile.TemporaryDirectory(prefix="blmcp_screenshot_") as tmpdir:
        fp = os.path.join(tmpdir, "screenshot.png")
        with context.temp_override(window=window, area=area):
            try:
                bpy.ops.screen.screenshot_area(filepath=fp)
            except RuntimeError as ex:
                return Result(status="error", message=str(ex))
        image_data = _image_downscale_to_size_limit(tmpdir, fp, size_limit_in_bytes=size_limit, size_tolerance_in_bytes=size_limit // 16)
        data = base64.b64encode(image_data).decode("ascii")
    return Result(status="ok", image_base64=data)
_rv = main(Params(${JSON.stringify(args.area_ui_type)}, ${JSON.stringify(args.size_limit_in_bytes ?? 0)}))
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- jump_to_tab_by_name ---
      blender_jump_to_tab_by_name: tool({
        description: "Switch the active workspace tab to name.",
        args: {
          name: tool.schema.string().describe("Name of the workspace to switch to"),
        },
        async execute(args) {
          const code = `
from typing import NamedTuple
class Params(NamedTuple):
    name: str
class Result(NamedTuple):
    status: str; workspace: str | None = None; message: str | None = None; available_workspaces: list[str] | None = None
def main(params: Params) -> Result:
    import bpy
    if bpy.app.background:
        return Result(status="error", message="Not available in background mode")
    if bpy.context.window is None:
        return Result(status="error", message="No active window")
    ws = bpy.data.workspaces.get(params.name)
    if ws is None:
        return Result(status="error", message="Workspace {!r} not found".format(params.name), available_workspaces=[w.name for w in bpy.data.workspaces])
    bpy.context.window.workspace = ws
    return Result(status="ok", workspace=ws.name)
_rv = main(Params(${JSON.stringify(args.name)}))
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- jump_to_tab_by_space_type ---
      blender_jump_to_tab_by_space_type: tool({
        description: "Switch to a workspace whose main area matches space_type. If allow_edits is True and no matching workspace exists, a new one is created by duplicating the current workspace.",
        args: {
          space_type: tool.schema.string().describe("Area space type to find (e.g. VIEW_3D, IMAGE_EDITOR)"),
          allow_edits: tool.schema.boolean().optional().default(false).describe("If True, create a new workspace when none matches"),
        },
        async execute(args) {
          const code = `
from typing import NamedTuple
class Params(NamedTuple):
    space_type: str; allow_edits: bool
class Result(NamedTuple):
    status: str; workspace: str | None = None; space_type: str | None = None; created: bool | None = None; message: str | None = None; available_space_types: list[str] | None = None
def _largest_area(screen):
    return max(screen.areas, key=lambda a: a.width * a.height, default=None)
def main(params: Params) -> Result:
    import bpy
    if bpy.app.background:
        return Result(status="error", message="Not available in background mode")
    if bpy.context.window is None:
        return Result(status="error", message="No active window")
    found = None
    for ws in bpy.data.workspaces:
        for screen in ws.screens:
            area = _largest_area(screen)
            if area is not None and area.type == params.space_type:
                found = ws; break
        if found: break
    if found:
        bpy.context.window.workspace = found
        return Result(status="ok", workspace=found.name, space_type=params.space_type)
    if params.allow_edits:
        try: bpy.ops.workspace.duplicate()
        except RuntimeError as ex: return Result(status="error", message=str(ex))
        new_ws = bpy.context.window.workspace
        new_ws.name = params.space_type.replace("_", " ").title()
        area = _largest_area(bpy.context.screen)
        if area is not None: area.type = params.space_type
        return Result(status="ok", workspace=new_ws.name, space_type=params.space_type, created=True)
    avail = sorted({a.type for ws in bpy.data.workspaces for screen in ws.screens for a in (_largest_area(screen),) if a is not None})
    return Result(status="error", message="No workspace with space type {!r} found".format(params.space_type), available_space_types=avail)
_rv = main(Params(${JSON.stringify(args.space_type)}, ${pyBool(args.allow_edits ?? false)}))
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- jump_to_view3d_object_by_name ---
      blender_jump_to_view3d_object_by_name: tool({
        description: "Move the 3D viewport to focus on an object by name. If allow_edits is True the object may be un-hidden and its collections enabled.",
        args: {
          name: tool.schema.string().describe("Name of the object to focus on"),
          allow_edits: tool.schema.boolean().optional().default(false).describe("If True, unhide object and enable its collections"),
        },
        async execute(args) {
          const code = `
from typing import NamedTuple, Any
class Params(NamedTuple):
    name: str; allow_edits: bool
class Result(NamedTuple):
    status: str; object: str | None = None; type: str | None = None; location: list[float] | None = None; message: str | None = None
def _enable_collections(layer_col, target):
    found = False
    for child in layer_col.children:
        if _enable_collections(child, target): found = True
    if target.name in layer_col.collection.objects: found = True
    if found: layer_col.exclude = False; layer_col.hide_viewport = False
    return found
def main(params: Params) -> Result:
    import bpy
    if bpy.app.background: return Result(status="error", message="Not available in background mode")
    if bpy.context.window is None: return Result(status="error", message="No active window")
    obj = bpy.data.objects.get(params.name)
    if obj is None: return Result(status="error", message="Object {!r} not found".format(params.name))
    if params.allow_edits:
        if obj.hide_viewport: obj.hide_viewport = False
        if obj.hide_get(): obj.hide_set(False)
        _enable_collections(bpy.context.view_layer.layer_collection, obj)
    if bpy.context.mode != "OBJECT": bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    view3d_found = False
    for area in bpy.context.screen.areas:
        if area.type == "VIEW_3D":
            view3d_found = True
            r3d = area.spaces.active.region_3d
            if r3d and r3d.view_perspective == "CAMERA": r3d.view_perspective = "PERSP"
            for region in area.regions:
                if region.type == "WINDOW":
                    with bpy.context.temp_override(area=area, region=region): bpy.ops.view3d.view_selected()
                    break
            break
    return Result(status="ok", object=params.name, type=obj.type, location=list(obj.location), message=None if view3d_found else "No 3D viewport found, object selected but not framed")
_rv = main(Params(${JSON.stringify(args.name)}, ${pyBool(args.allow_edits ?? false)}))
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- jump_to_view3d_object_data_by_name ---
      blender_jump_to_view3d_object_data_by_name: tool({
        description: "Move the 3D viewport to the object whose data block matches name. If allow_edits is True the object may be un-hidden and its collections enabled.",
        args: {
          name: tool.schema.string().describe("Data-block name to find"),
          allow_edits: tool.schema.boolean().optional().default(false).describe("If True, unhide object and enable its collections"),
        },
        async execute(args) {
          const code = `
from typing import NamedTuple, Any
class Params(NamedTuple):
    name: str; allow_edits: bool
class Result(NamedTuple):
    status: str; object: str | None = None; data_name: str | None = None; type: str | None = None; location: list[float] | None = None; message: str | None = None
def _enable_collections(layer_col, target):
    found = False
    for child in layer_col.children:
        if _enable_collections(child, target): found = True
    if target.name in layer_col.collection.objects: found = True
    if found: layer_col.exclude = False; layer_col.hide_viewport = False
    return found
def main(params: Params) -> Result:
    import bpy
    if bpy.app.background: return Result(status="error", message="Not available in background mode")
    if bpy.context.window is None: return Result(status="error", message="No active window")
    target = None
    for obj in bpy.data.objects:
        if obj.data is not None and obj.data.name == params.name:
            target = obj; break
    if target is None: return Result(status="error", message="No object found with data named {!r}".format(params.name))
    if params.allow_edits:
        if target.hide_viewport: target.hide_viewport = False
        if target.hide_get(): target.hide_set(False)
        _enable_collections(bpy.context.view_layer.layer_collection, target)
    if bpy.context.mode != "OBJECT": bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    view3d_found = False
    for area in bpy.context.screen.areas:
        if area.type == "VIEW_3D":
            view3d_found = True
            r3d = area.spaces.active.region_3d
            if r3d and r3d.view_perspective == "CAMERA": r3d.view_perspective = "PERSP"
            for region in area.regions:
                if region.type == "WINDOW":
                    with bpy.context.temp_override(area=area, region=region): bpy.ops.view3d.view_selected()
                    break
            break
    return Result(status="ok", object=target.name, data_name=params.name, type=target.type, location=list(target.location), message=None if view3d_found else "No 3D viewport found, object selected but not framed")
_rv = main(Params(${JSON.stringify(args.name)}, ${pyBool(args.allow_edits ?? false)}))
result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- jump_to_view3d_object_data_by_name ---
      blender_render_thumbnail_to_path: tool({
        description: "Render a small, low-quality thumbnail to output_path (temporarily overrides settings).",
        args: {
          output_path: tool.schema.string().describe("Path to save the rendered thumbnail"),
        },
        async execute(args) {
          const code = `
from typing import NamedTuple
import contextlib, typing
class Params(NamedTuple):
    output_path: str
class Result(NamedTuple):
    status: str; filepath: str | None = None; message: str | None = None
_THUMB_DIMS_MAX = 320
_THUMB_SIMPLIFY_SUBDIV = 1
_THUMB_CYCLES_SAMPLES = 16
_THUMB_EEVEE_SAMPLES = 16
${BACKUP_ATTRS_ASSIGN}
${DEFERRED_CHECK}
def main(params: Params):
    import os, bpy
    use_deferred = not bpy.app.background
    output_path = os.path.join(bpy.app.tempdir, "blender_mcp", os.path.basename(params.output_path))
    scene = bpy.context.scene; rd = scene.render
    res_x, res_y = rd.resolution_x, rd.resolution_y
    if res_x >= res_y:
        thumb_x = _THUMB_DIMS_MAX; thumb_y = max(int(res_y * _THUMB_DIMS_MAX / res_x), 1)
    else:
        thumb_y = _THUMB_DIMS_MAX; thumb_x = max(int(res_x * _THUMB_DIMS_MAX / res_y), 1)
    orig_filepath = rd.filepath; rd.filepath = output_path
    obj_attrs = [(rd, {"resolution_x": thumb_x, "resolution_y": thumb_y, "resolution_percentage": 100, "use_simplify": True, "simplify_subdivision_render": _THUMB_SIMPLIFY_SUBDIV})]
    if rd.engine == "CYCLES":
        obj_attrs.append((scene.cycles, {"samples": _THUMB_CYCLES_SAMPLES}))
    elif rd.engine == "BLENDER_EEVEE_NEXT":
        obj_attrs.append((scene.eevee, {"taa_render_samples": _THUMB_EEVEE_SAMPLES}))
    render_args = ('INVOKE_DEFAULT',) if use_deferred else ()
    with _backup_attrs_and_assign_multi(*obj_attrs):
        try: bpy.ops.render.render(*render_args, write_still=True)
        except RuntimeError as ex:
            rd.filepath = orig_filepath
            return Result(status="error", message=str(ex))
    if use_deferred:
        return _deferred_tool_check_for_file_output('RENDER', output_path, restore_attrs=[(rd, "filepath", orig_filepath)])
    rd.filepath = orig_filepath
    return Result(status="ok", filepath=output_path)
_rv = main(Params(${JSON.stringify(args.output_path)}))
if callable(_rv):
    check_is_finished = _rv
    result = {}
else:
    result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),

      // --- render_viewport_to_path ---
      blender_render_viewport_to_path: tool({
        description: "Render the current scene to output_path using current render settings.",
        args: {
          output_path: tool.schema.string().describe("Path to save the rendered image"),
        },
        async execute(args) {
          const code = `
from typing import NamedTuple
class Params(NamedTuple):
    output_path: str
class Result(NamedTuple):
    status: str; filepath: str | None = None; message: str | None = None
${DEFERRED_CHECK}
def main(params: Params):
    import os, bpy
    use_deferred = not bpy.app.background
    output_path = os.path.join(bpy.app.tempdir, "blender_mcp", os.path.basename(params.output_path))
    scene = bpy.context.scene; rd = scene.render
    orig_filepath = rd.filepath; rd.filepath = output_path
    render_args = ('INVOKE_DEFAULT',) if use_deferred else ()
    try: bpy.ops.render.render(*render_args, write_still=True)
    except RuntimeError as ex:
        rd.filepath = orig_filepath
        return Result(status="error", message=str(ex))
    if use_deferred:
        return _deferred_tool_check_for_file_output('RENDER', output_path, restore_attrs=[(rd, "filepath", orig_filepath)])
    rd.filepath = orig_filepath
    return Result(status="ok", filepath=output_path)
_rv = main(Params(${JSON.stringify(args.output_path)}))
if callable(_rv):
    check_is_finished = _rv
    result = {}
else:
    result = _rv._asdict()
`;
          const resp = await sendCode(code, true);
          return JSON.stringify(resp);
        },
      }),
    },
  };
};

export default BlenderPlugin;
