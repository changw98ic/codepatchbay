#!/usr/bin/env node
/* eslint-disable */
// 一次性机械重构脚本: 集中 AnyRecord 定义到 shared/types.ts
// 不提交, 跑完即删.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TYPE_LINE = "type AnyRecord = Record<string, any>;";
const SHARED_TYPES_RELATIVE_TARGET = "shared/types.js"; // 从文件所在目录向上回溯

// 收集所有含局部定义的 .ts 文件 (排除 shared/types.ts 自身, 排除 dist/node_modules)
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "dist-tests") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, acc);
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

const files = walk(ROOT, []);
let touched = 0;

for (const file of files) {
  if (file.endsWith(path.join("shared", "types.ts"))) continue;
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes("type AnyRecord = Record<string, any>;")) continue;

  const lines = src.split("\n");

  // 1) 删除所有精确匹配的局部定义行 (可能不止一行, 文件中间也可能有)
  let removed = 0;
  const afterRemove = [];
  for (const line of lines) {
    if (line.trim() === TYPE_LINE) {
      removed++;
      continue;
    }
    afterRemove.push(line);
  }
  if (removed === 0) continue; // 没有精确匹配, 跳过 (避免误伤)

  // 2) 计算相对路径: 从 file 所在目录 -> ROOT/shared/types.js
  const fileDir = path.dirname(file);
  let rel = path.relative(fileDir, path.join(ROOT, "shared", "types.js"));
  if (!rel.startsWith(".")) {
    // path.relative 在同目录或向上时可能返回不带 ./ 的名字, 补 ./ 保证 ESM 相对
    rel = "./" + rel;
  }
  // posix 化 (windows 反斜杠 -> 正斜杠), 本机是 darwin 但保险
  rel = rel.split(path.sep).join("/");
  const importLine = `import { AnyRecord } from "${rel}";`;

  // 3) 插入 import. 策略: 找到第一组 node: 开头的 import 块之后, 或第一个 import 之后.
  //    若无 import, 放文件首行之后可能的注释块后. 简单稳健: 放在最后一个 `import ... from "node:..."` 之后,
  //    没有就放在第一个 import 之前, 没有 import 就放第一行.
  let insertAt = -1;
  let firstImportAt = -1;
  let lastNodeImportAt = -1;
  for (let i = 0; i < afterRemove.length; i++) {
    const t = afterRemove[i].trim();
    if (t.startsWith("import ") && t.includes("from ") && firstImportAt === -1) {
      firstImportAt = i;
    }
    if (t.startsWith("import ") && t.includes('from "node:')) {
      lastNodeImportAt = i;
    }
  }
  if (lastNodeImportAt !== -1) {
    insertAt = lastNodeImportAt + 1;
  } else if (firstImportAt !== -1) {
    insertAt = firstImportAt;
  } else {
    insertAt = 0;
  }

  afterRemove.splice(insertAt, 0, importLine);

  // 4) 清理: 删除该 import 行上下相邻的空行残留不做强处理 (避免破坏原有空行节奏).
  //    但要避免连续两个空 import 区: 只做最小变更.

  fs.writeFileSync(file, afterRemove.join("\n"));
  touched++;
  console.log(`[touched] ${path.relative(ROOT, file)} (removed ${removed} def, import -> ${rel})`);
}

console.log(`\nDone. touched ${touched} files.`);
