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

// The constructor-chain escape — `({}).constructor.constructor("code")()` —
// recovers the real `Function` even though the identifier is shadowed below,
// which would in turn recover the real `fetch`/`window`/… off the global
// scope. We block it by temporarily neutralising `constructor` on every
// function-kind prototype for the synchronous duration of the model code.
//
// These descriptors are NOT plain-writable: per spec, AsyncFunction /
// GeneratorFunction / AsyncGeneratorFunction expose `constructor` as
// { writable: false, configurable: true }. A direct assignment therefore
// THROWS in strict mode (the cause of the "Cannot assign to read only
// property 'constructor' of object '[object AsyncFunction]'" crash). We go
// through `Object.defineProperty` (allowed because they're configurable) and
// wrap every step in try/catch so a stricter engine degrades to
// param-shadowing instead of breaking the render. Captured at module load so
// the model code's closure never sees the originals.
const CTOR_TARGETS: Array<{ proto: object; desc: PropertyDescriptor }> = (
  [
    ({}).constructor.constructor, // Function
    Object.getPrototypeOf(async function () {}).constructor, // AsyncFunction
    Object.getPrototypeOf(function* () {}).constructor, // GeneratorFunction
    Object.getPrototypeOf(async function* () {}).constructor, // AsyncGeneratorFunction
  ] as Array<{ prototype: object }>
)
  .map((ctor) => {
    const proto = ctor?.prototype;
    const desc = proto
      ? Object.getOwnPropertyDescriptor(proto, "constructor")
      : undefined;
    return desc ? { proto, desc } : null;
  })
  .filter((t): t is { proto: object; desc: PropertyDescriptor } => t != null);

function neutraliseConstructors(): void {
  for (const { proto } of CTOR_TARGETS) {
    try {
      Object.defineProperty(proto, "constructor", {
        value: undefined,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch {
      /* engine disallows it — param-shadowing still applies */
    }
  }
}

function restoreConstructors(): void {
  for (const { proto, desc } of CTOR_TARGETS) {
    try {
      Object.defineProperty(proto, "constructor", desc);
    } catch {
      /* nothing we can do; leave as-is */
    }
  }
}

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

  const args = ["api", ...FORBIDDEN];
  // Two-scope wrap: the outer fn body destructures `api` into the names the
  // model expects, then we run the model code inside an INNER IIFE so that
  // any `const THREE = ...` the model emits lives in its own scope and
  // shadows the outer binding instead of colliding with it.
  //
  // Constructor nulling/restoring is NOT done in here — it happens in the
  // wrapper below so the original constructor references are never in a
  // scope the model code's closure can reach.
  const wrapped = `
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
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(...args, wrapped) as (...args: unknown[]) => unknown;
  return (api: Record<string, unknown>) => {
    // Neutralise the constructor chain for the synchronous span of the model
    // code, then restore the exact original descriptors. Done here (not inside
    // the new Function body) so the originals never live in a scope the model
    // code's closure can reach.
    neutraliseConstructors();
    try {
      return fn(api, ...FORBIDDEN_UNDEFS) as ReturnType<CompiledFn>;
    } finally {
      restoreConstructors();
    }
  };
}
