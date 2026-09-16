// Starting and probing `loom serve`: a free port to put it on, and a wait for the moment it answers. Nothing here touches the VS Code API.

import * as http from 'node:http';
import * as net from 'node:net';

/** A port on 127.0.0.1 that nothing is listening on at the moment of asking. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error('no port was assigned'))));
		});
	});
}

/** One GET of `<url>build/manifest.json`; true on status 200, false on anything else including a refused connection. */
function manifestAnswers(url: string): Promise<boolean> {
	const base = url.endsWith('/') ? url : `${url}/`;
	return new Promise((resolve) => {
		const request = http.get(`${base}build/manifest.json`, (response) => {
			response.resume();
			resolve(response.statusCode === 200);
		});
		request.setTimeout(1000, () => request.destroy());
		request.on('error', () => resolve(false));
	});
}

/**
 * Poll `<url>build/manifest.json` every 200 ms until it answers 200.
 *
 * False on timeout, and promptly once `isAlive` reports the server process gone, so a caller can tell a dead start from a slow one by asking `isAlive` again.
 */
export async function waitForManifest(url: string, timeoutMs: number, isAlive: () => boolean = () => true): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive()) {
			return false;
		}
		if (await manifestAnswers(url)) {
			return true;
		}
		const left = deadline - Date.now();
		if (left <= 0) {
			break;
		}
		await new Promise((r) => setTimeout(r, Math.min(200, left)));
	}
	return false;
}
