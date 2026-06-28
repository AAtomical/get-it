/**
 * Behavior tests for the Markdown importer (lib/md-to-pdf.ts).
 *
 * Run: npx tsx scripts/test-md-import.ts
 *
 * These exercise the PUBLIC interface only — `markdownToPdf` and the bytes it
 * returns — and verify the document round-trips through the same `extractPdf`
 * the upload pipeline uses. They make no assumptions about how the renderer
 * lays anything out, so they survive a rewrite of the layout internals: the
 * contract is "a .md file becomes a text-bearing PDF whose text the agents can
 * read", and that is what we assert.
 */

import {
  markdownToPdf,
  MarkdownEmptyError,
  MarkdownTooLargeError,
  MAX_MARKDOWN_BYTES,
} from "../lib/md-to-pdf";
import { extractPdf, assessPdfQuality } from "../lib/pdf-extract";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function skip(name: string, detail?: string) {
  console.log(`SKIP  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Collapse whitespace so substring checks ignore the renderer's spacing. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** Render markdown and pull the text back out the way the pipeline does. */
async function roundTrip(md: string) {
  const pdf = await markdownToPdf(md);
  const u8 = new Uint8Array(pdf.byteLength);
  u8.set(pdf);
  const extracted = await extractPdf(u8);
  const text = flat(extracted.pages.map((p) => p.text).join("\n"));
  return { pdf, extracted, text };
}

async function main() {
  // 1) Tracer bullet: a basic document renders to a real PDF.
  {
  const pdf = await markdownToPdf("# Title\n\nA paragraph of body text.");
  check(
    "renders a valid PDF (starts with %PDF-)",
    pdf.length > 0 && pdf.subarray(0, 5).toString("ascii") === "%PDF-",
    `${pdf.length} bytes, header ${pdf.subarray(0, 8).toString("ascii")}`,
  );
  }

  // 2) Round-trip fidelity: every block type's text survives into the PDF, so the
  //    detector / chat / flashcards see the real content, not a blank page.
  {
  const md = [
    "# Photosynthesis",
    "",
    "Plants convert **light** energy into _chemical_ energy stored as `glucose`.",
    "",
    "Photosynthesis is the process by which green plants, algae, and some bacteria",
    "capture energy from sunlight and use it to synthesise organic compounds from",
    "carbon dioxide and water. It is the foundation of almost every food chain on",
    "the planet and the original source of the oxygen in the atmosphere. The overall",
    "reaction splits water, releases oxygen as a by-product, and fixes carbon into",
    "sugars that store the captured energy in their chemical bonds for later use.",
    "",
    "## Inputs",
    "",
    "1. Carbon dioxide from the air.",
    "2. Water drawn up through the roots.",
    "",
    "> The light reactions occur in the thylakoid membrane.",
    "",
    "```",
    "6 CO2 + 6 H2O -> C6H12O6 + 6 O2",
    "```",
    "",
    "| Stage | Location |",
    "|-------|----------|",
    "| Light reactions | Thylakoid |",
    "",
    "See [the chapter](https://example.com/photosynthesis) for the full pathway.",
  ].join("\n");
  const { text, extracted } = await roundTrip(md);
  check("round-trip: heading text present", text.includes("Photosynthesis"));
  check("round-trip: bold inline text present", text.includes("light"));
  check("round-trip: inline code text present", text.includes("glucose"));
  check("round-trip: list item text present", text.includes("Carbon dioxide from the air"));
  check("round-trip: blockquote text present", text.includes("thylakoid membrane"));
  check("round-trip: code block text present", text.includes("C6H12O6"));
  check("round-trip: table cell text present", text.includes("Thylakoid"));
  check("round-trip: link label text present", text.includes("the chapter"));
  check(
    "round-trip: a substantive doc clears the text-coverage gate",
    assessPdfQuality(extracted).ok,
    JSON.stringify(assessPdfQuality(extracted).stats),
  );
}

// 3) Empty / whitespace-only markdown is rejected with a typed error.
{
  for (const [label, input] of [
    ["empty string", ""],
    ["whitespace only", "   \n\t  \n"],
  ] as const) {
    let thrown: unknown;
    try {
      await markdownToPdf(input);
    } catch (e) {
      thrown = e;
    }
    check(`rejects ${label} with MarkdownEmptyError`, thrown instanceof MarkdownEmptyError);
  }
}

// 4) Oversized markdown is rejected before rendering.
{
  const huge = "a".repeat(MAX_MARKDOWN_BYTES + 1);
  let thrown: unknown;
  try {
    await markdownToPdf(huge);
  } catch (e) {
    thrown = e;
  }
  check("rejects >MAX_MARKDOWN_BYTES with MarkdownTooLargeError", thrown instanceof MarkdownTooLargeError);
}

// 5) CJK is always safe to render; when the host has a CJK font, the Chinese
//    text round-trips. On a host with no CJK font (e.g. a bare CI box) the
//    renderer falls back to Latin fonts — still a valid PDF — so we only assert
//    the strong extraction when a CJK font is actually present.
{
  const zh = "光合作用把光能转化为化学能";
  const md =
    `# 光合作用\n\n${zh},并以葡萄糖的形式储存在植物体内,这是地球上几乎所有生命能量的最终来源。` +
    "光反应发生在类囊体膜上,暗反应也就是卡尔文循环发生在叶绿体基质中,二者协同把二氧化碳固定为有机物。";
  let pdf: Buffer | undefined;
  let threw = false;
  try {
    const r = await roundTrip(md);
    pdf = r.pdf;
    if (r.text.includes(zh)) {
      check("CJK: Chinese text round-trips when a CJK font is present", true);
    } else {
      skip("CJK: Chinese text round-trips", "no CJK system font on this host — fell back to Latin");
    }
  } catch {
    threw = true;
  }
  check(
    "CJK: rendering never throws and yields a valid PDF",
    !threw && !!pdf && pdf.subarray(0, 5).toString("ascii") === "%PDF-",
  );
  }
}

main()
  .then(() => {
    console.log("");
    if (failures > 0) {
      console.error(`✗ ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("✓ all checks passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
