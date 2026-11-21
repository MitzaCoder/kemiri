/** Run with Bun after extracting the npm tarballs for tm-grammars 1.32.22 and tm-themes 1.12.12. */
import { gzipSync } from 'node:zlib';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [grammarPackage, themePackage] = process.argv.slice(2);
if (!grammarPackage || !themePackage) throw Error('Pass the extracted tm-grammars and tm-themes directories');
for (const [directory, name, version] of [[grammarPackage, 'tm-grammars', '1.32.22'], [themePackage, 'tm-themes', '1.12.12']]) {
    const pkg = await Bun.file(resolve(directory!, 'package.json')).json();
    if (pkg.name !== name || pkg.version !== version) throw Error(`Expected ${name}@${version}`);
}
// Match Shiki's supported roots and embedded data for this subset. GLSL is not shipped: its pinned source has no licence.
const languages = 'c cpp csharp css dart diff docker fish go html java javascript json jsx kotlin lua make markdown nix php python ruby rust scss shellscript sql svelte swift toml tsx typescript xml yaml'.split(' ');
const embedded = 'cpp-macro graphql haml html-derivative markdown-nix postcss regexp'.split(' ');
const { grammars, injections } = await import(pathToFileURL(resolve(grammarPackage, 'index.js')).href) as {
    grammars: GrammarMetadata[];
    injections: GrammarMetadata[];
};
type GrammarMetadata = { name: string; scopeName: string; aliases?: string[]; source: string };
const destination = new URL('../app/src/main/assets/chat-textmate/', import.meta.url).pathname;
// Use .gzip, not .gz: Android packaging expands assets with a .gz suffix.
await mkdir(destination, { recursive: true });
const index = [];
for (const name of [...languages, ...embedded].sort()) {
    const grammar = [...grammars, ...injections].find(g => g.name === name);
    if (!grammar) throw Error(`Missing pinned grammar ${name}`);
    const { scopeName, aliases = [], source } = grammar;
    const syntax = await Bun.file(resolve(grammarPackage, 'grammars', `${name}.json`)).json();
    if (syntax.scopeName !== scopeName) throw Error(`Unexpected scope for ${name}`);
    if (name === 'xml') {
        // The upstream ASP-style comment has end and name nested under its captures.
        // vscode-textmate ignores these non-numeric keys, but tm4e tries to compile them as capture rules.
        const aspComment = syntax.repository.comments.patterns[0];
        const { '0': delimiter, end, name: commentScope } = aspComment.captures;
        if (aspComment.begin !== '<%--' || end !== '--%>' || commentScope !== 'comment.block.xml') {
            throw Error('Recheck the pinned XML grammar’s ASP comment rule');
        }
        Object.assign(aspComment, { end, name: commentScope, captures: { '0': delimiter } });
    }
    const labels = languages.includes(name) ? [name, ...aliases, ...(name === 'jsx' ? ['javascriptreact'] : name === 'tsx' ? ['typescriptreact'] : [])] : [];
    index.push({ name, scopeName, labels, injectTo: syntax.injectTo ?? [], source });
    const encoded = JSON.stringify(syntax, (key, value) => {
        if (!['match', 'begin', 'end', 'while'].includes(key) || typeof value !== 'string') return value;
        // Joni does not support this mixed-width look-behind in the JS/TS family.
        return value.replace('(?<!(?:^|[^$._[:alnum:]])const)', '(?<!^const)(?<![^$._[:alnum:]]const)');
    });
    await Bun.write(destination + `${name}.json.gzip`, gzipSync(encoded, { level: 9 }));
}
await Bun.write(destination + 'grammars.json', JSON.stringify(index, null, 2) + '\n');
for (const name of ['catppuccin-latte', 'catppuccin-mocha']) {
    const theme = await Bun.file(resolve(themePackage, 'themes', `${name}.json`)).json();
    const settings = [{ settings: { foreground: theme.colors['editor.foreground'] } }, ...theme.tokenColors];
    await Bun.write(destination + `${name}.json`, JSON.stringify({ name, settings }, null, 2) + '\n');
}
