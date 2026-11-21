import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

/** Only these parsers can enter the precache. Each one loads after opening a matching file. */
const languageExtensions: Record<string, () => Promise<Extension>> = {
	javascript: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
	jsx: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
	typescript: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
	tsx: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true, typescript: true })),
	json: () => import('@codemirror/lang-json').then(m => m.json()),
	html: () => import('@codemirror/lang-html').then(m => m.html()),
	css: () => import('@codemirror/lang-css').then(m => m.css()),
	markdown: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
	python: () => import('@codemirror/lang-python').then(m => m.python()),
	rust: () => import('@codemirror/lang-rust').then(m => m.rust()),
	go: () => import('@codemirror/lang-go').then(m => m.go()),
	java: () => import('@codemirror/lang-java').then(m => m.java()),
	cpp: () => import('@codemirror/lang-cpp').then(m => m.cpp()),
	php: () => import('@codemirror/lang-php').then(m => m.php()),
	sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
	xml: () => import('@codemirror/lang-xml').then(m => m.xml()),
	yaml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
	vue: () => import('@codemirror/lang-vue').then(m => m.vue()),
	svelte: () => import('@replit/codemirror-lang-svelte').then(m => m.svelte()),
	nix: () => import('@replit/codemirror-lang-nix').then(m => m.nix()),
	kotlin: () => import('@codemirror/legacy-modes/mode/clike').then(m => StreamLanguage.define(m.kotlin)),
	swift: () => import('@codemirror/legacy-modes/mode/swift').then(m => StreamLanguage.define(m.swift)),
	dart: () => import('@codemirror/legacy-modes/mode/clike').then(m => StreamLanguage.define(m.dart)),
	lua: () => import('@codemirror/legacy-modes/mode/lua').then(m => StreamLanguage.define(m.lua)),
	shell: () => import('@codemirror/legacy-modes/mode/shell').then(m => StreamLanguage.define(m.shell)),
	toml: () => import('@codemirror/legacy-modes/mode/toml').then(m => StreamLanguage.define(m.toml)),
	diff: () => import('@codemirror/legacy-modes/mode/diff').then(m => StreamLanguage.define(m.diff)),
	dockerfile: () => import('@codemirror/legacy-modes/mode/dockerfile').then(m => StreamLanguage.define(m.dockerFile)),
};

export async function loadCodeLanguage(language: string): Promise<Extension> {
	return Object.hasOwn(languageExtensions, language) ? languageExtensions[language]!().catch(() => []) : [];
}
