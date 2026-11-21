const filenames: Readonly<Record<string, string>> = {
	dockerfile: 'dockerfile', containerfile: 'dockerfile', '.bashrc': 'shell', '.zshrc': 'shell',
	'.gitignore': 'text', '.editorconfig': 'text',
};
const extensions: Readonly<Record<string, string>> = {
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
	ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
	json: 'json', jsonc: 'json', jsonl: 'json', html: 'html', htm: 'html', css: 'css',
	md: 'markdown', markdown: 'markdown', py: 'python', pyi: 'python', rs: 'rust', go: 'go',
	java: 'java', c: 'cpp', h: 'cpp', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
	php: 'php', sql: 'sql', xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml',
	kt: 'kotlin', kts: 'kotlin', swift: 'swift', dart: 'dart', lua: 'lua',
	sh: 'shell', bash: 'shell', zsh: 'shell', toml: 'toml', dockerfile: 'dockerfile',
	svelte: 'svelte', nix: 'nix', vue: 'vue',
};

export function codeLanguageForPath(path: string): string {
	const name = path.toLowerCase().split(/[/\\]/).at(-1) ?? '';
	if (Object.hasOwn(filenames, name)) return filenames[name]!;
	if (/^(dockerfile|containerfile)\./.test(name)) return 'dockerfile';
	const extension = name.includes('.') ? name.split('.').at(-1)! : '';
	return Object.hasOwn(extensions, extension) ? extensions[extension]! : 'text';
}
