import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { projectRoot } from "../server/config";

interface Packet { pcm: ArrayBuffer; level: number }
interface Processor {
  port: { onmessage: ((event: { data: { type: string; active?: boolean } }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
const code = readFileSync(path.join(projectRoot, "public", "pcm-processor.js"), "utf8");

function worklet(rate: number) {
  const packets: Packet[] = [];
  let constructor: (new () => Processor) | undefined;
  let name: string | undefined;
  class BaseProcessor {
    port = {
      onmessage: null,
      postMessage(packet: Packet) { packets.push(packet); },
    };
  }
  vm.runInNewContext(code, {
    sampleRate: rate, AudioWorkletProcessor: BaseProcessor,
    registerProcessor(value: string, type: new () => Processor) { name = value; constructor = type; },
  });
  if (!constructor) throw new Error("Worklet was not registered.");
  const processor = new constructor();
  const active = (value: boolean) => processor.port.onmessage?.({ data: { type: "active", active: value } });
  const feed = (samples: Float32Array, quantum = 128, secondChannel?: Float32Array) => {
    for (let offset = 0; offset < samples.length; offset += quantum) {
      const channels = [samples.subarray(offset, offset + quantum)];
      if (secondChannel) channels.push(secondChannel.subarray(offset, offset + quantum));
      const output = new Float32Array(channels[0].length).fill(1);
      processor.process([channels], [[output]]);
      expect(output.every(sample => sample === 0)).toBe(true);
    }
  };
  return { processor, packets, active, feed, name };
}
function decode(packets: Packet[]) {
  const values: number[] = [];
  for (const packet of packets) {
    const view = new DataView(packet.pcm);
    for (let offset = 0; offset < packet.pcm.byteLength; offset += 2) values.push(view.getInt16(offset, true) / 32768);
  }
  return values;
}
function rms(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

describe("PCM AudioWorklet", () => {
  it.each([16000, 32000, 44100, 48000, 96000])("streams exactly 16k samples per second from %i Hz", rate => {
    const processor = worklet(rate);
    expect(processor.name).toBe("glasshouse-pcm");
    processor.active(true);
    processor.feed(new Float32Array(rate * 2).fill(0.25));
    expect(processor.packets).toHaveLength(100);
    expect(processor.packets.every(packet => packet.pcm.byteLength === 640)).toBe(true);
    const samples = decode(processor.packets);
    expect(samples).toHaveLength(32000);
    expect(samples[100]).toBeCloseTo(0.25, 4);
    expect(processor.packets.at(-1)?.level).toBeCloseTo(0.25, 4);
  });

  it("preserves fractional resampling phase across arbitrary render boundaries", () => {
    const input = Float32Array.from({ length: 44100 }, (_, index) => Math.sin(2 * Math.PI * 1000 * index / 44100) * 0.6);
    const regular = worklet(44100);
    const irregular = worklet(44100);
    regular.active(true);
    irregular.active(true);
    regular.feed(input, 128);
    irregular.feed(input, 37);
    expect(decode(irregular.packets)).toEqual(decode(regular.packets));
  });

  it("low-pass filters before downsampling instead of aliasing ultrasonic input into speech", () => {
    function tone(frequency: number) {
      const processor = worklet(48000);
      processor.active(true);
      processor.feed(Float32Array.from({ length: 48000 }, (_, index) => 0.5 * Math.sin(2 * Math.PI * frequency * index / 48000)));
      return rms(decode(processor.packets).slice(1000));
    }
    const speechBand = tone(1000);
    const aliasBand = tone(12000);
    expect(speechBand).toBeGreaterThan(0.3);
    expect(aliasBand).toBeLessThan(speechBand * 0.02);
  });

  it("encodes signed little-endian PCM and averages microphone channels", () => {
    const processor = worklet(16000);
    processor.active(true);
    processor.feed(new Float32Array(320).fill(-0.5));
    const bytes = new Uint8Array(processor.packets[0].pcm);
    expect([...bytes.slice(0, 2)]).toEqual([0, 192]);
    processor.active(false);
    processor.active(true);
    processor.feed(new Float32Array(320).fill(0.5), 128, new Float32Array(320).fill(-0.5));
    expect(decode(processor.packets.slice(1)).every(value => value === 0)).toBe(true);
  });

  it("does not record while inactive and discards partial utterances on mute/dispose", () => {
    const processor = worklet(48000);
    processor.feed(new Float32Array(4800).fill(0.5));
    expect(processor.packets).toHaveLength(0);
    processor.active(true);
    processor.feed(new Float32Array(300).fill(0.5));
    processor.active(false);
    processor.feed(new Float32Array(4800).fill(0.5));
    expect(processor.packets).toHaveLength(0);
    processor.active(true);
    processor.feed(new Float32Array(960).fill(0.5));
    expect(processor.packets).toHaveLength(1);
    processor.processor.port.onmessage?.({ data: { type: "dispose" } });
    expect(processor.processor.process([[new Float32Array(128)]], [[new Float32Array(128)]])).toBe(false);
  });
});
