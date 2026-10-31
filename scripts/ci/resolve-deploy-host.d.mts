// Ambient type declaration for resolve-deploy-host.mjs — lets tsc (strict, no allowJs) typecheck
// test/resolve-deploy-host.test.ts's import without widening the whole build to check JS files.
export declare function resolveProductionHost(tomlSrc: string): string | null;
export declare function resolveNamedEnvHost(tomlSrc: string, envName: string): string | null;
export declare function resolveDeployHost(tomlSrc: string, envName: string): string | null;
export declare function hasDeclaredRoute(tomlSrc: string, envName: string): boolean;
export declare function resolveExitCode(
	tomlSrcOrNull: string | null,
	envName: string,
): { host: string | null; exitCode: 0 | 1 | 2 };
export declare const WRANGLER_TOML: string;
