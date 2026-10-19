import { makeUserTextMatcher } from "../shared/attribution.js";
import type { Segment, ServerMessage, Source } from "../shared/protocol.js";
import { parseSse } from "../shared/sse.js";
import { Recorder } from "./capture.js";
import { renderMarkdown } from "./markdown.js";

interface MeetingSummary {
  id: string;
  title: string;
  createdAt: string;
  hasEnhanced: boolean;
}

interface Meeting {
  id: string;
  title: string;
  context: string;
  notes: string;
  transcript: Segment[];
  enhanced: { templateId: string; markdown: string; model: string } | null;
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
};

const ui = {
  meetings: $<HTMLUListElement>("#meetings"),
  newMeeting: $<HTMLButtonElement>("#new-meeting"),
  llmStatus: $<HTMLParagraphElement>("#llm-status"),
  empty: $<HTMLDivElement>("#empty"),
  meeting: $<HTMLElement>("#meeting"),
  title: $<HTMLInputElement>("#title"),
  context: $<HTMLTextAreaElement>("#context"),
  notes: $<HTMLTextAreaElement>("#notes"),
  enhanced: $<HTMLElement>("#enhanced"),
  template: $<HTMLSelectElement>("#template"),
  enhance: $<HTMLButtonElement>("#enhance"),
  copy: $<HTMLButtonElement>("#copy"),
  status: $<HTMLSpanElement>("#status"),
  record: $<HTMLButtonElement>("#record"),
  useMic: $<HTMLInputElement>("#use-mic"),
  useSystem: $<HTMLInputElement>("#use-system"),
  segments: $<HTMLOListElement>("#segments"),
  transcriptEmpty: $<HTMLParagraphElement>("#transcript-empty"),
};

let current: Meeting | undefined;
const segments = new Map<string, Segment>();
let enhancedMarkdown = "";
let enhancing: AbortController | undefined;

const recorder = new Recorder({
  onMessage: handleServerMessage,
  onLevel: (source, level) => {
    if (!recorder.recording) return; // late batches after stop
    document.querySelector<HTMLElement>(`.meter[data-source="${source}"]`)?.style.setProperty("--level", String(Math.min(1, level * 3)));
  },
  onEnded: (reason) => {
    setRecording(false);
    setStatus(reason === "stopped" ? "Transcription stopped." : `Transcription stopped: ${reason}.`);
    maybeAutoEnhance();
  },
});

/**
 * Like Granola, write the notes automatically when a substantial meeting
 * ends, but never overwrite notes that were already enhanced.
 */
const AUTO_ENHANCE_MIN_CHARS = 2500;
function maybeAutoEnhance(): void {
  if (!current || current.enhanced || enhancing) return;
  let chars = 0;
  for (const s of segments.values()) if (s.final) chars += s.text.length;
  if (chars >= AUTO_ENHANCE_MIN_CHARS) void enhance();
}

// ---------------------------------------------------------------- api

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

// ---------------------------------------------------------------- meetings

async function refreshMeetings(): Promise<void> {
  const list = await api<MeetingSummary[]>("/api/meetings");
  ui.meetings.replaceChildren(
    ...list.map((m) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.setAttribute("aria-current", String(m.id === current?.id));
      const title = document.createElement("span");
      title.textContent = m.title;
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = new Date(m.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      button.append(title, when);
      button.addEventListener("click", () => void openMeeting(m.id));
      li.append(button);
      return li;
    }),
  );
}

async function openMeeting(id: string): Promise<void> {
  if (recorder.recording) {
    setStatus("Stop transcribing before switching meetings.");
    return;
  }
  enhancing?.abort();
  current = await api<Meeting>(`/api/meetings/${id}`);
  ui.empty.hidden = true;
  ui.meeting.hidden = false;
  ui.title.value = current.title;
  ui.context.value = current.context;
  ui.notes.value = current.notes;
  segments.clear();
  for (const s of current.transcript) segments.set(s.id, s);
  renderTranscript();
  enhancedMarkdown = current.enhanced?.markdown ?? "";
  if (current.enhanced) ui.template.value = current.enhanced.templateId;
  renderEnhanced();
  selectTab(current.enhanced ? "enhanced" : "notes");
  setStatus("");
  location.hash = id;
  await refreshMeetings();
}

async function createMeeting(): Promise<void> {
  const meeting = await api<Meeting>("/api/meetings", { method: "POST", body: "{}" });
  await openMeeting(meeting.id);
  ui.title.select();
}

