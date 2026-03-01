import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState, AgentContext } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS, ADOPT_RECENT_THRESHOLD_MS } from './constants.js';
import { log } from './logger.js';

const isMacOS = process.platform === 'darwin';

export function startFileWatching(
	agentId: number,
	filePath: string,
	ctx: AgentContext,
): void {
	if (isMacOS) {
		// macOS: fs.watch is unreliable — use fs.watchFile (stat-based polling)
		try {
			fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
				readNewLines(agentId, ctx);
			});
		} catch (e) {
			log.warn(`fs.watchFile failed for agent ${agentId}:`, e);
		}
	} else {
		// Windows/Linux: fs.watch is event-based and reliable
		try {
			const watcher = fs.watch(filePath, () => {
				readNewLines(agentId, ctx);
			});
			ctx.fileWatchers.set(agentId, watcher);
		} catch (e) {
			log.warn(`fs.watch failed for agent ${agentId}:`, e);
		}
	}
}

export function stopFileWatching(agentId: number, filePath: string, ctx: AgentContext): void {
	// Stop fs.watch (Windows/Linux)
	ctx.fileWatchers.get(agentId)?.close();
	ctx.fileWatchers.delete(agentId);
	// Stop fs.watchFile (macOS)
	try { fs.unwatchFile(filePath); } catch { log.debug('unwatchFile ignored (already removed)'); }
}

export function readNewLines(
	agentId: number,
	ctx: AgentContext,
): void {
	const agent = ctx.agents.get(agentId);
	if (!agent) {return;}
	if (agent._reading) {return;}
	agent._reading = true;
	try {
		const stat = fs.statSync(agent.jsonlFile);
		if (stat.size <= agent.fileOffset) {return;}

		const buf = Buffer.alloc(stat.size - agent.fileOffset);
		const fd = fs.openSync(agent.jsonlFile, 'r');
		fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
		fs.closeSync(fd);
		agent.fileOffset = stat.size;

		const text = agent.lineBuffer + buf.toString('utf-8');
		const lines = text.split('\n');
		agent.lineBuffer = lines.pop() || '';

		const hasLines = lines.some(l => l.trim());
		if (hasLines) {
			// New data arriving — cancel timers (data flowing means agent is still active)
			cancelWaitingTimer(agentId, ctx);
			cancelPermissionTimer(agentId, ctx);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				ctx.webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) {continue;}
			processTranscriptLine(agentId, line, ctx);
		}
	} catch (e) {
		log.error(`Read error for agent ${agentId}:`, e);
	} finally {
		agent._reading = false;
	}
}

function isTerminalOwned(terminal: vscode.Terminal, agents: Map<number, AgentState>): boolean {
	for (const agent of agents.values()) {
		if (agent.terminalRef === terminal) {return true;}
	}
	return false;
}

export function adoptExistingSessions(
	projectDir: string,
	ctx: AgentContext,
): void {
	let files: string[];
	try {
		files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
	} catch { log.debug('Project dir not readable:', projectDir); return; }

	const now = Date.now();
	const recentFiles = files.filter(f => {
		if (ctx.knownJsonlFiles.has(f)) {return false;}
		try {
			const stat = fs.statSync(f);
			return (now - stat.mtimeMs) < ADOPT_RECENT_THRESHOLD_MS;
		} catch { return false; }
	});

	if (recentFiles.length === 0) {return;}

	// Collect unowned terminals
	const unownedTerminals = vscode.window.terminals.filter(t => !isTerminalOwned(t, ctx.agents));

	// Match by session ID: JSONL filename = <uuid>.jsonl, terminal may contain session UUID
	for (const file of recentFiles) {
		const sessionId = path.basename(file, '.jsonl');
		// Try session-based matching first (terminal name may contain the session UUID)
		const matchedTerminal = unownedTerminals.find(t => t.name.includes(sessionId));
		if (matchedTerminal) {
			ctx.knownJsonlFiles.add(file);
			adoptTerminalForFile(matchedTerminal, file, projectDir, ctx);
			// Remove from unowned pool
			const idx = unownedTerminals.indexOf(matchedTerminal);
			if (idx !== -1) {unownedTerminals.splice(idx, 1);}
		} else if (unownedTerminals.length > 0) {
			// Fallback: pair with first available unowned terminal
			ctx.knownJsonlFiles.add(file);
			adoptTerminalForFile(unownedTerminals.shift()!, file, projectDir, ctx);
		} else {
			// No terminal available — defer for later
			ctx.adoptableFiles.add(file);
		}
	}

	if (ctx.adoptableFiles.size > 0) {
		log.info(` ${ctx.adoptableFiles.size} session(s) deferred — waiting for terminal focus`);
	}
}

