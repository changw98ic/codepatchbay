export const DEFAULT_SUBPROCESS_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

export function subprocessOutputMaxBytes(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SUBPROCESS_OUTPUT_MAX_BYTES;
}

export class BoundedOutput {
  readonly maxBytes: number;
  truncated = false;
  #buffers: Buffer[] = [];
  #bytes = 0;

  constructor(maxBytes = DEFAULT_SUBPROCESS_OUTPUT_MAX_BYTES) {
    this.maxBytes = subprocessOutputMaxBytes(maxBytes);
  }

  append(chunk: Buffer | string) {
    let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length >= this.maxBytes) {
      this.#buffers = [buffer.subarray(buffer.length - this.maxBytes)];
      this.#bytes = this.maxBytes;
      this.truncated = true;
      return;
    }

    this.#buffers.push(buffer);
    this.#bytes += buffer.length;
    while (this.#bytes > this.maxBytes && this.#buffers.length > 0) {
      const overflow = this.#bytes - this.maxBytes;
      const first = this.#buffers[0];
      if (first.length <= overflow) {
        this.#buffers.shift();
        this.#bytes -= first.length;
      } else {
        this.#buffers[0] = first.subarray(overflow);
        this.#bytes -= overflow;
      }
      this.truncated = true;
    }
  }

  toString(encoding: BufferEncoding = "utf8") {
    return Buffer.concat(this.#buffers, this.#bytes).toString(encoding);
  }
}