/** Debounced autosave of title, context and notes. */
const saveTimers = new Map<string, number>();
function autosave(field: "title" | "context" | "notes", value: string): void {
  if (!current) return;
  const id = current.id;
  current[field] = value;
  window.clearTimeout(saveTimers.get(field));
  saveTimers.set(
    field,
    window.setTimeout(() => {
      api(`/api/meetings/${id}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) })
        .then(() => (field === "title" ? refreshMeetings() : undefined))
        .catch((err: Error) => setStatus(`Could not save: ${err.message}`));
    }, 500),
  );
}

// ---------------------------------------------------------------- recording

async function toggleRecording(): Promise<void> {
  if (!current) return;
  if (recorder.recording) {
    ui.record.disabled = true;
    setStatus("Finishing the last sentences…");
    await recorder.stop();
    ui.record.disabled = false;
    return;
  }
  try {
    ui.record.disabled = true;
    setStatus("Starting…");
    await recorder.start(current.id, { microphone: ui.useMic.checked, system: ui.useSystem.checked });
    setRecording(true);
    setStatus("Loading speech models…");
  } catch (err) {
    setStatus((err as Error).message);
  } finally {
    ui.record.disabled = false;
  }
}

function setRecording(on: boolean): void {
  ui.record.classList.toggle("on", on);
  ui.record.textContent = on ? "■ Stop" : "● Start transcribing";
  ui.useMic.disabled = on;
  ui.useSystem.disabled = on;
  if (!on) {
    for (const el of document.querySelectorAll<HTMLElement>(".meter")) el.style.setProperty("--level", "0");
    for (const el of document.querySelectorAll<HTMLElement>(".speaking")) el.classList.remove("on");
  }
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "ready":
      setStatus(`Transcribing locally (${message.asr.replace(/^whisper:/, "")}, VAD: ${message.vad}).`);
      break;
    case "segment":
      segments.set(message.segment.id, message.segment);
      if (message.segment.final && !message.segment.text) segments.delete(message.segment.id);
      renderTranscript();
      break;
    case "speech":
      document.querySelector(`.speaking[data-source="${message.source}"]`)?.classList.toggle("on", message.speaking);
      break;
    case "error":
      setStatus(message.message);
      break;
    case "stopped":
      break;
  }
}

function renderTranscript(): void {
  const panel = ui.segments.parentElement!;
  const stick = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
  const ordered = [...segments.values()].sort((a, b) => a.startMs - b.startMs);
  const turns: { source: Source; startMs: number; parts: Segment[] }[] = [];
  for (const s of ordered) {
    const last = turns.at(-1);
    if (last && last.source === s.source) last.parts.push(s);
    else turns.push({ source: s.source, startMs: s.startMs, parts: [s] });
  }
  ui.segments.replaceChildren(
    ...turns.map((turn) => {
      const li = document.createElement("li");
      li.className = `turn ${turn.source}`;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${turn.source === "microphone" ? "Me" : "Them"} · ${clock(turn.startMs)}`;
      li.append(meta);
      for (const part of turn.parts) {
        const span = document.createElement("span");
        if (!part.final) span.className = "interim";
        span.textContent = `${part.text} `;
        li.append(span);
      }
      return li;
    }),
  );
  ui.transcriptEmpty.hidden = turns.length > 0;
  if (stick) panel.scrollTop = panel.scrollHeight;
}

// ---------------------------------------------------------------- enhancement

async function enhance(): Promise<void> {
  if (!current) return;
  enhancing?.abort();
  const abort = new AbortController();
  enhancing = abort;
  const meetingId = current.id;
  enhancedMarkdown = "";
  selectTab("enhanced");
  ui.enhanced.classList.add("streaming");
  ui.enhance.disabled = true;
  setStatus("Writing notes…");
  try {
    const response = await fetch(`/api/meetings/${meetingId}/enhance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: ui.template.value }),
      signal: abort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`enhance failed (${response.status})`);
    for await (const event of parseSse(readerToIterable(response.body))) {
      const data = JSON.parse(event.data) as { text?: string; message?: string; markdown?: string; model?: string };
      if (event.event === "delta" && data.text) {
        enhancedMarkdown += data.text;
        scheduleEnhancedRender();
      } else if (event.event === "done") {
        enhancedMarkdown = data.markdown ?? enhancedMarkdown;
        if (current?.id === meetingId) current.enhanced = data as Meeting["enhanced"];
        setStatus(`Enhanced with ${data.model ?? "the model"}.`);
      } else if (event.event === "error") {
        throw new Error(data.message ?? "enhancement failed");
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) setStatus((err as Error).message);
  } finally {
    if (enhancing === abort) enhancing = undefined;
    ui.enhanced.classList.remove("streaming");
    ui.enhance.disabled = false;
    renderEnhanced();
    void refreshMeetings();
  }
}

let renderQueued = false;
function scheduleEnhancedRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderEnhanced();
  });
}

function renderEnhanced(): void {
  const isUserText = makeUserTextMatcher(ui.notes.value);
  if (enhancedMarkdown) {
    ui.enhanced.replaceChildren(renderMarkdown(enhancedMarkdown, { isUserText }));
  } else {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No enhanced notes yet. Pick a template and press “Enhance notes”.";
    ui.enhanced.replaceChildren(p);
  }
  ui.copy.hidden = !enhancedMarkdown;
}

async function* readerToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------- misc

function selectTab(tab: "notes" | "enhanced"): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  }
  ui.notes.hidden = tab !== "notes";
  ui.enhanced.hidden = tab !== "enhanced";
}

function setStatus(text: string): void {
  ui.status.textContent = text;
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function init(): Promise<void> {
  ui.newMeeting.addEventListener("click", () => void createMeeting());
  ui.record.addEventListener("click", () => void toggleRecording());
  ui.enhance.addEventListener("click", () => void enhance());
  ui.copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(enhancedMarkdown).then(() => setStatus("Copied."));
  });
  ui.title.addEventListener("input", () => autosave("title", ui.title.value));
  ui.context.addEventListener("input", () => autosave("context", ui.context.value));
  ui.notes.addEventListener("input", () => autosave("notes", ui.notes.value));
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
    b.addEventListener("click", () => selectTab(b.dataset.tab as "notes" | "enhanced"));
  }
  window.addEventListener("beforeunload", (e) => {
    if (recorder.recording) e.preventDefault();
  });

  const [templates, status] = await Promise.all([
    api<{ id: string; name: string; description: string }[]>("/api/templates"),
    api<{ llm: { provider: string; model: string } }>("/api/status"),
  ]);
  ui.template.replaceChildren(
    ...templates.map((t) => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name;
      o.title = t.description;
      return o;
    }),
  );
  ui.llmStatus.textContent = `Notes by ${status.llm.provider} · ${status.llm.model}`;

  await refreshMeetings();
  const fromHash = location.hash.slice(1);
  if (/^[0-9a-f-]{36}$/.test(fromHash)) await openMeeting(fromHash).catch(() => undefined);
}

void init().catch((err: Error) => setStatus(err.message));
