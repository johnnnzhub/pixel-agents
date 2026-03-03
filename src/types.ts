import type * as fs from 'fs';
import type * as vscode from 'vscode';

export const TURN_STATES = {
	idle: 'idle',
	thinking: 'thinking',
	tool_active: 'tool_active',
	tool_draining: 'tool_draining',
	text_cooldown: 'text_cooldown',
} as const;

export type AgentTurnState = typeof TURN_STATES[keyof typeof TURN_STATES];

export interface AgentState {
	id: number;
	terminalRef: vscode.Terminal | null;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	turnState: AgentTurnState;
	/** Prevents concurrent readNewLines calls from multiple watchers */
	_reading?: boolean;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
	/** true if agent was auto-detected from external session (no terminal) */
	isAttached?: boolean;
}

export interface PersistedAgent {
	id: number;
	terminalName: string | null;
	jsonlFile: string;
	projectDir: string;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
	/** true if agent was auto-detected from external session (no terminal) */
	isAttached?: boolean;
}

export interface AgentContext {
	agents: Map<number, AgentState>;
	nextAgentIdRef: { current: number };
	activeAgentIdRef: { current: number | null };
	knownJsonlFiles: Set<string>;
	adoptableFiles: Set<string>;
	fileWatchers: Map<number, fs.FSWatcher>;
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>;
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null };
	webview: vscode.Webview | undefined;
	persistAgents: () => void;
}
