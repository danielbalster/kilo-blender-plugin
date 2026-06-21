# @dbalster/blender-plugin

A Kilo/OpenCode TypeScript plugin that integrates with a running Blender instance
via the blender-mcp add-on TCP server.

## Features

- 25+ Blender tools: execute code, scene introspection, object inspection,
  screenshots, workspace navigation, viewport focus, rendering, API docs lookup
- Blender API documentation search (offline, bundled RST corpus)

## Installation

```bash
npm install -g @dbalster/blender-plugin
```

## Usage

1. Install the blender-mcp add-on in Blender and start the TCP server
2. Copy or symlink into `.kilo/plugins/`:

```bash
cp node_modules/@dbalster/blender-plugin/dist/blender.js ~/project/.kilo/plugins/blender.js
```

3. Add to `.kilo/kilo.json`:

```json
{
  "plugins": ["./plugins/blender.js"]
}
```

## Requirements

- Blender (any version supported by blender-mcp add-on)
- blender-mcp add-on installed and TCP server running (default localhost:9876)

## Tools Provided

| Tool | Description |
|------|-------------|
| `blender_execute_blender_code` | Execute arbitrary Python in Blender |
| `blender_execute_blender_code_for_cli` | Execute code via blender --background |
| `blender_get_blendfile_summary_datablocks` | Data-block counts, render engine, workspace |
| `blender_get_blendfile_summary_missing_files` | Missing external file references |
| `blender_get_blendfile_summary_of_linked_libraries` | Linked library tree |
| `blender_get_blendfile_summary_path_info` | Path, save status, age, backups |
| `blender_get_blendfile_summary_usage_guess` | Use-case scoring (0-100) |
| `blender_get_objects_summary` | Collection hierarchy and objects |
| `blender_get_object_detail_summary` | Single object detail |
| `blender_get_python_api_docs` | Blender Python API reference lookup |
| `blender_search_api_docs` | Full-text search of API reference |
| `blender_search_manual_docs` | Full-text search of Blender manual |
| `blender_get_screenshot_of_window_as_image` | Window screenshot PNG |
| `blender_get_screenshot_of_window_as_json` | Window layout JSON |
| `blender_get_screenshot_of_area_as_image` | Area screenshot PNG |
| `blender_jump_to_tab_by_name` | Switch workspace |
| `blender_jump_to_tab_by_space_type` | Switch workspace by space type |
| `blender_jump_to_view3d_object_by_name` | Focus 3D viewport on object |
| `blender_jump_to_view3d_object_data_by_name` | Focus 3D viewport on data block |
| `blender_render_thumbnail_to_path` | Low-quality thumbnail render |
| `blender_render_viewport_to_path` | Full viewport render |

## Environment variables

- `BLENDER_MCP_HOST` — Blender add-on host (default: `localhost`)
- `BLENDER_MCP_PORT` — Blender add-on port (default: `9876`)
- `BLENDER_BIN` — Blender binary path for CLI tools (default: `blender`)

## License

MIT
