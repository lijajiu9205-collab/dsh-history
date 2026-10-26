// 读 app.asar 头，列出路径含 prompt 的条目（只读，不写盘）。
import { open } from "node:fs/promises";

const ASAR = process.argv[2];
const fh = await open(ASAR, "r");
const sizeBuf = Buffer.alloc(16);
await fh.read(sizeBuf, 0, 16, 0);
const headerSize = sizeBuf.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerSize);
await fh.read(headerBuf, 0, headerSize, 16);
const header = JSON.parse(headerBuf.toString("utf8").replace(/\0+$/, ""));

const files = [];
function walk(node, prefix) {
  if (!node || typeof node !== "object") return;
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + "/" + name : name;
      if (child.files) walk(child, p);
      else files.push({ path: p, size: child.size, offset: child.offset });
    }
  }
}
walk(header, "");

const hits = files.filter((f) => /prompt/i.test(f.path));
console.log("total entries:", files.length);
console.log("prompt-related:", hits.length);
for (const h of hits.slice(0, 60)) console.log(" ", h.path, h.size);
await fh.close();
