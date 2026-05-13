#!/usr/bin/env node
// json-helper.mjs — Safe JSON state operations for Flow bridges
// Usage: node json-helper.mjs <read|write|init> <file> [args...]
// Handles both 'key' and key quoting conventions from shell callers.

import fs from 'fs';
import path from 'path';

const [,, op, file, ...args] = process.argv;

function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

// Strip surrounding single quotes: 'status' → status
function unquote(s) {
  if (typeof s === 'string' && s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

switch (op) {
  case 'read': {
    const s = readJSON(file);
    const key = unquote(args[0] || '');
    const val = key.split('.').reduce((o, k) => o?.[k], s);
    if (val !== undefined && val !== null) console.log(typeof val === 'string' ? val : JSON.stringify(val));
    break;
  }
  case 'write': {
    const s = readJSON(file);
    const key = unquote(args[0] || '');
    const rawValue = args[1] || '';
    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = unquote(rawValue);
    }
    const keys = key.split('.');
    keys.reduce((o, k, i) => {
      if (i === keys.length - 1) o[k] = value;
      else o[k] ??= {};
      return o[k];
    }, s);
    s.updated = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
    break;
  }
  case 'init': {
    const [project, task, maxRetries] = args;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      project, task,
      started: new Date().toISOString(),
      phase: 'plan', retryCount: 0,
      maxRetries: Number(maxRetries),
      status: 'running'
    }, null, 2));
    break;
  }
  default:
    console.error('Usage: json-helper.mjs <read|write|init> <file> [args...]');
    process.exit(1);
}
