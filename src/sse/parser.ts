export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface SseParserHandlers {
  onEvent(event: SseEvent): void;
  onComment?(comment: string): void;
}

export class SseParser {
  readonly #decoder = new TextDecoder();
  readonly #handlers: SseParserHandlers;
  #buffer = "";
  #eventType = "";
  #dataLines: string[] = [];
  #lastEventId: string | undefined;

  constructor(handlers: SseParserHandlers) {
    this.#handlers = handlers;
  }

  push(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    this.#drainLines(false);
  }

  finish(): void {
    this.#buffer += this.#decoder.decode();
    this.#drainLines(true);
  }

  #drainLines(final: boolean): void {
    while (this.#buffer.length > 0) {
      const lineEnd = this.#findLineEnd(final);
      if (lineEnd === -1) {
        if (final) {
          this.#processLine(this.#buffer);
          this.#buffer = "";
        }
        return;
      }

      const line = this.#buffer.slice(0, lineEnd);
      const separatorLength =
        this.#buffer[lineEnd] === "\r" && this.#buffer[lineEnd + 1] === "\n" ? 2 : 1;
      this.#buffer = this.#buffer.slice(lineEnd + separatorLength);
      this.#processLine(line);
    }
  }

  #findLineEnd(final: boolean): number {
    for (let index = 0; index < this.#buffer.length; index += 1) {
      const character = this.#buffer[index];
      if (character === "\n") {
        return index;
      }
      if (character === "\r") {
        if (index === this.#buffer.length - 1 && !final) {
          return -1;
        }
        return index;
      }
    }
    return -1;
  }

  #processLine(line: string): void {
    if (line === "") {
      this.#dispatch();
      return;
    }

    if (line.startsWith(":")) {
      const comment = line.startsWith(": ") ? line.slice(2) : line.slice(1);
      this.#handlers.onComment?.(comment);
      return;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "event":
        this.#eventType = value;
        break;
      case "data":
        this.#dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) {
          this.#lastEventId = value;
        }
        break;
      default:
        break;
    }
  }

  #dispatch(): void {
    if (this.#dataLines.length === 0) {
      this.#eventType = "";
      return;
    }

    const event: SseEvent = {
      event: this.#eventType || "message",
      data: this.#dataLines.join("\n"),
    };
    if (this.#lastEventId !== undefined) {
      event.id = this.#lastEventId;
    }
    this.#handlers.onEvent(event);
    this.#eventType = "";
    this.#dataLines = [];
  }
}
