export const workspace = {
	getConfiguration: () => ({
		get: (_key: string, defaultValue: unknown) => defaultValue,
	}),
	workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
};

export const window = {
	terminals: [],
	activeTerminal: undefined,
	createTerminal: () => ({
		name: 'Claude Code #1',
		show: () => {},
		sendText: () => {},
		dispose: () => {},
	}),
	onDidChangeActiveTerminal: () => ({ dispose: () => {} }),
	onDidCloseTerminal: () => ({ dispose: () => {} }),
};

export const Uri = {
	file: (path: string) => ({ fsPath: path }),
	joinPath: (...args: unknown[]) => ({ fsPath: (args as Array<{fsPath?: string}>).map(a => a?.fsPath || a).join('/') }),
};

export const env = {
	openExternal: () => {},
};
