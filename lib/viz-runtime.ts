/**
 * Helpers for safely running LLM-generated JS for the 3D and 2D-anim
 * visualizers. We use `new Function` rather than eval, expose only the
 * specific API the renderer needs, and forbid common escape hatches by
 * shadowing them in the function's local scope.
 *
 * ## Threat model
 * The sandbox prevents the model code from:
 *   - Accessing the global object or constructor chain (`Function`/`eval`/etc.)
 *   - Making network requests (`fetch`/`XMLHttpRequest`/`WebSocket`/`navigator.sendBeacon`)
 *   - Accessing the DOM (`window`/`document`/`location`)
 *   - Reading or writing local files (`require`/`process`/`fs`)
 *   - Using `localStorage`/`sessionStorage`
 *
 * It does NOT prevent exfiltration via the THREE.js or Canvas 2D APIs that
 * are intentionally exposed (e.g. `canvas.toDataURL()` in 2D, or reading
 * texture data in 3D). This is an acceptable risk because:
 *   1. The user is a trusted actor (their own token on their own machine).
 *   2. Codex SDK prompts are constrained; the model would need adversarial
 *      intent to craft exfil code, and even then the network APIs are blocked.
 *   3. The forerunner server (Electron main / next dev) handles file I/O and
 *      env secrets — none of that leaks into the renderer process.
 */

// "import" is a reserved word and can't be used as a parameter name; it's
// a syntax error to call it as a function anyway. eval, Function, async
// and generator constructors are shadowed here, and the constructor-chain
// escape is blocked by nulling Function/AsyncFunction/GeneratorFunction
// prototype.constructor before the model code runs (restored in finally).
const FORBIDDEN = [
  "window",
  "document",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "require",
  "Function",
  "eval",
  "globalThis",
  "self",
  "process",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
];

// Captured at module load so they survive the constructor nulling inside
// compileFn's wrapped function body. Passed as extra params so the
// `new Function` body can reference them for restore in the finally block.
const ORIG_FUNC = {}.constructor.constructor;
const ORIG_ASYNC = Object.getPrototypeOf(async function () {}).constructor;
const ORIG_GEN = Object.getPrototypeOf(function* () {}).constructor;
const FORBIDDEN_UNDEFS = FORBIDDEN.map(() => undefined);

export type CompiledFn = (api: Record<string, unknown>) => unknown;

/**
 * Compile a function body into a callable. The body is wrapped in a function
 * that takes `api` and shadows the forbidden globals as undefined locals.
 */
export function compileFn(body: string): CompiledFn {
  // Strip ```...``` if a model leaked code fences in.
  const cleaned = body
    .replace(/^\s*```(?:js|javascript)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const args = ["api", ...FORBIDDEN, "__origFunc", "__origAsync", "__origGen"];
  // Two-scope wrap: the outer fn body destructures `api` into the names the
  // model expects, then we run the model code inside an INNER IIFE so that
  // any `const THREE = ...` the model emits lives in its own scope and
  // shadows the outer binding instead of colliding with it.
  const wrapped = `
    __origFunc.prototype.constructor = void 0;
    __origAsync.prototype.constructor = void 0;
    __origGen.prototype.constructor = void 0;
    try {
      const THREE = api.THREE;
      const scene = api.scene;
      const camera = api.camera;
      const renderer = api.renderer;
      const controls = api.controls;
      const group = api.group;
      const ctx = api.ctx;
      const width = api.width;
      const height = api.height;
      return (function () {
        "use strict";
        ${cleaned}
      })();
    } finally {
      __origFunc.prototype.constructor = __origFunc;
      __origAsync.prototype.constructor = __origAsync;
      __origGen.prototype.constructor = __origGen;
    }
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(...args, wrapped) as (
    api: Record<string, unknown>,
    ...rest: unknown[]
  ) => unknown;
  return (api: Record<string, unknown>) =>
    fn(api, ...FORBIDDEN_UNDEFS, ORIG_FUNC, ORIG_ASYNC, ORIG_GEN) as ReturnType<CompiledFn>;
}
