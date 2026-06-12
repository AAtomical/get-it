/**
 * Per-tag visualization-spec agent.
 *
 * Hands a typed VizSpec back to the caller. Used by both the legacy
 * `/api/generate-viz` route and the server-side jobs runner.
 *
 * Behaviour:
 *   • Builds the prompt for the requested viz type (3D / 2d-anim /
 *     formula / graph / 2d-text).
 *   • If a previous attempt is supplied with its runtime error, prepends
 *     a repair preamble (the codex SDK gets `reasoning: "medium"` for
 *     these to spend a little extra thought).
 *   • Server-side syntax pre-flight (via the same `compileFn` the client
 *     runtime uses) for the two code-emitting types (3D, 2d-anim): if the
 *     generated JS doesn't compile, we throw with the compiler's reason so
 *     the failure is surfaced to the user (single-attempt — no auto-repair).
 */

import { runJson } from "../codex";
import { vizSchemaFor, type VizSpec, type VizType } from "../schemas";
import { compileFn } from "../viz-runtime";

const LANGUAGE_RULE = `LANGUAGE
The "context" field comes verbatim from the source PDF and reveals its
language. EVERY user-visible string you emit (title, caption, body
markdown, formula explanations, citation labels, axis labels, and any
text drawn inside a canvas / 3D scene via fillText) MUST be in the same
language as the source. Match it exactly — Italian PDF → Italian outputs,
English PDF → English outputs, Spanish PDF → Spanish outputs. Code
identifiers and JS comments stay in English.`;

/**
 * Per-type prompt HEADS — pure constants (no interpolation). Kept first in
 * the final prompt so that every call of a given viz type shares a byte-
 * identical prefix and hits the model's prompt cache; the per-concept details
 * (label / field / context) are appended at the very end by `composePrompt`.
 */
const PROMPT_HEADS: Record<VizType, string> = {
  "3d": `You are Get It.'s visualizer 3D scene generator.

${LANGUAGE_RULE}

Produce a JSON object matching the schema. The "setup_code" field MUST be
a JavaScript function BODY (do NOT wrap it in 'function setup() { ... }')
that the framework invokes as
   new Function("api", body)({ THREE, scene, camera, renderer, controls, group });

The body MUST do all of the following:
  - position the camera somewhere sensible (e.g. camera.position.set(0, 1.6, 4))
  - set scene.background = new THREE.Color('#fafafa')  (the app uses a
    light theme; the renderer canvas sits on a white card)
  - add an ambient light + a directional light suitable for the light theme
  - build meshes that ACCURATELY represent the concept and add them to
    'group' (the framework auto-rotates the group). Be creative and
    domain-aware: a heart needs distinct atria + ventricles + great
    vessels; methane needs the central carbon + 4 hydrogens at
    tetrahedral angles (109.5°); benzene needs a planar hexagonal carbon
    ring with hydrogens; a cell needs nucleus + visible organelles.
  - return an object with an optional update(t) callback for animation.

CONSTRAINTS:
  - Use ONLY 'THREE' (already imported) and standard math globals (Math, etc).
  - DO NOT use external loaders, textures, image URLs, or asset files.
  - DO NOT touch 'document', 'window', 'fetch', 'import', 'require', 'eval'.
  - DO NOT use OrbitControls — the framework already auto-rotates the
    group and reacts to pointer drag/scroll. Ignore the 'controls' arg.
  - Keep the total scene under ~200 primitives.
  - All meshes MUST be added to 'group' (not 'scene') so the framework can
    orbit them.
  - Use plain string concatenation ('foo ' + x) NOT template literals
    (\`foo \${x}\`) — backticks tend to get mangled in JSON encoding.
  - Material colors should read clearly against #fafafa (avoid pure white
    surfaces; prefer mid-tone fills with subtle MeshStandardMaterial).
  - Every '(' must close with ')', every '{' with '}', every '[' with ']'.
    The body is NOT wrapped in an outer function, so do NOT add a trailing
    '}' to "close" one — your braces must balance exactly on their own.`,

  "2d-anim": `You are Get It.'s visualizer 2D Canvas animation generator.

${LANGUAGE_RULE}

Produce a JSON object matching the schema. The "setup_code" field MUST be
a JavaScript function BODY invoked as
   new Function("api", body)({ ctx, width, height });
The body MUST return an object { draw(ctx, width, height, time, dt) }.

The draw callback runs every frame. Build an INFORMATIVE animation:
  - inclined plane: slope, block sliding with correct g·sin(θ) acceleration
  - pendulum: bob swinging with correct period 2π√(L/g)
  - projectile: parabolic trajectory traced over time
  - spring oscillation: mass on spring with amplitude decay
  - blood flow: vessel cross-section with cells flowing
  - chemical reaction: reactant molecules colliding and forming products
  - water cycle, etc.

Always paint a clean light background ('#fafafa') as the FIRST step of draw
so previous frames are erased. Use legible ink colors against that
background — pick from this palette:
  ink     #1a1a1d   (text, primary outlines)
  rose    #e11d48   (warning / accent A)
  amber   #d97706   (warning / accent B)
  emerald #059669   (positive / motion)
  violet  #7c3aed   (highlight)
  sky     #0284c7   (cool secondary)
Add labelled axes / annotations with ctx.fillText so the meaning is
self-evident.

CONSTRAINTS:
  - DO NOT touch document, window, fetch, import, require, eval.
  - DO NOT load images.
  - Use only 'ctx' (CanvasRenderingContext2D) plus Math globals.
  - Restart the animation cleanly when 'time' resets to 0.
  - Use plain string concatenation ('foo ' + x) NOT template literals
    (\`foo \${x}\`) — backticks tend to get mangled in JSON encoding.
  - Every '(' must close with ')', every '{' with '}', every '[' with ']'.
    The body is NOT wrapped in an outer function, so do NOT add a trailing
    '}' to "close" one — your braces must balance exactly on their own.`,

  formula: `You are Get It's visualizer formula generator.

${LANGUAGE_RULE}

Produce a JSON object matching the schema:
  - main_latex: the headline equation (no $ delimiters; KaTeX-compatible).
  - steps: 2 to 6 derivation/explanation steps, each with one LaTeX line
    plus a one-sentence explanation. Walk the reader from definition to
    result.
Avoid \\begin{align} environments unless necessary; prefer simple lines.`,

  graph: `You are Get It.'s visualizer graph generator.

${LANGUAGE_RULE}

Produce a JSON object matching the schema. The "data_json" field MUST be a
STRING containing JSON (it will be JSON.parse'd on the client). Pick a
chart_type and fill data_json accordingly:

  chart_type="function": data_json = '{"fn":"<expr in x>","x_min":-5,"x_max":5,"samples":200}'
       The expression must be valid JS using x and Math.* (e.g. "Math.sin(x)*x").
  chart_type="points":   data_json = '{"points":[[x,y], ...]}'
  chart_type="bars":     data_json = '{"bars":[{"label":"A","value":1.0}, ...]}'
  chart_type="lines":    data_json = '{"series":[{"name":"foo","color":"#5b66f1","points":[[x,y],...]}]}'

Pick sensible domain & sampling. Make the chart visually communicate the
concept (e.g. range R = v0² sin(2α)/g plotted as α sweeps 0 to 90; or the
bell curve; or a parabola). Use color hex strings; the chart engine
renders on a white background.`,

  "2d-text": `You are Get It.'s visualizer text-source generator.

${LANGUAGE_RULE}

Produce a JSON object matching the schema. The viewer expects an
authoritative card: a title, a short caption, a body in markdown that
quotes or summarises the cited source, and a list of 1–4 citations with
stable URLs (Wikipedia, official government sites, arxiv, etc).

If you have web search available, use it to confirm the citation text and
URL; otherwise produce the best high-confidence quote you know. Prefer
direct quotation in italics for legal articles. Add bracketed source
labels in the text like [1], [2] linking to the citations array order.`,
};

