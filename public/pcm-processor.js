class GlasshousePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.alive = true;
    this.ratio = sampleRate / 16000;
    this.history = new Float32Array(64);
    this.coefficients = new Float32Array(48);
    const cutoff = Math.min(0.45, 7200 / sampleRate);
    let total = 0;
    for (let tap = 0; tap < this.coefficients.length; tap++) {
      const distance = tap - (this.coefficients.length - 1) / 2;
      const sinc = Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * tap / 47) + 0.08 * Math.cos(4 * Math.PI * tap / 47);
      this.coefficients[tap] = sinc * window;
      total += this.coefficients[tap];
    }
    for (let tap = 0; tap < this.coefficients.length; tap++) this.coefficients[tap] /= total;
    this.reset();
    this.port.onmessage = ({ data }) => {
      if (data?.type === "active") {
        this.active = data.active === true;
        this.reset();
      } else if (data?.type === "dispose") {
        this.active = false;
        this.alive = false;
        this.reset();
      }
    };
  }

  reset() {
    this.history.fill(0);
    this.inputIndex = 0;
    this.nextOutputAt = 0;
    this.previous = 0;
    this.chunk = new ArrayBuffer(640);
    this.view = new DataView(this.chunk);
    this.outputIndex = 0;
    this.energy = 0;
  }

  emit(sample) {
    const value = Math.max(-1, Math.min(1, sample));
    this.view.setInt16(this.outputIndex * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    this.outputIndex++;
    this.energy += value * value;
    if (this.outputIndex === 320) {
      this.port.postMessage({ pcm: this.chunk, level: Math.sqrt(this.energy / 320) }, [this.chunk]);
      this.chunk = new ArrayBuffer(640);
      this.view = new DataView(this.chunk);
      this.outputIndex = 0;
      this.energy = 0;
    }
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!this.active || !channels?.length) return this.alive;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] || 0;
      sample /= channels.length;
      const cursor = this.inputIndex & 63;
      this.history[cursor] = sample;
      let filtered = sample;
      if (sampleRate !== 16000) {
        filtered = 0;
        for (let tap = 0; tap < this.coefficients.length; tap++) {
          filtered += this.history[(cursor - tap) & 63] * this.coefficients[tap];
        }
      }
      // Keep a fractional phase across render quanta, including at 44.1 kHz.
      while (this.nextOutputAt <= this.inputIndex + 1e-8) {
        const fraction = Math.max(0, Math.min(1, this.nextOutputAt - (this.inputIndex - 1)));
        this.emit(this.previous + (filtered - this.previous) * fraction);
        this.nextOutputAt += this.ratio;
      }
      this.previous = filtered;
      this.inputIndex++;
    }
    return this.alive;
  }
}

registerProcessor("glasshouse-pcm", GlasshousePcmProcessor);
