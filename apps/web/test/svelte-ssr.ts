import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';

/** Import a server bundle without starting Vite or registering a global Bun loader. */
export async function loadSvelteSsr(entrypoint: string): Promise<unknown> {
 const directory = await mkdtemp(join(tmpdir(), 'kemiri-svelte-ssr-'));
 const transpiler = new Bun.Transpiler({ loader: 'ts' });
 try {
  const { outputs: [bundle] } = await Bun.build({
   entrypoints: [entrypoint],
   outdir: directory,
   target: 'bun',
   plugins: [{
    name: 'svelte-ssr',
    setup(build) {
     // Route's report includes an artifact dialog; its client-side router is not used under SSR.
     build.onResolve({ filter: /^\$app\/(state|navigation)$/ }, ({ path }) => ({ path, namespace: 'kit-ssr' }));
     build.onLoad({ filter: /.*/, namespace: 'kit-ssr' }, ({ path }) => ({
      contents: path === '$app/state' ? 'export const page = {};' : 'export function goto() { throw new Error("No client navigation during SSR"); }',
      loader: 'js',
     }));
     build.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
      contents: compile(await Bun.file(filename).text(), {
       filename,
       generate: 'server',
       runes: filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      }).js.code,
      loader: 'js',
     }));
     build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path: filename }) => {
      const source = await Bun.file(filename).text();
      const js = filename.endsWith('.ts') ? transpiler.transformSync(source) : source;
      return { contents: compileModule(js, { filename, generate: 'server' }).js.code, loader: 'js' };
     });
    },
   }],
  });
  return await import(bundle.path);
 } finally {
  await rm(directory, { recursive: true, force: true });
 }
}
