import type * as fs from 'fs';
import type * as vscode from 'vscode';

// ── Webview → Extension Messages ─────────────────────────────
export type WebviewToExtensionMessage =
	| { type: 'openClaude'; folderPath?: string }
	| { type: 'focusAgent'; id: number }
	| { type: 'closeAgent'; id: number }
	| { type: 'saveAgentSeats'; seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> }
	| { type: 'saveLayout'; layout: Record<string, unknown> }
	| { type: 'setSoundEnabled'; enabled: boolean }
	| { type: 'webviewReady' }
	| { type: 'openSessionsFolder' }
	| { type: 'exportLayout' }
	| { type: 'importLayout' };

// ── Extension → Webview Messages ─────────────────────────────
export type ExtensionToWebviewMessage =
	| { type: 'agentCreated'; id: number; folderName?: string; isAttached?: boolean }
	| { type: 'agentClosed'; id: number }
	| { type: 'agentToolStart'; id: number; toolId: string; status: string }
	| { type: 'agentToolDone'; id: number; toolId: string }
	| { type: 'agentToolsClear'; id: number }
	| { type: 'agentStatus'; id: number; status: string }
	| { type: 'agentSelected'; id: number }
	| { type: 'agentToolPermission'; id: number }
	| { type: 'agentToolPermissionClear'; id: number }
	| { type: 'subagentToolStart'; id: number; parentToolId: string; toolId: string; status: string }
	| { type: 'subagentToolDone'; id: number; parentToolId: string; toolId: string }
	| { type: 'subagentToolPermission'; id: number; parentToolId: string }
	| { type: 'subagentClear'; id: number; parentToolId: string }
	| { type: 'existingAgents'; agents: number[]; agentMeta?: Record<number, { palette?: number; hueShift?: number; seatId?: string }>; folderNames?: Record<number, string>; attachedIds?: number[] }
	| { type: 'layoutLoaded'; layout: Record<string, unknown> | null }
	| { type: 'furnitureAssetsLoaded'; catalog: unknown[]; sprites: Record<string, string[][]> }
	| { type: 'floorTilesLoaded'; sprites: string[][][] }
	| { type: 'wallTilesLoaded'; sprites: string[][][] }
	| { type: 'characterSpritesLoaded'; characters: Array<{ down: string[][][]; up: string[][][]; right: string[][][] }> }
	| { type: 'workspaceFolders'; folders: Array<{ name: string; path: string }> }
	| { type: 'settingsLoaded'; soundEnabled: boolean };

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
	activeSubagentToolTimestamps: Map<string, Map<string, number>>; // parentToolId → (subToolId → startTime)
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
