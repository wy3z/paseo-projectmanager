import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

// The plugin SDK does not expose project names or icons, so this reads them the way the
// Paseo 0.12 daemon does: the project registry for the name, then a custom icon from the
// icon cache, then the automatic favicon search (`project-icon.js` in the daemon).

const PASEO_HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const MAX_ICON_SIZE = 32 * 1024;
const MAX_CUSTOM_ICON_SIZE = 1024 * 1024;

const ICON_PATTERNS = [
  "favicon.svg", "favicon.png", "favicon-*.svg", "favicon-*.png", "favico.svg", "favico.png",
  "icon.svg", "icon.png", "app-icon.svg", "app-icon.png", "apple-touch-icon.png",
  "apple-touch-icon-*.png", "icon-*.png", "android-chrome-*.png", "safari-pinned-tab.svg",
  "mstile-*.png", "logo.svg", "logo.png", "favicon.ico", "favico.ico",
];
const PRIORITY_DIRS = ["public", "static", "priv/static", "assets", "images", "img"];
const MONOREPO_PACKAGE_DIRS = ["packages", "apps"];
const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", ".output", "coverage", ".cache",
  "vendor", "src", "lib", "test", "tests", "__tests__",
]);

export interface ProjectIdentity {
  name: string | null;
  icon: { data: string; mimeType: string } | null;
}

interface RegistryProject {
  projectId: string;
  rootPath: string;
  displayName: string;
  customName?: string | null;
  customIconRevision?: string | null;
}

export async function readProjectIdentity(projectId: string): Promise<ProjectIdentity> {
  let projects: RegistryProject[];
  try {
    projects = JSON.parse(await readFile(join(PASEO_HOME, "projects", "projects.json"), "utf8"));
  } catch {
    return { name: null, icon: null };
  }
  const project = projects.find((entry) => entry.projectId === projectId);
  if (!project) return { name: null, icon: null };
  const icon = project.customIconRevision ? await customIcon(projectId) : await automaticIcon(project.rootPath);
  return { name: project.customName || project.displayName, icon };
}

async function customIcon(projectId: string) {
  const key = createHash("sha256").update(projectId).digest("hex");
  try {
    const buffer = await readFile(join(PASEO_HOME, "projects", "icons", `${key}.bin`));
    if (!buffer.length || buffer.length > MAX_CUSTOM_ICON_SIZE) return null;
    const mimeType = sniffMimeType(buffer);
    return mimeType ? { data: buffer.toString("base64"), mimeType } : null;
  } catch {
    return null;
  }
}

async function automaticIcon(projectDir: string) {
  const path = await findProjectIcon(projectDir);
  if (!path) return null;
  try {
    if ((await stat(path)).size > MAX_ICON_SIZE) return null;
    let buffer: Buffer = await readFile(path);
    let mimeType = sniffMimeType(buffer) ?? mimeFromExtension(path);
    if (mimeType === "image/x-icon") {
      const frame = icoPngFrame(buffer);
      if (frame) {
        buffer = frame;
        mimeType = "image/png";
      }
    }
    if (!isSquare(buffer, mimeType)) return null;
    return { data: buffer.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

async function findProjectIcon(projectDir: string) {
  const priority = await searchPriorityDirs(projectDir, 2);
  if (priority) return priority;
  for (const monoDir of MONOREPO_PACKAGE_DIRS) {
    for (const name of await listDir(join(projectDir, monoDir))) {
      const packagePath = join(projectDir, monoDir, name);
      if (!(await isDirectory(packagePath))) continue;
      const found = (await searchPriorityDirs(packagePath, 2)) ?? (await findIconInDir(packagePath));
      if (found) return found;
    }
  }
  return findIconInDir(projectDir);
}

async function searchPriorityDirs(base: string, depth: number) {
  for (const dir of PRIORITY_DIRS) {
    const path = join(base, dir);
    if (!(await isDirectory(path))) continue;
    const found = await searchRecursively(path, depth);
    if (found) return found;
  }
  return null;
}

async function searchRecursively(dir: string, depth: number, current = 0): Promise<string | null> {
  if (current > depth) return null;
  const found = await findIconInDir(dir);
  if (found) return found;
  for (const entry of await listDir(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (!(await isDirectory(path))) continue;
    const nested = await searchRecursively(path, depth, current + 1);
    if (nested) return nested;
  }
  return null;
}

async function findIconInDir(dir: string) {
  const entries = await listDir(dir);
  for (const pattern of ICON_PATTERNS) {
    const regex = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
    for (const entry of entries) {
      if (!regex.test(entry)) continue;
      const path = join(dir, entry);
      try {
        if ((await stat(path)).isFile()) return path;
      } catch {
        // Raced with a delete; keep looking.
      }
    }
  }
  return null;
}

async function listDir(dir: string) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffMimeType(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG)) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 6 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1 && buffer.readUInt16LE(4) > 0) {
    return "image/x-icon";
  }
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(buffer.toString("utf8", 0, 256))) return "image/svg+xml";
  return null;
}

function mimeFromExtension(path: string) {
  const types: Record<string, string> = {
    ".ico": "image/x-icon", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** The largest PNG frame inside an ICO container, which native clients can decode. */
function icoPngFrame(buffer: Buffer) {
  let best: Buffer | null = null;
  let bestWidth = -1;
  for (let index = 0; index < buffer.readUInt16LE(4); index++) {
    const entry = 6 + index * 16;
    if (entry + 16 > buffer.length) break;
    const width = buffer[entry] === 0 ? 256 : buffer[entry];
    const size = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    if (offset + size > buffer.length) continue;
    const frame = buffer.subarray(offset, offset + size);
    if (frame.length >= 8 && frame.subarray(0, 8).equals(PNG) && width > bestWidth) {
      best = frame;
      bestWidth = width;
    }
  }
  return best;
}

function isSquare(buffer: Buffer, mimeType: string) {
  // ICO and SVG are trusted to be square, as in Paseo.
  if (mimeType === "image/x-icon" || mimeType === "image/svg+xml") return true;
  if (mimeType === "image/png" && buffer.length >= 24) return buffer.readUInt32BE(16) === buffer.readUInt32BE(20);
  if (mimeType === "image/gif" && buffer.length >= 10) return buffer.readUInt16LE(6) === buffer.readUInt16LE(8);
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xc2) return buffer.readUInt16BE(offset + 5) === buffer.readUInt16BE(offset + 7);
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return false;
  }
  if (mimeType === "image/webp" && buffer.length >= 30) {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return (buffer.readUInt16LE(26) & 0x3fff) === (buffer.readUInt16LE(28) & 0x3fff);
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return (bits & 0x3fff) === ((bits >> 14) & 0x3fff);
    }
  }
  return false;
}
