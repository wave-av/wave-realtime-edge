// Vitest (node pool) stub for the Workers-runtime-only `cloudflare:workers` module. RT-R10 (#72) exports
// `RecorderContainer extends Container` (from @cloudflare/containers), and that package imports
// `DurableObject`/`WorkerEntrypoint` from `cloudflare:workers` — a module that exists ONLY inside workerd,
// not under node. This repo runs vitest in the `node` environment (unlike bridge-edge's workers pool), so we
// alias `cloudflare:workers` to these inert base classes (vitest.config.ts) purely so the class graph LOADS.
//
// This is test-only scaffolding: it never runs in prod (wrangler/esbuild bundles the real runtime module at
// deploy) and the container path is INERT (the [[containers]] binding is commented; RecorderContainer is never
// instantiated in any test — the seam tests inject fakes). It exists so the SKIP bundle-guard + wrangler-inert
// + seam suites can import the worker graph without a workerd runtime.

/** Minimal stand-in for workerd's DurableObject base (constructor takes (state, env); we ignore them). */
export class DurableObject<Env = unknown> {
  constructor(
    public ctx?: unknown,
    public env?: Env,
  ) {}
}

/** Minimal stand-in for workerd's WorkerEntrypoint base. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public ctx?: unknown,
    public env?: Env,
  ) {}
}