export function ensureProjectScan(
	projectDir: string,
	ctx: AgentContext,
): void {
	if (ctx.projectScanTimerRef.current) {return;}
	// Seed with all existing JSONL files so we only react to truly new ones
	try {
		const files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
		for (const f of files) {
			ctx.knownJsonlFiles.add(f);
		}
	} catch { log.debug('Project dir not yet created:', projectDir); }

	ctx.projectScanTimerRef.current = setInterval(() => {
		scanForNewJsonlFiles(projectDir, ctx);
	}, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewJsonlFiles(
	projectDir: string,
	ctx: AgentContext,
): void {
	// Check deferred adoptable files against unowned active terminal (one per tick)
	if (ctx.adoptableFiles.size > 0) {
		const activeTerminal = vscode.window.activeTerminal;
		if (activeTerminal && !isTerminalOwned(activeTerminal, ctx.agents)) {
			for (const file of ctx.adoptableFiles) {
				ctx.adoptableFiles.delete(file);
				ctx.knownJsonlFiles.add(file);
				adoptTerminalForFile(activeTerminal, file, projectDir, ctx);
				break; // one per tick
			}
		}
	}

	let files: string[];
	try {
		files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
	} catch { log.debug('Scan dir not readable:', projectDir); return; }

	for (const file of files) {
		if (!ctx.knownJsonlFiles.has(file)) {
			ctx.knownJsonlFiles.add(file);
			if (ctx.activeAgentIdRef.current !== null) {
				// Active agent focused → /clear reassignment
				log.info(` New JSONL detected: ${path.basename(file)}, reassigning to agent ${ctx.activeAgentIdRef.current}`);
				reassignAgentToFile(ctx.activeAgentIdRef.current, file, ctx);
			} else {
				// No active agent → try to adopt the focused terminal
				const activeTerminal = vscode.window.activeTerminal;
				if (activeTerminal && !isTerminalOwned(activeTerminal, ctx.agents)) {
					adoptTerminalForFile(activeTerminal, file, projectDir, ctx);
				} else {
					// Can't adopt now — defer
					ctx.adoptableFiles.add(file);
				}
			}
		}
	}
}

export function adoptTerminalForFile(
	terminal: vscode.Terminal,
	jsonlFile: string,
	projectDir: string,
	ctx: AgentContext,
): void {
	const id = ctx.nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		projectDir,
		jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		turnState: 'idle',
	};

	ctx.agents.set(id, agent);
	ctx.activeAgentIdRef.current = id;
	ctx.persistAgents();

	log.info(`Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`);
	ctx.webview?.postMessage({ type: 'agentCreated', id });

	startFileWatching(id, jsonlFile, ctx);
	readNewLines(id, ctx);
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	ctx: AgentContext,
): void {
	const agent = ctx.agents.get(agentId);
	if (!agent) {return;}

	// Stop old file watching
	stopFileWatching(agentId, agent.jsonlFile, ctx);

	// Clear activity
	cancelWaitingTimer(agentId, ctx);
	cancelPermissionTimer(agentId, ctx);
	clearAgentActivity(agentId, ctx);

	// Swap to new file
	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	ctx.persistAgents();

	// Start watching new file
	startFileWatching(agentId, newFilePath, ctx);
	readNewLines(agentId, ctx);
}
