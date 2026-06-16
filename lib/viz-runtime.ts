/**
 * Helpers for safely running LLM-generated JS for the 3D and 2D-anim
 * visualizers. We use `new Function` rather than eval, expose only the
 * specific API the renderer needs, and forbid common escape hatches by
 * shadowing them in the function's local scope.
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
  const wrapped = `
    const __origFunc = {}.constructor.constructor;
    const __origAsync = Object.getPrototypeOf(async function(){}).constructor;
    const __origGen = Object.getPrototypeOf(function*(){}).constructor;
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
  const fn = new Function(...args, wrapped) as CompiledFn;
  return (api: Record<string, unknown>) => fn(api);
}
