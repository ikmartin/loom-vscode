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

/** Commands whose argument names a key. */
export const KEY_COMMANDS = new Set(['label', 'ref', 'eqref', 'cref', 'Cref', 'autoref', 'pageref', 'vref', 'Vref', 'uses']);
/** Commands whose argument names a file of the quilt. */
export const INCLUDE_COMMANDS = new Set(['input', 'include', 'nest']);

/** The id of the first node in the quilt file an `\input{name}` names: the first `\label` in it, or undefined. */
function keyOfFile(root: string, name: string): string | undefined {
	for (const candidate of [name, `${name}.tex`]) {
		const full = path.join(root, candidate);
		let text: string;
		try {
			if (!fs.statSync(full).isFile()) {
				continue;
			}
			text = fs.readFileSync(full, 'utf8');
		} catch {
			continue;
		}
		const label = /\\label\{([^}]+)\}/.exec(text);
		return label ? label[1].trim() : undefined;
	}
	return undefined;
}

/**
 * The loom id under or nearest before a position.
 *
 * On a `\label`, `\ref`, `\uses` or similar, the first key it names; on an `\input`, `\include` or `\nest`, the first node of the file it names, read from `root`; anywhere else, the last `\label` above. Other commands' arguments (`\emph{...}`, `\section{...}`) are never taken for keys. `text` is the whole document and `offset` a character offset into it.
 */
export function keyAt(text: string, offset: number, root?: string): string | undefined {
	const command = /\\([A-Za-z@]+)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = command.exec(text)) !== null) {
		if (m.index > offset) {
			break;
		}
		if (offset > m.index + m[0].length) {
			continue;
		}
		const first = m[2].split(',')[0].trim();
		if (!first) {
			continue;
		}
		if (KEY_COMMANDS.has(m[1])) {
			return first;
		}
		if (INCLUDE_COMMANDS.has(m[1]) && root) {
			const key = keyOfFile(root, first);
			if (key) {
				return key;
			}
		}
	}
	const before = text.slice(0, offset);
	const labels = [...before.matchAll(/\\label\{([^}]+)\}/g)];
	return labels.length ? labels[labels.length - 1][1] : undefined;
}
