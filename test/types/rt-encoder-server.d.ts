// #135 — minimal ambient types for the rt-encoder server modules imported by tests. The server is plain JS
// (.mjs, no .d.ts); these declarations let the TS test reference its parser/selector without `any` leaks.
declare module "*/containers/rt-encoder/server/negotiate.mjs" {
  export function parseDstDescriptor(headerValue: string | undefined): Record<string, unknown> | null;
  export function negotiationEnabled(env?: Record<string, string | undefined>): boolean;
  export function negotiateTargetCodec(
    srcDescriptor: unknown,
    dstDescriptor: unknown,
    objective?: { live?: boolean },
  ):
    | { negotiated: true; targetCodec: string; transport: string; container: string; runtime: string; score: number }
    | { negotiated: false; reason: string; detail?: string };
  export class NegotiationInputError extends Error {}
}