/** Append the per-concept block to a type's constant head. Variable content
 *  goes LAST so the head stays a cacheable prefix across calls. */
function composePrompt(
  type: VizType,
  ctx: { label: string; context: string; docTitle?: string },
): string {
  return `${PROMPT_HEADS[type]}

CONCEPT: ${ctx.label}
FIELD: ${ctx.docTitle ?? "general"}
CONTEXT: ${ctx.context}

Reply with the JSON object only.`;
}

function repairPreamble(prevSpec: VizSpec, runtimeError: string): string {
  const codeField =
    prevSpec.type === "3d" || prevSpec.type === "2d-anim"
      ? prevSpec.setup_code
      : null;
  return `THIS IS A REPAIR ATTEMPT.

The previous response you produced was rendered by the client and CRASHED
with this runtime error:

  ${runtimeError}

${codeField ? `The previous setup_code body was:\n\n--- BEGIN PREV CODE ---\n${codeField}\n--- END PREV CODE ---\n\n` : ""}Diagnose the cause and produce a corrected JSON object that compiles and
runs end-to-end. Keep the same intent and style as before; do not rewrite
from scratch unless the original direction is fundamentally broken.

`;
}

function syntaxCheck(code: string): string | null {
  try {
    // Compile exactly the way the client runtime will (same fence-stripping,
    // strict-mode IIFE wrap and forbidden-global shadowing) so the server-side
    // check matches reality — no false rejections, no missed strict errors.
    compileFn(code);
    return null;
  } catch (e) {
    return (e as Error).message || "syntax error";
  }
}

function specCodeOrNull(spec: VizSpec): string | null {
  if (spec.type === "3d" || spec.type === "2d-anim") return spec.setup_code;
  return null;
}

export type GenerateVizArgs = {
  type: VizType;
  label: string;
  context: string;
  docTitle?: string;
  previousAttempt?: { spec: VizSpec; runtimeError: string };
  signal?: AbortSignal;
};

export async function generateVizSpec(args: GenerateVizArgs): Promise<VizSpec> {
  const schema = vizSchemaFor(args.type);
  const basePrompt = composePrompt(args.type, {
    label: args.label,
    context: args.context,
    docTitle: args.docTitle,
  });
  const initialPrompt = args.previousAttempt
    ? repairPreamble(args.previousAttempt.spec, args.previousAttempt.runtimeError) +
      basePrompt
    : basePrompt;
  const reasoning = args.previousAttempt ? "medium" : "low";
  const webSearch = args.type === "2d-text";

  const { data } = await runJson<VizSpec>(initialPrompt, schema, {
    reasoning,
    webSearch,
    signal: args.signal,
  });

  // Single-attempt policy: validate the generated code once. If it doesn't
  // compile, surface the reason immediately (no silent repair round) so the
  // failure is shown to the user, who can refresh to try again.
  const code = specCodeOrNull(data);
  if (code) {
    const err = syntaxCheck(code);
    if (err) throw new Error(`Generated code failed to compile: ${err}`);
  }

  return data;
}
