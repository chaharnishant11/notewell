import { encodeAudioFrame, type ServerMessage, type Source } from "../shared/protocol.js";

export interface CaptureCallbacks {
  onMessage(message: ServerMessage): void;
  /** Peak level 0..1 per source, ~10 times a second, for meters. */
  onLevel(source: Source, level: number): void;
  onEnded(reason: string): void;
}

interface ActiveSource {
  stream: MediaStream;
  node: AudioWorkletNode;
  input: MediaStreamAudioSourceNode;
}

/**
 * Browser side of recording. The microphone comes from getUserMedia (with
 * echo cancellation so your speakers are not transcribed twice); "system"
 * audio comes from getDisplayMedia, where the user shares a tab, window or
 * the whole screen with audio. Each stream is converted to PCM16 by an
 * AudioWorklet and sent to the local server tagged with its source.
 */
export class Recorder {
  private context: AudioContext | undefined;
  private socket: WebSocket | undefined;
  private sources = new Map<Source, ActiveSource>();

  constructor(private readonly callbacks: CaptureCallbacks) {}

  get recording(): boolean {
    return this.socket !== undefined;
  }

  async start(meetingId: string, wanted: { microphone: boolean; system: boolean }): Promise<void> {
    if (this.socket) throw new Error("already recording");
    const streams = new Map<Source, MediaStream>();
    try {
      if (wanted.system) streams.set("system", await captureSystemAudio());
      if (wanted.microphone) streams.set("microphone", await captureMicrophone());
    } catch (err) {
      for (const s of streams.values()) stopTracks(s);
      throw err;
    }
    if (streams.size === 0) throw new Error("choose at least one audio source");

    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule("/app/web/capture-worklet.js");

    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/meetings/${meetingId}/live`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("could not connect to the local server")), { once: true });
    });
    socket.addEventListener("message", (e) => {
      if (typeof e.data === "string") this.callbacks.onMessage(JSON.parse(e.data) as ServerMessage);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) void this.teardown("connection closed");
    });

    const sampleRate = this.context.sampleRate;
    socket.send(JSON.stringify({ type: "start", sampleRates: Object.fromEntries([...streams.keys()].map((s) => [s, sampleRate])) }));

    for (const [source, stream] of streams) {
      const input = this.context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(this.context, "pcm-capture", { numberOfOutputs: 0, channelCountMode: "max" });
      node.port.onmessage = (e: MessageEvent<Int16Array>) => {
        this.callbacks.onLevel(source, peak(e.data));
        if (socket.readyState === WebSocket.OPEN) socket.send(encodeAudioFrame(source, e.data));
      };
      input.connect(node);
      this.sources.set(source, { stream, node, input });
      // Ending a screen share from the browser's own UI stops that source.
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => void this.stop(`${source === "system" ? "screen share" : "microphone"} ended`));
      }
    }
  }

  async stop(reason = "stopped"): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.releaseAudio();
    if (socket.readyState === WebSocket.OPEN) {
      // Let the server flush the last utterances before closing.
      const stopped = new Promise<void>((resolve) => {
        const onMessage = (e: MessageEvent) => {
          if (typeof e.data === "string" && (JSON.parse(e.data) as ServerMessage).type === "stopped") resolve();
        };
        socket.addEventListener("message", onMessage);
        setTimeout(resolve, 60_000);
      });
      socket.send(JSON.stringify({ type: "stop" }));
      await stopped;
    }
    await this.teardown(reason);
  }

  private releaseAudio(): void {
    for (const { stream, node, input } of this.sources.values()) {
      input.disconnect();
      node.port.onmessage = null;
      stopTracks(stream);
    }
    this.sources.clear();
    void this.context?.close();
    this.context = undefined;
  }

  private async teardown(reason: string): Promise<void> {
    this.releaseAudio();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    if (socket) this.callbacks.onEnded(reason);
  }
}

async function captureMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

async function captureSystemAudio(): Promise<MediaStream> {
  const options = {
    video: true, // required by browsers; the video track is dropped right away
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: "include",
    selfBrowserSurface: "exclude",
  } as DisplayMediaStreamOptions;
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  if (stream.getAudioTracks().length === 0) {
    throw new Error('No audio was shared. Share again and turn on "Share tab audio" or "Share system audio".');
  }
  return stream;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function peak(pcm: Int16Array): number {
  let max = 0;
  for (let i = 0; i < pcm.length; i += 4) max = Math.max(max, Math.abs(pcm[i]!));
  return max / 32768;
}
