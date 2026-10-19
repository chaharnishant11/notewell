/** Incremental parser for `text/event-stream` bodies (WHATWG SSE format). */

export interface ServerSentEvent {
  event: string;
  data: string;
  id?: string;
}

export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "message";
  let id: string | undefined;

  const dispatch = (): ServerSentEvent | undefined => {
    if (data.length === 0) {
      event = "message";
      return undefined;
    }
    const out: ServerSentEvent = { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
    data = [];
    event = "message";
    return out;
  };

  const handleLine = (line: string): ServerSentEvent | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    return undefined;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, newline);
      const width = buffer.startsWith("\r\n", newline) ? 2 : 1;
      buffer = buffer.slice(newline + width);
      const out = handleLine(line);
      if (out) yield out;
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    const out = handleLine(buffer);
    if (out) yield out;
  }
  const last = dispatch();
  if (last) yield last;
}
