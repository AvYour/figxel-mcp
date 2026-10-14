// Binary payloads inside the bridge (protocol.md §2 `chunk`).
//
// A small export arrives as `{ …, base64 }`. A large one arrives in chunks,
// and an export op's chunks are decoded as they come and kept as Buffers: the
// result carries `binary` (a Buffer) instead of `base64`. Joining the chunks
// into one string first held a 300 MB video as a 400 MB string, next to its
// parts and its decoded copy — close to the longest string the runtime makes.
// Every reader of export bytes goes through bytesOf(), which takes either.

/** Decodes base64 pieces as they arrive. A piece may end mid-quantum: the rest waits for the next one. */
export class Base64Sink {
  private readonly parts: Buffer[] = [];
  private carry = "";
  private size = 0;

  push(piece: string): void {
    const text = this.carry + piece;
    const whole = text.length - (text.length % 4);
    this.carry = text.slice(whole);
    if (whole > 0) {
      const buf = Buffer.from(text.slice(0, whole), "base64");
      this.parts.push(buf);
      this.size += buf.length;
    }
  }

  get bytes(): number {
    return this.size;
  }

  /** Everything received, as one Buffer. */
  finish(): Buffer {
    if (this.carry) this.parts.push(Buffer.from(this.carry, "base64"));
    this.carry = "";
    return this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The bytes of a binary result: `binary` when the bridge reassembled chunks, else the `base64` string. Undefined when it has neither. */
export function bytesOf(data: unknown): Buffer | undefined {
  if (!isObject(data)) return undefined;
  if (Buffer.isBuffer(data.binary)) return data.binary;
  if (typeof data.base64 === "string") return Buffer.from(data.base64, "base64");
  return undefined;
}

/** Whether a result carries bytes in either form. */
export function hasBytes(data: unknown): boolean {
  return isObject(data) && (Buffer.isBuffer(data.binary) || typeof data.base64 === "string");
}

/** The result as JSON can carry it: a `binary` Buffer becomes `base64` again. */
export function withBase64(data: unknown): unknown {
  if (!isObject(data) || !Buffer.isBuffer(data.binary)) return data;
  const { binary, ...rest } = data;
  return { ...rest, base64: binary.toString("base64") };
}
