import * as vscode from 'vscode';

const PREFIX = '[Pixel Agents]';

const isDebug = () => vscode.workspace.getConfiguration('pixel-agents').get('debug', false);

export const log = {
	debug: (...args: unknown[]): void => {
		if (isDebug()) {console.log(PREFIX, ...args);}
	},
	info: (...args: unknown[]): void => { console.log(PREFIX, ...args); },
	warn: (...args: unknown[]): void => { console.warn(PREFIX, ...args); },
	error: (...args: unknown[]): void => { console.error(PREFIX, ...args); },
};
