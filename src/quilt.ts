// Finding the quilt a file belongs to. The extension does nothing outside one, so an ordinary LaTeX workspace is untouched.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The quilt root at or above `start`: the nearest directory with a `config.toml` holding a `[quilt]` table. */
export function findQuilt(start: string): string | undefined {
	let dir = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
	while (true) {
		const config = path.join(dir, 'config.toml');
		try {
			if (fs.statSync(config).isFile() && /^\s*\[quilt\]/m.test(fs.readFileSync(config, 'utf8'))) {
				return dir;
			}
		} catch {
			// not a directory we can read; keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/**
 * The loom id under or nearest before a position: the argument of the enclosing command, else the last `\label` above it.
 *
 * `text` is the whole document; `offset` is a character offset into it.
 */
export function keyAt(text: string, offset: number): string | undefined {
	const command = /\\[A-Za-z@]+\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = command.exec(text)) !== null) {
		if (offset >= m.index && offset <= m.index + m[0].length) {
			const first = m[1].split(',')[0].trim();
			if (first) {
				return first;
			}
		}
		if (m.index > offset) {
			break;
		}
	}
	const before = text.slice(0, offset);
	const labels = [...before.matchAll(/\\label\{([^}]+)\}/g)];
	return labels.length ? labels[labels.length - 1][1] : undefined;
}
