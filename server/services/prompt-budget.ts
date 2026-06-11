// @ts-nocheck
/**
 * Prompt budgeting helpers for token/byte-aware prompt construction.
 *
 * Provides byte estimation, text clipping at newline boundaries,
 * and a budget report builder that respects required/optional sections.
 */

/**
 * Returns the UTF-8 byte length of a string value.
 *
 * @param {string} value
 * @returns {number}
 */
export function estimatePromptBytes(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Clips text to maxBytes, cutting at the last newline boundary before maxBytes.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, clipped: boolean, originalBytes: number, resultBytes: number }}
 */
export function clipTextByBytes(text, maxBytes) {
  const originalBytes = Buffer.byteLength(text, "utf8");

  if (originalBytes <= maxBytes) {
    return {
      text,
      clipped: false,
      originalBytes,
      resultBytes: originalBytes,
    };
  }

  // Binary search for the longest prefix that fits within maxBytes
  // and ends at a newline boundary.
  // We walk the string char-by-char, tracking byte position.
  let bytePos = 0;
  let lastNewlineBytePos = 0;
  let cutCharIndex = text.length;

  for (let i = 0; i < text.length; i++) {
    const charBytes = Buffer.byteLength(text[i], "utf8");
    if (bytePos + charBytes > maxBytes) {
      cutCharIndex = i;
      break;
    }
    bytePos += charBytes;
    if (text[i] === "\n") {
      lastNewlineBytePos = bytePos;
    }
  }

  // Prefer cutting at last newline boundary
  let result;
  if (lastNewlineBytePos > 0) {
    // Find the char index corresponding to lastNewlineBytePos
    let scanBytes = 0;
    let charIdx = 0;
    for (; charIdx < text.length; charIdx++) {
      if (scanBytes === lastNewlineBytePos) break;
      scanBytes += Buffer.byteLength(text[charIdx], "utf8");
      if (scanBytes === lastNewlineBytePos) {
        charIdx++;
        break;
      }
    }
    result = text.slice(0, charIdx);
  } else {
    result = text.slice(0, cutCharIndex);
  }

  const resultBytes = Buffer.byteLength(result, "utf8");

  return {
    text: result,
    clipped: true,
    originalBytes,
    resultBytes,
  };
}

/**
 * Builds a budget report by including sections in order:
 * 1. Required sections always included (even if they exceed maxBytes)
 * 2. Optional sections included if they fit within remaining budget
 *
 * @param {Array<{ name: string, content: string, required: boolean }>} sections
 * @param {number} maxBytes
 * @returns {{
 *   sections: Array<{ name: string, bytes: number, included: boolean, required: boolean }>,
 *   totalBytes: number,
 *   maxBytes: number,
 *   clipped: boolean
 * }}
 */
export function buildBudgetReport(sections, maxBytes) {
  const report = [];
  let usedBytes = 0;

  for (const section of sections) {
    const sectionBytes = Buffer.byteLength(section.content, "utf8");

    if (section.required) {
      report.push({
        name: section.name,
        bytes: sectionBytes,
        included: true,
        required: true,
      });
      usedBytes += sectionBytes;
    } else {
      const included = usedBytes + sectionBytes <= maxBytes;
      report.push({
        name: section.name,
        bytes: sectionBytes,
        included,
        required: false,
      });
      if (included) {
        usedBytes += sectionBytes;
      }
    }
  }

  return {
    sections: report,
    totalBytes: usedBytes,
    maxBytes,
    clipped: usedBytes > maxBytes,
  };
}
