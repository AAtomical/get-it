/**
 * Server-side Markdown → PDF rendering.
 *
 * Get It. is built around a PDF: the viewer renders the document page by
 * page and overlays concept tags at real PDF-space coordinates, and every
 * agent reads the per-page text that `lib/pdf-extract.ts` pulls out. To let
 * students study from a `.md` file without rebuilding any of that, we turn
 * the markdown into a clean, text-bearing PDF up front and then feed it
 * through the exact same `extractPdf` pipeline as a normal upload.
 *
 * We tokenize with `marked` (already a project dependency) and lay the
 * tokens out with `pdfkit` (the same library `scripts/generate-sample-pdfs.ts`
 * uses to mint the bundled sample documents), so this adds no new runtime
 * dependency. The standard PDF fonts cover Latin scripts; non-Latin scripts
 * (CJK, etc.) would need an embedded font and are a deliberate follow-up.
 */

import PDFDocument from "pdfkit";
import { marked, type Token, type Tokens } from "marked";

/**
 * Reject absurdly large markdown before we spend time rendering it. The
 * extracted PDF still has to clear `MAX_PDF_PAGES`, but bailing on the raw
 * text first keeps a pathological paste from pinning a CPU. ~1M characters
 * is far longer than any real study document.
 */
export const MAX_MARKDOWN_BYTES = 1_000_000;

export class MarkdownEmptyError extends Error {
  constructor() {
    super("This Markdown file has no readable text.");
    this.name = "MarkdownEmptyError";
  }
}

export class MarkdownTooLargeError extends Error {
  constructor() {
    super("This Markdown file is too large to import.");
    this.name = "MarkdownTooLargeError";
  }
}

// ── Page geometry & palette ─────────────────────────────────────────────
// A4 in PDF points, with comfortable reading margins. Mirrors the editorial
// "ink on warm white" look of the bundled samples and the writeup PDF.

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 64;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const PAGE_BOTTOM = PAGE.height - MARGIN;

const INK_900 = "#0f172a";
const INK_700 = "#1e293b";
const INK_500 = "#64748b";
const ACCENT = "#4f5ae0";
const RULE = "#cbd5e1";
const CODE_BG = "#f3f2ef";

const FONT = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  italic: "Helvetica-Oblique",
  boldItalic: "Helvetica-BoldOblique",
  mono: "Courier",
} as const;

/** Point size per heading depth (h1…h6). */
const HEADING_SIZE = [22, 17, 14, 12.5, 11.5, 11];
const BODY_SIZE = 11;
const CODE_SIZE = 9;
const LINE_GAP = 2.5;

type PDFKitDoc = InstanceType<typeof PDFDocument>;

/** Inline run after emphasis/link nesting has been flattened to leaves. */
type Segment = {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  link?: string;
};

type Style = { bold: boolean; italic: boolean };

const BASE_STYLE: Style = { bold: false, italic: false };

/** Decode the handful of HTML entities `marked` leaves encoded in token text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Walk an inline token tree (the `tokens` array on a paragraph, heading,
 * list item, …) and flatten it to a flat list of styled leaf runs that
 * pdfkit can emit as one continued line.
 */
function flattenInline(tokens: Token[] | undefined, style: Style, out: Segment[]): void {
  if (!tokens) return;
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length) flattenInline(t.tokens, style, out);
        else out.push({ text: decodeEntities(t.text), bold: style.bold, italic: style.italic, mono: false });
        break;
      }
      case "escape": {
        const t = token as Tokens.Escape;
        out.push({ text: t.text, bold: style.bold, italic: style.italic, mono: false });
        break;
      }
      case "strong":
        flattenInline((token as Tokens.Strong).tokens, { ...style, bold: true }, out);
        break;
      case "em":
        flattenInline((token as Tokens.Em).tokens, { ...style, italic: true }, out);
        break;
      case "del":
        flattenInline((token as Tokens.Del).tokens, style, out);
        break;
      case "codespan": {
        const t = token as Tokens.Codespan;
        out.push({ text: decodeEntities(t.text), bold: style.bold, italic: style.italic, mono: true });
        break;
      }
      case "link": {
        const t = token as Tokens.Link;
        const before = out.length;
        flattenInline(t.tokens, style, out);
        for (let i = before; i < out.length; i++) out[i].link = t.href;
        break;
      }
      case "br":
        out.push({ text: "\n", bold: style.bold, italic: style.italic, mono: false });
        break;
      case "image": {
        // We can't lay out images with the standard pipeline; keep the alt
        // text so the document still reads and the detector has something.
        const t = token as Tokens.Image;
        if (t.text) out.push({ text: t.text, bold: style.bold, italic: style.italic, mono: false });
        break;
      }
      default: {
        const t = token as { text?: string };
        if (t.text) out.push({ text: decodeEntities(t.text), bold: style.bold, italic: style.italic, mono: false });
      }
    }
  }
}

