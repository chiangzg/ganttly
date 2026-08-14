// @ts-check
/**
 * Bundle the server for production (spec §14.2 self-hosted image).
 *
 * The `@ganttly/*` workspace packages ship raw TypeScript (no build step), so
 * they MUST be bundled into the output — otherwise Node cannot import `.ts` at
 * runtime. Everything else under node_modules (Drizzle, Fastify, postgres,
 * prom-client, the MCP SDK, and any native/optional deps) is left external and
 * resolved from the real dependency tree at runtime. That combination gives a
 * single `dist/server.js` / `dist/migrate.js` that needs no tsx, starts fast,
 * and sidesteps all native-dependency bundling pitfalls.
 *
 * Run via `pnpm --filter @ganttly/server build`.
 */
import { build } from 'esbuild';

/** Mark real node_modules as external; bundle first-party + @ganttly/* source. */
const externalWorkspace = {
  name: 'external-workspace',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      // Relative / absolute paths are first-party source → bundle.
      if (args.path.startsWith('.') || args.path.startsWith('/')) return undefined;
      // The workspace packages are TypeScript source → bundle (transitively).
      if (args.path.startsWith('@ganttly/')) return undefined;
      // Everything else (bare packages, node: builtins) → resolve at runtime.
      return { path: args.path, external: true };
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  plugins: [externalWorkspace],
};

await build({
  ...shared,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
});

await build({
  ...shared,
  entryPoints: ['src/db/migrate.ts'],
  outfile: 'dist/migrate.js',
});
