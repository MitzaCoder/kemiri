// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState {
			changesFrom?: string;
			filesFrom?: string;
			searchFiles?: boolean;
			taskTrail?: import('./lib/task-navigation.js').TaskVisit[];
			navigation?: import('./lib/settings-navigation.js').NavigationEntry;
			usage?: boolean;
			mcp?: import('./lib/settings-navigation.js').McpNavigationView;
		}
		// interface Platform {}
	}
}

export {};
