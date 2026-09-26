import { limits } from "./config";
import { invalidResponse } from "./errors";

export function pcmToWav(pcm: Buffer, sampleRate = 24_000): Buffer {
  if (!pcm.length || pcm.length % 2 || pcm.length > limits.maxGeneratedAudioBytes
    || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw invalidResponse();
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  if (wav.length < 44 || wav.length > limits.maxGeneratedAudioBytes
    || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
    || wav.readUInt32LE(4) + 8 !== wav.length) throw invalidResponse();
  let sampleRate: number | undefined;
  const chunks: Buffer[] = [];
  for (let offset = 12; offset < wav.length;) {
    if (offset + 8 > wav.length) throw invalidResponse();
    const kind = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > wav.length) throw invalidResponse();
    if (kind === "fmt ") {
      if (length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
        || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw invalidResponse();
      sampleRate = wav.readUInt32LE(start + 4);
      if (sampleRate !== 24_000 || wav.readUInt32LE(start + 8) !== sampleRate * 2) throw invalidResponse();
    } else if (kind === "data") {
      if (length % 2) throw invalidResponse();
      chunks.push(wav.subarray(start, start + length));
    }
    offset = start + length + (length % 2);
  }
  if (sampleRate === undefined || !chunks.length) throw invalidResponse();
  const pcm = Buffer.concat(chunks);
  if (!pcm.length) throw invalidResponse();
  return { pcm, sampleRate };
}

export function generatedAudioToWav(parts: { data: string; mimeType: string }[]): Buffer {
  let bytes = 0;
  const pcm: Buffer[] = [];
  for (const part of parts) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)
      || part.data.length > Math.ceil(limits.maxGeneratedAudioBytes / 3) * 4) throw invalidResponse();
    const buffer = Buffer.from(part.data, "base64");
    bytes += buffer.length;
    if (bytes > limits.maxGeneratedAudioBytes) throw invalidResponse();
    const [mime, ...parameters] = part.mimeType.toLowerCase().split(";").map(value => value.trim());
    if (mime === "audio/wav" || mime === "audio/x-wav") {
      pcm.push(wavToPcm(buffer).pcm);
    } else if (mime === "audio/pcm" || mime === "audio/l16") {
      if (parameters.some(value => !["rate=24000", "channels=1"].includes(value))) throw invalidResponse();
      if (!buffer.length || buffer.length % 2) throw invalidResponse();
      pcm.push(buffer);
    } else {
      throw invalidResponse();
    }
  }
  if (!pcm.length) throw invalidResponse();
  return pcmToWav(Buffer.concat(pcm));
}
