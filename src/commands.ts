// The command set, as argument vectors and URLs. Nothing here touches the VS Code API, so every builder is testable on its own.

export interface Settings {
	loomPath: string;
	serverPath: string;
}

/** The argument vector for a loom call in `root`. Arguments are passed as a vector, never as a shell string, so a title with a space or a quote is safe. For `serve`, `arg` is the port. */
export function argvFor(name: string, root: string, settings: Settings, arg?: string): string[] | undefined {
	const call = (...args: string[]) => [settings.loomPath, ...args, '--quilt', root];
	switch (name) {
		case 'status':
			return call('status');
		case 'lint':
			return call('lint', '--json');
		case 'new': {
			const parts = (arg ?? '').trim().match(/^(\S+)\s+(.+)$/);
			return parts ? call('new', parts[1], parts[2], '--print') : undefined;
		}
		case 'accept':
			return arg ? call('accept', arg) : undefined;
		case 'serve':
			return arg ? call('serve', '--port', arg) : undefined;
		case 'bundle':
			return arg ? call('bundle', arg) : undefined;
		case 'deps':
			return arg ? call('deps', arg) : undefined;
		default:
			return undefined;
	}
}

/** The arras URL for a key on the server at `base`. */
export function nodeUrl(base: string, key: string): string {
	return `${base.endsWith('/') ? base : `${base}/`}node/${key}`;
}

/** The commands that write to the quilt, and therefore confirm first. */
export const WRITES = new Set(['accept', 'atomize']);

export function confirmationFor(name: string, arg?: string): string | undefined {
	if (name === 'accept') {
		return `Record an acceptance for ${arg}? This writes to the review ledger.`;
	}
	return undefined;
}
