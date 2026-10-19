/**
 * Tiny Markdown → DOM renderer for model output. It builds nodes with
 * textContent (never innerHTML), so model text cannot inject markup, and it
 * only links http(s) URLs. Supports what enhanced notes use: headings,
 * nested bullet/numbered lists, paragraphs, quotes, rules, **bold**,
 * *italic*, `code` and [links](https://…).
 */
export interface RenderOptions {
  /** Marks blocks whose text the user wrote themselves (shown in ink). */
  isUserText?: (plain: string) => boolean;
}

interface ListFrame {
  indent: number;
  el: HTMLOListElement | HTMLUListElement;
}

export function renderMarkdown(markdown: string, options: RenderOptions = {}): DocumentFragment {
  const root = document.createDocumentFragment();
  const lists: ListFrame[] = [];
  let paragraph: string[] = [];

  const mark = (el: HTMLElement, plain: string) => {
    if (options.isUserText?.(plain)) el.classList.add("mine");
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ");
    const p = document.createElement("p");
    appendInline(p, text);
    mark(p, text);
    root.append(p);
    paragraph = [];
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists.at(-1)!.indent > toIndent) lists.pop();
  };

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\t/g, "    ");
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      closeLists(indent);
      let frame = lists.at(-1);
      if (!frame || frame.indent < indent || (frame.el.tagName === "OL") !== ordered) {
        if (frame && frame.indent === indent) lists.pop();
        const el = document.createElement(ordered ? "ol" : "ul");
        const parentItem = lists.at(-1)?.el.lastElementChild;
        (parentItem ?? root).append(el);
        frame = { indent, el };
        lists.push(frame);
      }
      const li = document.createElement("li");
      appendInline(li, item[3]!);
      mark(li, item[3]!);
      frame.el.append(li);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeLists();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = Math.min(6, heading[1]!.length + 1); // the page title owns h1
      const h = document.createElement(`h${level}`);
      appendInline(h, heading[2]!);
      root.append(h);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      closeLists();
      root.append(document.createElement("hr"));
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushParagraph();
      closeLists();
      const q = document.createElement("blockquote");
      appendInline(q, trimmed.replace(/^>\s?/, ""));
      root.append(q);
      continue;
    }
    closeLists();
    paragraph.push(trimmed);
  }
  flushParagraph();
  return root;
}

const INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/;

function appendInline(parent: HTMLElement, text: string): void {
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      parent.append(rest);
      return;
    }
    if (m.index > 0) parent.append(rest.slice(0, m.index));
    const [whole, , bold1, bold2, em1, em2, code, linkText, href] = m;
    if (bold1 ?? bold2) {
      const el = document.createElement("strong");
      appendInline(el, (bold1 ?? bold2)!);
      parent.append(el);
    } else if (em1 ?? em2) {
      const el = document.createElement("em");
      appendInline(el, (em1 ?? em2)!);
      parent.append(el);
    } else if (code) {
      const el = document.createElement("code");
      el.textContent = code;
      parent.append(el);
    } else if (linkText && href) {
      if (/^https?:\/\//i.test(href)) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = linkText;
        parent.append(a);
      } else {
        parent.append(linkText);
      }
    }
    rest = rest.slice(m.index + whole!.length);
  }
}
