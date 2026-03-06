import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import type { AgentState, AgentContext, PersistedAgent } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, stopFileWatching, readNewLines, ensureProjectScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, TERMINAL_NAME_PREFIX, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS, ATTACHED_STALE_CHECK_INTERVAL_MS, ATTACHED_STALE_THRESHOLD_MS } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { log } from './logger.js';

export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) {return null;}
	const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
	const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);
	log.info(` Project dir: ${workspacePath} → ${dirName}`);
	return projectDir;
}

export async function launchNewTerminal(
	nextTerminalIndexRef: { current: number },
	ctx: AgentContext,
	folderPath?: string,
): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	const cwd = folderPath || folders?.[0]?.uri.fsPath;
	const isMultiRoot = !!(folders && folders.length > 1);
	const idx = nextTerminalIndexRef.current++;
	const terminal = vscode.window.createTerminal({
		name: `${TERMINAL_NAME_PREFIX} #${idx}`,
		cwd,
	});
	terminal.show();

	const sessionId = crypto.randomUUID();
	terminal.sendText(`claude --session-id ${sessionId}`);

	const projectDir = getProjectDirPath(cwd);
	if (!projectDir) {
		log.info(` No project dir, cannot track agent`);
		return;
	}

	// Pre-register expected JSONL file so project scan won't treat it as a /clear file
	const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
	ctx.knownJsonlFiles.add(expectedFile);

	// Create agent immediately (before JSONL file exists)
	const id = ctx.nextAgentIdRef.current++;
	const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		projectDir,
		jsonlFile: expectedFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		activeSubagentToolTimestamps: new Map(),
		isWaiting: false,
		permissionSent: false,
		turnState: 'idle',
		folderName,
	};

	ctx.agents.set(id, agent);
	ctx.activeAgentIdRef.current = id;
	ctx.persistAgents();
	log.info(` Agent ${id}: created for terminal ${terminal.name}`);
	ctx.webview?.postMessage({ type: 'agentCreated', id, folderName });

	ensureProjectScan(projectDir, ctx);

	// Poll for the specific JSONL file to appear
	const pollTimer = setInterval(() => {
		try {
			if (fs.existsSync(agent.jsonlFile)) {
				log.info(` Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
				clearInterval(pollTimer);
				ctx.jsonlPollTimers.delete(id);
				startFileWatching(id, agent.jsonlFile, ctx);
				readNewLines(id, ctx);
			}
		} catch { log.debug(`Agent ${id}: JSONL file not yet created`); }
	}, JSONL_POLL_INTERVAL_MS);
	ctx.jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
	agentId: number,
	ctx: AgentContext,
): void {
	const agent = ctx.agents.get(agentId);
	if (!agent) {return;}

	// Stop JSONL poll timer
	const jpTimer = ctx.jsonlPollTimers.get(agentId);
	if (jpTimer) { clearInterval(jpTimer); }
	ctx.jsonlPollTimers.delete(agentId);

	// Stop file watching
	stopFileWatching(agentId, agent.jsonlFile, ctx);

	// Cancel timers
	cancelWaitingTimer(agentId, ctx);
	cancelPermissionTimer(agentId, ctx);

	// Remove from maps
	ctx.agents.delete(agentId);
	ctx.persistAgents();
}

export function attachSession(
	jsonlFile: string,
	projectDir: string,
	ctx: AgentContext,
): void {
	const id = ctx.nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		terminalRef: null,
		projectDir,
		jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		activeSubagentToolTimestamps: new Map(),
		isWaiting: false,
		permissionSent: false,
		turnState: 'idle',
		isAttached: true,
	};

	ctx.agents.set(id, agent);
	ctx.persistAgents();

	log.info(`Agent ${id}: attached external session ${path.basename(jsonlFile)}`);
	ctx.webview?.postMessage({ type: 'agentCreated', id, isAttached: true });

	startFileWatching(id, jsonlFile, ctx);
	readNewLines(id, ctx);
}

export function startAttachedStaleCheck(ctx: AgentContext): ReturnType<typeof setInterval> {
	return setInterval(() => {
		const now = Date.now();
		for (const [id, agent] of ctx.agents) {
			if (!agent.isAttached) {continue;}
			try {
				const stat = fs.statSync(agent.jsonlFile);
				if ((now - stat.mtimeMs) > ATTACHED_STALE_THRESHOLD_MS) {
					log.info(`Agent ${id}: attached session stale (no writes for ${Math.round((now - stat.mtimeMs) / 1000)}s), removing`);
					removeAgent(id, ctx);
					ctx.webview?.postMessage({ type: 'agentClosed', id });
				}
			} catch {
				// File gone — remove agent
				log.info(`Agent ${id}: attached JSONL file gone, removing`);
				removeAgent(id, ctx);
				ctx.webview?.postMessage({ type: 'agentClosed', id });
			}
		}
	}, ATTACHED_STALE_CHECK_INTERVAL_MS);
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			terminalName: agent.terminalRef?.name ?? null,
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
			folderName: agent.folderName,
			isAttached: agent.isAttached,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextTerminalIndexRef: { current: number },
	ctx: AgentContext,
): void {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) {return;}

	const liveTerminals = vscode.window.terminals;
	let maxId = 0;
	let maxIdx = 0;
	let restoredProjectDir: string | null = null;

	for (const p of persisted) {
		let terminal: vscode.Terminal | null = null;

		if (p.isAttached) {
			// Attached agents don't need a terminal — just check JSONL exists
			if (!fs.existsSync(p.jsonlFile)) {continue;}
		} else {
			terminal = liveTerminals.find(t => t.name === p.terminalName) ?? null;
			if (!terminal) {continue;}
		}

		const agent: AgentState = {
			id: p.id,
			terminalRef: terminal,
			projectDir: p.projectDir,
			jsonlFile: p.jsonlFile,
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			activeSubagentToolTimestamps: new Map(),
			isWaiting: false,
			permissionSent: false,
			turnState: 'idle',
			folderName: p.folderName,
			isAttached: p.isAttached,
		};

		ctx.agents.set(p.id, agent);
		ctx.knownJsonlFiles.add(p.jsonlFile);
		log.info(` Restored agent ${p.id} → ${p.isAttached ? 'attached (external)' : `terminal "${p.terminalName}"`}`);

		if (p.id > maxId) {maxId = p.id;}
		// Extract terminal index from name like "Claude Code #3"
		if (p.terminalName) {
			const match = p.terminalName.match(/#(\d+)$/);
			if (match) {
				const idx = parseInt(match[1], 10);
				if (idx > maxIdx) {maxIdx = idx;}
			}
		}

		restoredProjectDir = p.projectDir;

		// Start file watching if JSONL exists, skipping to end of file
		try {
			if (fs.existsSync(p.jsonlFile)) {
				const stat = fs.statSync(p.jsonlFile);
				agent.fileOffset = stat.size;
				startFileWatching(p.id, p.jsonlFile, ctx);
			} else {
				// Poll for the file to appear
				const pollTimer = setInterval(() => {
					try {
						if (fs.existsSync(agent.jsonlFile)) {
							log.info(` Restored agent ${p.id}: found JSONL file`);
							clearInterval(pollTimer);
							ctx.jsonlPollTimers.delete(p.id);
							const stat = fs.statSync(agent.jsonlFile);
							agent.fileOffset = stat.size;
							startFileWatching(p.id, agent.jsonlFile, ctx);
						}
					} catch { log.debug(`Restored agent: JSONL not yet created`); }
				}, JSONL_POLL_INTERVAL_MS);
				ctx.jsonlPollTimers.set(p.id, pollTimer);
			}
		} catch (e) { log.debug('Error during agent restore:', e); }
	}

	// Advance counters past restored IDs
	if (maxId >= ctx.nextAgentIdRef.current) {
		ctx.nextAgentIdRef.current = maxId + 1;
	}
	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	// Re-persist cleaned-up list (removes entries whose terminals are gone)
	ctx.persistAgents();

	// Start project scan for /clear detection
	if (restoredProjectDir) {
		ensureProjectScan(restoredProjectDir, ctx);
	}
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) {return;}
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	// Include persisted palette/seatId from separate key
	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});

	// Include folderName and isAttached per agent
	const folderNames: Record<number, string> = {};
	const attachedIds: number[] = [];
	for (const [id, agent] of agents) {
		if (agent.folderName) {
			folderNames[id] = agent.folderName;
		}
		if (agent.isAttached) {
			attachedIds.push(id);
		}
	}
	log.info(` sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		folderNames,
		attachedIds,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) {return;}
	for (const [agentId, agent] of agents) {
		// Re-send active tools
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send waiting status
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) {return;}
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
