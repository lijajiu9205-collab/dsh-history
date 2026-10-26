// 从 app.asar 按路径抽取文件（只读 asar，写指定输出目录）。
import { open, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [ASAR, ...targets] = process.argv.slice(2);
const outDir = process.env.ASAR_OUT || ".";
const fh = await open(ASAR, "r");
const head = Buffer.alloc(16);
await fh.read(head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerSize);
await fh.read(headerBuf, 0, headerSize, 16);
const header = JSON.parse(headerBuf.toString("utf8").replace(/\0+$/, ""));
const dataStart = 16 + headerSize;

function find(node, prefix, want) {
  if (!node || !node.files) return null;
  for (const [name, child] of Object.entries(node.files)) {
    const p = prefix ? prefix + "/" + name : name;
    if (p === want) return child;
    if (child.files) {
      const hit = find(child, p, want);
      if (hit) return hit;
    }
  }
  return null;
}

for (const target of targets) {
  const entry = find(header, "", target);
  if (!entry) {
    console.log("MISSING:", target);
    continue;
  }
  const buf = Buffer.alloc(entry.size);
  await fh.read(buf, 0, entry.size, dataStart + Number(entry.offset));
  const dest = join(outDir, target.replace(/^dsh\//, "").replace(/[\\/]/g, "__"));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log("extracted:", target, "->", dest, "(" + entry.size + " bytes)");
}
await fh.close();
