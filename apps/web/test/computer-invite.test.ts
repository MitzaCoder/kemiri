import { expect, test } from 'bun:test';
import { encodePairingFragment } from '@kemiri/protocol';
import { computerInviteHref } from '../src/lib/computer-invite.ts';
import { connectHref } from '../src/lib/connect.ts';

const origin = 'https://app.example.org';
const backend = { name: 'Studio computer', url: 'https://studio.example.org' };

test('valid address and pairing invites open the matching local confirmation page', () => {
	const connect = connectHref(origin, [backend]);
	expect(computerInviteHref(connect, origin)).toBe(connect.slice(origin.length));
	const pair = '/pair' + encodePairingFragment({ backendId: 'aiki_s1.' + 'a'.repeat(22), backendOrigin: backend.url, grantId: 'aiki_g1.' + 'b'.repeat(22), secret: 'aiki_p1.' + 'c'.repeat(43) });
	expect(computerInviteHref(backend.url + pair, origin)).toBe(pair);
});

test('malformed payloads, incompatible routes and insecure third-party links are rejected', () => {
	for (const link of ['https://example.org/pair#pair=bad', origin + '/connect#broken', origin + '/other', 'javascript:void(0)', 'https://a:b@example.org/connect', connectHref('http://app.example.org', [backend])]) {
		expect(computerInviteHref(link, origin)).toBeUndefined();
	}
});