function fontFor(seg: Segment): string {
  if (seg.mono) return FONT.mono;
  if (seg.bold && seg.italic) return FONT.boldItalic;
  if (seg.bold) return FONT.bold;
  if (seg.italic) return FONT.italic;
  return FONT.regular;
}

type EmitOpts = {
  size: number;
  color: string;
  indent?: number;
  width?: number;
  paragraphGap?: number;
};

/** Emit a run of flattened segments as a single wrapped paragraph. */
function emitSegments(doc: PDFKitDoc, segs: Segment[], opts: EmitOpts): void {
  const width = opts.width ?? CONTENT_WIDTH - (opts.indent ?? 0);
  if (segs.length === 0) {
    doc.text(" ", { width });
    return;
  }
  const last = segs.length - 1;
  segs.forEach((seg, i) => {
    doc
      .font(fontFor(seg))
      .fontSize(opts.size)
      .fillColor(seg.link ? ACCENT : opts.color);
    const textOpts: PDFKit.Mixins.TextOptions = {
      continued: i < last,
      width,
      lineGap: LINE_GAP,
    };
    if (i === last) textOpts.paragraphGap = opts.paragraphGap ?? 8;
    if (seg.link) {
      textOpts.link = seg.link;
      textOpts.underline = true;
    }
    doc.text(seg.text, textOpts);
  });
}

/** Add a page break before a block if it would otherwise be orphaned. */
function breakIfTight(doc: PDFKitDoc, needed: number): void {
  if (doc.y + needed > PAGE_BOTTOM) doc.addPage();
}

// ── Block renderers ─────────────────────────────────────────────────────

function renderHeading(doc: PDFKitDoc, token: Tokens.Heading): void {
  const size = HEADING_SIZE[Math.min(token.depth, HEADING_SIZE.length) - 1];
  breakIfTight(doc, size * 2.4);
  doc.moveDown(token.depth <= 2 ? 0.6 : 0.4);
  const segs: Segment[] = [];
  flattenInline(token.tokens, BASE_STYLE, segs);
  // Headings render in a single weight regardless of inline emphasis.
  for (const s of segs) s.bold = true;
  emitSegments(doc, segs, { size, color: INK_900, paragraphGap: 4 });
  doc.moveDown(0.25);
}

function renderParagraph(doc: PDFKitDoc, token: Tokens.Paragraph): void {
  const segs: Segment[] = [];
  flattenInline(token.tokens, BASE_STYLE, segs);
  emitSegments(doc, segs, { size: BODY_SIZE, color: INK_700, paragraphGap: 8 });
}

function renderList(doc: PDFKitDoc, token: Tokens.List, depth = 0): void {
  const indent = 18 + depth * 16;
  let index = typeof token.start === "number" ? token.start : 1;
  for (const item of token.items) {
    const marker = token.ordered ? `${index}.` : "•";
    breakIfTight(doc, BODY_SIZE * 2);
    const markerX = MARGIN + indent - 14;
    const y = doc.y;
    doc.font(FONT.regular).fontSize(BODY_SIZE).fillColor(INK_500).text(marker, markerX, y, {
      width: 14,
      lineGap: LINE_GAP,
    });
    // Render the item's own inline content next to the marker, then recurse
    // into any nested blocks (sub-lists) underneath it.
    doc.x = MARGIN + indent;
    doc.y = y;
    const inline: Segment[] = [];
    const nested: Tokens.List[] = [];
    for (const child of item.tokens) {
      if (child.type === "list") nested.push(child as Tokens.List);
      else if (child.type === "text") flattenInline((child as Tokens.Text).tokens ?? [child as Token], BASE_STYLE, inline);
      else flattenInline([child], BASE_STYLE, inline);
    }
    emitSegments(doc, inline, {
      size: BODY_SIZE,
      color: INK_700,
      indent,
      width: CONTENT_WIDTH - indent,
      paragraphGap: 3,
    });
    doc.x = MARGIN;
    for (const sub of nested) renderList(doc, sub, depth + 1);
    index++;
  }
  doc.moveDown(0.3);
}

function renderCode(doc: PDFKitDoc, token: Tokens.Code): void {
  const code = token.text.replace(/\n+$/, "");
  doc.font(FONT.mono).fontSize(CODE_SIZE);
  const innerWidth = CONTENT_WIDTH - 20;
  const height = doc.heightOfString(code, { width: innerWidth, lineGap: 2 });
  breakIfTight(doc, height + 16);
  const top = doc.y;
  doc
    .save()
    .rect(MARGIN, top, CONTENT_WIDTH, height + 14)
    .fill(CODE_BG)
    .restore();
  doc
    .font(FONT.mono)
    .fontSize(CODE_SIZE)
    .fillColor(INK_700)
    .text(code, MARGIN + 10, top + 7, { width: innerWidth, lineGap: 2 });
  doc.x = MARGIN;
  doc.y = top + height + 14;
  doc.moveDown(0.5);
}

