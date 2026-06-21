// fetch-docs.mjs — Download Blender API docs for offline search
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE =
  "https://raw.githubusercontent.com/danielbalster/blender_mcp/main/mcp/blmcp/data";
const DIRS = ["api", "manual"];

async function fetchDir(dir, outDir) {
  // Fetch the directory listing from GitHub API
  const apiUrl = `https://api.github.com/repos/danielbalster/blender_mcp/contents/mcp/blmcp/data/${dir}`;
  const res = await fetch(apiUrl);
  if (!res.ok) {
    console.warn(`Warning: Could not fetch directory listing for ${dir} (HTTP ${res.status})`);
    return;
  }
  const files = await res.json();
  const rstFiles = files.filter((f) => f.name.endsWith(".rst"));
  if (rstFiles.length === 0) {
    console.warn(`Warning: No .rst files found in ${dir}`);
    return;
  }
  for (const file of rstFiles) {
    const fileUrl = `${BASE}/${dir}/${file.name}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) {
      console.warn(`Warning: Could not fetch ${file.name} (HTTP ${fileRes.status})`);
      continue;
    }
    const content = await fileRes.text();
    const outPath = join(outDir, file.name);
    writeFileSync(outPath, content, "utf-8");
    console.log(`Downloaded ${dir}/${file.name}`);
  }
}

async function main() {
  for (const dir of DIRS) {
    const out = join("data", dir);
    if (!existsSync(out)) mkdirSync(out, { recursive: true });
    await fetchDir(dir, out);
  }
}

main().catch(console.error);
