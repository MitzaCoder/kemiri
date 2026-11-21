import { expect, test } from 'bun:test';
import { retainCoordinator } from '../src/lib/coordinator-recents.js';

test('switches retain unique chats and evict the least recently shown', () => {
	const recents = ['main', 'shop', 'kitchen'];
	const shown = retainCoordinator(recents, 'main', 3);
	expect(shown).toEqual(['shop', 'kitchen', 'main']);
	expect(retainCoordinator(shown, 'main', 3)).toBe(shown);
	expect(retainCoordinator(shown, 'delivery', 3)).toEqual(['kitchen', 'main', 'delivery']);
});

test('prefetch fills unused capacity and is first to be evicted', () => {
	const shown = ['main', 'shop'];
	const warmed = retainCoordinator(shown, 'kitchen', 3, true);
	expect(warmed).toEqual(['kitchen', 'main', 'shop']);
	expect(retainCoordinator(warmed, 'delivery', 3, true)).toBe(warmed);
	expect(retainCoordinator(warmed, 'delivery', 3)).toEqual(['main', 'shop', 'delivery']);
});
