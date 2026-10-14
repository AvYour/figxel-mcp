// A WAV file as figma_generate_audio writes it: RIFF, one `fmt ` chunk (PCM,
// 16-bit), one `data` chunk of interleaved samples. And the reader the tests
// use to check it. No dependency.

/**
 * Interleave and quantise to 16-bit PCM. `dither` returns uniform 0–1 values:
 * with it, the rounding gets triangular dither of ±1 step, so quiet tails fade
 * into noise instead of stepping; give a seeded source and the bytes repeat.
 */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number, dither?: () => number): Buffer {
  const ch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * ch * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const tpdf = dither ? dither() - dither() : 0;
      const v = Math.round(channels[c]![i]! * 32767 + tpdf);
      buf.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, off);
      off += 2;
    }
  }
  return buf;
}

export interface WavData {
  sampleRate: number;
  bitsPerSample: number;
  channels: Float32Array[];
}

/** Read a 16-bit PCM WAV, chunk by chunk; anything else throws. */
export function decodeWav(buf: Buffer): WavData {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error("only 16-bit PCM is read");
      const frames = Math.floor(size / (2 * fmt.channels));
      const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) channels[c]![i] = buf.readInt16LE(body + (i * fmt.channels + c) * 2) / 32768;
      return { sampleRate: fmt.sampleRate, bitsPerSample: fmt.bits, channels };
    }
    off = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}
