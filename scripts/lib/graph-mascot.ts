/** Generate independently animatable SVG groups from the reviewed master, never hand-copied paths. */
export function graphMascotModule(master: string): string {
	const definitions = /<defs>([\s\S]*?)<\/defs>/.exec(master)?.[1];
	const paths = [...master.matchAll(/<path fill="([^"]+)" d="([^"]+)"\/>/g)];
	const face = paths[5];
	const contours = face?.[2]?.match(/M[^M]+Z/g);
	if (!definitions || paths.length !== 6 || contours?.length !== 3) throw new Error('Review graph mascot grouping after editing the master');
	const eye = (index: number, side: string) => `<g class="mascot-eye mascot-eye-${side}"><path fill="${face![1]}" d="${contours[index]}"/></g>`;
	const geometry = `<g class="mascot-pose"><g class="mascot-leaf">${paths.slice(0, 2).map(path => path[0]).join('')}</g><g class="mascot-body">${paths.slice(2, 5).map(path => path[0]).join('')}<g class="mascot-eyes-gaze">${eye(0, 'left')}${eye(1, 'right')}</g><g class="mascot-mouth"><path fill="${face![1]}" d="${contours[2]}"/></g></g></g>`;
	const namespaced = (svg: string) => svg.replace(/id="([^"]+)"/g, 'id="GRAPH_PREFIX-$1"').replace(/url\(#([^)]*)\)/g, 'url(#GRAPH_PREFIX-$1)');
	return `// Generated from assets/brand/logo.svg by bun scripts/generate-brand.ts --graph-only.\n// Place definitions once in the canvas <defs>; geometry contains no gradient definitions.\nexport const graphMascotViewBox = '122 115 780 780';\nconst definitions = ${JSON.stringify(namespaced(definitions))};\nconst geometry = ${JSON.stringify(namespaced(geometry))};\nexport function graphMascotSvg(prefix = 'graph-mascot'): { definitions: string; geometry: string } {\n\tif (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(prefix)) throw new Error('Expected an SVG ID prefix');\n\treturn { definitions: definitions.replaceAll('GRAPH_PREFIX', prefix), geometry: geometry.replaceAll('GRAPH_PREFIX', prefix) };\n}\n`;
}
