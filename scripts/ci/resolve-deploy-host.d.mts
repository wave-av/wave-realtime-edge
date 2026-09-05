// Ambient type declaration for resolve-deploy-host.mjs — lets tsc (strict, no allowJs) typecheck
// test/resolve-deploy-host.test.ts's import without widening the whole build to check JS files.
export declare function resolveProductionHost(tomlSrc: string): string | null;
export declare function resolveNamedEnvHost(tomlSrc: string, envName: string): string | null;
export declare function resolveDeployHost(tomlSrc: string, envName: string): string | null;
export declare const WRANGLER_TOML: string;