function renderBlockquote(doc: PDFKitDoc, token: Tokens.Blockquote): void {
  const top = doc.y;
  doc.x = MARGIN + 16;
  for (const child of token.tokens) renderBlock(doc, child);
  const bottom = doc.y;
  doc
    .save()
    .lineWidth(2)
    .strokeColor(ACCENT)
    .moveTo(MARGIN + 4, top)
    .lineTo(MARGIN + 4, bottom)
    .stroke()
    .restore();
  doc.x = MARGIN;
  doc.moveDown(0.3);
}

function renderTable(doc: PDFKitDoc, token: Tokens.Table): void {
  const cols = token.header.length;
  if (cols === 0) return;
  const colWidth = CONTENT_WIDTH / cols;
  const cellText = (cell: Tokens.TableCell): string => {
    const segs: Segment[] = [];
    flattenInline(cell.tokens, BASE_STYLE, segs);
    return segs.map((s) => s.text).join("");
  };
  const drawRow = (cells: Tokens.TableCell[], header: boolean): void => {
    const font = header ? FONT.bold : FONT.regular;
    const color = header ? INK_500 : INK_700;
    doc.font(font).fontSize(header ? 9 : 10);
    const heights = cells.map((c) =>
      doc.heightOfString(cellText(c), { width: colWidth - 12 }),
    );
    const rowHeight = Math.max(...heights, 14) + 8;
    breakIfTight(doc, rowHeight);
    const top = doc.y;
    cells.forEach((c, i) => {
      doc
        .font(font)
        .fontSize(header ? 9 : 10)
        .fillColor(color)
        .text(cellText(c), MARGIN + i * colWidth, top + 4, { width: colWidth - 12 });
    });
    doc.y = top + rowHeight;
    doc
      .save()
      .lineWidth(0.7)
      .strokeColor(RULE)
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + CONTENT_WIDTH, doc.y)
      .stroke()
      .restore();
  };
  doc.moveDown(0.3);
  drawRow(token.header, true);
  for (const row of token.rows) drawRow(row, false);
  doc.x = MARGIN;
  doc.moveDown(0.5);
}

function renderHr(doc: PDFKitDoc): void {
  doc.moveDown(0.4);
  doc
    .save()
    .lineWidth(0.7)
    .strokeColor(RULE)
    .moveTo(MARGIN, doc.y)
    .lineTo(MARGIN + CONTENT_WIDTH, doc.y)
    .stroke()
    .restore();
  doc.moveDown(0.5);
}

function renderBlock(doc: PDFKitDoc, token: Token): void {
  switch (token.type) {
    case "heading":
      renderHeading(doc, token as Tokens.Heading);
      break;
    case "paragraph":
      renderParagraph(doc, token as Tokens.Paragraph);
      break;
    case "list":
      renderList(doc, token as Tokens.List);
      break;
    case "code":
      renderCode(doc, token as Tokens.Code);
      break;
    case "blockquote":
      renderBlockquote(doc, token as Tokens.Blockquote);
      break;
    case "table":
      renderTable(doc, token as Tokens.Table);
      break;
    case "hr":
      renderHr(doc);
      break;
    case "space":
      doc.moveDown(0.4);
      break;
    case "html":
      break; // raw HTML is dropped — we render text, not markup
    default: {
      // Anything else with text (e.g. a bare text block) still gets rendered.
      const t = token as { text?: string };
      if (t.text && t.text.trim()) {
        doc.font(FONT.regular).fontSize(BODY_SIZE).fillColor(INK_700).text(decodeEntities(t.text), {
          width: CONTENT_WIDTH,
          lineGap: LINE_GAP,
          paragraphGap: 8,
        });
      }
    }
  }
}

/**
 * Render a Markdown string to PDF bytes. The returned buffer is a normal,
 * text-bearing PDF that `extractPdf` reads exactly like any other upload.
 */
export async function markdownToPdf(markdown: string): Promise<Buffer> {
  if (Buffer.byteLength(markdown, "utf-8") > MAX_MARKDOWN_BYTES) {
    throw new MarkdownTooLargeError();
  }
  if (!markdown.trim()) {
    throw new MarkdownEmptyError();
  }

  const tokens = marked.lexer(markdown, { gfm: true });

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Producer: "Get It. Markdown Importer" },
    bufferPages: true,
    pdfVersion: "1.7",
    lang: "en-US",
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.x = MARGIN;
  for (const token of tokens) renderBlock(doc, token);

  doc.end();
  return done;
}
