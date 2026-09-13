/** Mic capture + agent playback on one AudioContext, via same-origin AudioWorklets. */

export interface AudioEngineOptions {
  inputRate: number;
  outputRate: number;
  onPcm: (frame: ArrayBuffer) => void;
  onDrained: () => void;
}

export function voiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export class AudioEngine {
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private player: AudioWorkletNode | null = null;
  private micAnalyser: AnalyserNode;
  private outAnalyser: AnalyserNode;
  private scratch = new Float32Array(1024);
  private closed = false;
  /** true while agent audio has been queued and not yet reported drained */
  pending = false;

  /** `ctx` must be created synchronously inside the user gesture (Safari autoplay rules). */
  constructor(
    readonly ctx: AudioContext,
    private opts: AudioEngineOptions
  ) {
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 1024;
  }

  /** Requests the mic and wires the graph. Throws DOMException (NotAllowedError, NotFoundError…). */
  async start(): Promise<void> {
    const ctx = this.ctx;
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    if (this.closed) {
      this.stopTracks();
      return;
    }
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}voice-worklet.js`);
    if (this.closed) return;

    const src = ctx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(ctx, "bloop-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: this.opts.inputRate, frameMs: 40 }
    });
    this.capture.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.opts.onPcm(e.data);
    };
    // keep the capture node pulled without echoing the mic
    const silent = ctx.createGain();
    silent.gain.value = 0;
    src.connect(this.micAnalyser);
    src.connect(this.capture).connect(silent).connect(ctx.destination);

    this.player = new AudioWorkletNode(ctx, "bloop-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sourceRate: this.opts.outputRate, prebufferMs: 80 }
    });
    this.player.port.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === "drained") {
        this.pending = false;
        this.opts.onDrained();
      }
    };
    this.player.connect(this.outAnalyser).connect(ctx.destination);
  }

  play(pcm: ArrayBuffer) {
    if (!this.player || pcm.byteLength < 2) return;
    // Int16Array needs an even byte length
    const buf = pcm.byteLength % 2 ? pcm.slice(0, pcm.byteLength - 1) : pcm;
    this.pending = true;
    this.player.port.postMessage(buf, [buf]);
  }

  /** barge-in: drop everything queued */
  flush() {
    this.pending = false;
    this.player?.port.postMessage({ type: "flush" });
  }

  setMuted(muted: boolean) {
    this.capture?.port.postMessage({ type: "mute", muted });
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  /** RMS levels 0..1 (roughly perceptual) */
  levels(): { mic: number; out: number } {
    return { mic: this.rms(this.micAnalyser), out: this.rms(this.outAnalyser) };
  }

  private rms(a: AnalyserNode): number {
    if (this.scratch.length !== a.fftSize) this.scratch = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.scratch);
    let sum = 0;
    for (let i = 0; i < this.scratch.length; i++) sum += this.scratch[i] * this.scratch[i];
    return Math.min(1, Math.sqrt(sum / this.scratch.length) * 4);
  }

  private stopTracks() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopTracks();
    try {
      this.capture?.disconnect();
      this.player?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.capture = null;
    this.player = null;
    void this.ctx.close().catch(() => {});
  }
}
