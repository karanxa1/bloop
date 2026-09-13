/* bloop voice — AudioWorklet processors (same-origin, no blob: URLs).
 *  - bloop-capture: mic Float32 @ context rate → linear16 PCM @ target rate, posted as ArrayBuffers
 *  - bloop-player:  linear16 PCM @ source rate → jitter-buffered playback, instant flush on barge-in
 */

class BloopCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.target = o.targetRate || 16000;
    this.ratio = sampleRate / this.target; // input samples per output sample
    this.frame = Math.round(this.target * ((o.frameMs || 40) / 1000));
    this.out = new Int16Array(this.frame);
    this.n = 0;
    this.pos = 0; // fractional position of the next output sample, in input samples
    this.acc = 0; // box-filter accumulator
    this.accN = 0;
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "mute") this.muted = !!e.data.muted;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.muted) {
      this.n = 0;
      return true;
    }
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN++;
      this.pos -= 1;
      if (this.pos <= 0) {
        // average the input samples since the last output sample (cheap anti-alias)
        let s = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        this.pos += this.ratio;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.frame) {
          const buf = this.out.slice(0).buffer;
          this.port.postMessage(buf, [buf]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

class BloopPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.step = (o.sourceRate || 24000) / sampleRate; // source samples per output sample
    this.prebuffer = Math.round(sampleRate * ((o.prebufferMs || 80) / 1000));
    this.cap = sampleRate * 120;
    this.buf = new Float32Array(sampleRate * 10);
    this.read = 0;
    this.write = 0;
    this.playing = false;
    this.frac = 0; // resampler phase
    this.prev = 0; // last source sample of the previous chunk
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) this.push(new Int16Array(d));
      else if (d && d.type === "flush") this.flush();
    };
  }

  size() {
    return this.write - this.read;
  }

  ensure(extra) {
    const len = this.size();
    if (this.write + extra <= this.buf.length) return;
    if (len + extra > this.buf.length) {
      const next = new Float32Array(Math.min(this.cap, Math.max(this.buf.length * 2, len + extra)));
      next.set(this.buf.subarray(this.read, this.write));
      this.buf = next;
    } else {
      this.buf.copyWithin(0, this.read, this.write);
    }
    this.read = 0;
    this.write = len;
  }

  push(pcm) {
    // linear-interpolate source-rate PCM to the context rate, carrying phase across chunks
    const outCount = Math.floor((pcm.length - this.frac) / this.step) + 1;
    if (outCount <= 0) return;
    this.ensure(outCount);
    if (this.size() + outCount > this.cap) return; // runaway guard
    let t = this.frac;
    let w = this.write;
    while (t < pcm.length) {
      const i = Math.floor(t);
      const a = i === 0 ? this.prev : pcm[i - 1] / 0x8000;
      const b = pcm[i] / 0x8000;
      const f = t - i;
      this.buf[w++] = a + (b - a) * f;
      t += this.step;
    }
    this.frac = t - pcm.length;
    this.prev = pcm[pcm.length - 1] / 0x8000;
    this.write = w;
  }

  flush() {
    this.read = 0;
    this.write = 0;
    this.playing = false;
    this.frac = 0;
    this.prev = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.playing && this.size() >= this.prebuffer) this.playing = true;
    if (!this.playing) {
      out.fill(0);
      return true;
    }
    const n = Math.min(out.length, this.size());
    out.set(this.buf.subarray(this.read, this.read + n));
    if (n < out.length) out.fill(0, n);
    this.read += n;
    if (this.size() === 0) {
      this.playing = false;
      this.port.postMessage({ type: "drained" });
    }
    return true;
  }
}

registerProcessor("bloop-capture", BloopCapture);
registerProcessor("bloop-player", BloopPlayer);
