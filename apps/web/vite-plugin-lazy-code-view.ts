import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** Assert on actual browser chunks, including dependencies hoisted into a shared chunk. */
export function lazyCodeView(): Plugin {
	const editorModule = /[/\\]node_modules[/\\](?:@codemirror[/\\]|@lezer[/\\]|@replit[/\\]codemirror-lang-)/;
	return {
		name: 'kemiri-lazy-code-view',
		apply: 'build',
		generateBundle(_options, bundle) {
			if (this.environment.name !== 'client') return;
			const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
			const chat = chunks.filter(chunk => chunk.moduleIds.some(id => id.endsWith('/components/ProjectChat.svelte')));
			const editorChunks = chunks.filter(chunk => chunk.moduleIds.some(id => editorModule.test(id)));
			if (!chat.length || !editorChunks.length) this.error('Could not locate chat and editor chunks for the code-view bundle check.');
			const visited = new Set<string>();
			const follow = (chunk: (typeof chunks)[number]) => {
				if (visited.has(chunk.fileName)) return;
				visited.add(chunk.fileName);
				if (editorChunks.includes(chunk)) this.error(`CodeMirror in chat's static imports: ${chunk.fileName}`);
				for (const filename of chunk.imports) {
					const dependency = bundle[filename];
					if (dependency?.type === 'chunk') follow(dependency);
				}
			};
			for (const chunk of chunks) if (chunk.isEntry || chat.includes(chunk) || /\/nodes\//.test(chunk.fileName)) follow(chunk);
			const codeChunks = chunks.filter(chunk => editorChunks.includes(chunk) || chunk.moduleIds.some(id => /\/code\/(CodeViewer|CodeComparison|readonly-editor|editor-theme|language-extensions|diff-words)\./.test(id)));
			for (const chunk of codeChunks) {
				console.log(`[code-view] ${chunk.name}: ${Buffer.byteLength(chunk.code)} B / ${gzipSync(chunk.code, { level: 9 }).length} B gzip`);
			}
			console.log('[code-view] Verified that no editor module is reachable from any route’s static imports.');
		},
	};
}
