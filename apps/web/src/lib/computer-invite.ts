import { decodePairingFragment } from '@kemiri/protocol';
import { decodeConnectHash } from './connect.ts';

/** Open an accepted payload in this app, never navigate to the host in a pasted link. */
export function computerInviteHref(raw: string, origin: string): string | undefined {
	try {
		const url = new URL(raw.trim());
		if ((url.protocol !== 'https:' && url.origin !== origin) || url.username || url.password || url.search) return;
		if (url.pathname === '/connect' && decodeConnectHash(url.hash).ok) return `/connect${url.hash}`;
		if (url.pathname === '/pair') {
			decodePairingFragment(url.hash);
			return `/pair${url.hash}`;
		}
	} catch { /* The existing pairing and connect validators reject damaged links. */ }
}
