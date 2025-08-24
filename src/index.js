const PORT = process.env.PORT || 4046;

const express = require('express');
const http = require('http');
const _ = require('lodash');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: [/^http:\/\/localhost:\d+$/],
		methods: ['GET', 'POST']
	}
});

const TASKS = [
	// 'Flip the light bulbs on or off (THE DOME)',
	// 'Set the A/C to 16 or 20 (THE DOME)',
	// 'Start a fire (wait 20 seconds at the fire) (FIRE PIT)',
	// 'Sit at picnic bench (30 seconds) (OUTSIDE)',
	// 'Sit in the sauna (wait 30 seconds) (SAUNA)',
	// 'Shoot cans (picnic tables) (reset)',
	// 'Put the hose back (reset) (THE SHED)',
	// 'Pump the bike pump 5 times (THE PORCH)',
	// 'Sweep the whole porch (THE PORCH)',
	'Build a house of cards (2 layers) (LIVING FIRST FLOOR)',
	'Get ring on the hook (DINING)',
	'Flip the light switch on or off (LIVING FIRST FLOOR)',
	// 'Wash your hands (KITCHEN)',
	'Fill 3 cups of water (KITCHEN)',
	'Climb the bunkbed (BR3)',
	'Hide in the closet (30 seconds) (BR3)',
	'Flip both light switches (BR2)',
	'Open/Close curtains (BR2)',
	'Flip both light switches (BR1)',
	'Flush the toilet (BATH 1st Floor)',
	'Wash your handss (BATH 1st Floor)',
	'Set thermostat to 25 and 20 then 23 (1st floor hallway)',
	'Put on life jacket and take off (basement stairs)',
	'Pick up and put snowshoe on the shelf (STORAGE)',
	// 'Turn lamp switch on or off (BR4)',
	'Climb bunch bed (BR4)',
	'Hide in closet (30 seconds) (BR4)',
	'Flush toilet (BATH basement)',
	'Wash hands (BATH basement)',
	'Serve a ping pong (LIVING basement)',
	'Flip lamp on off (LIVING basement)',
	'Set A/C to 50 and 60 and 67 and turn off (LIVING basement)',
	// 'Fix the satellite dish (30 seconds) (OUTSIDE front)',
	// '2 Ball in hoop (OUTSIDE front)',
	// 'Fix car engine BMW(30 seconds) (outside front)',
	// 'Fix car engine CX-30(30 seconds) (outside front)',
	// 'Put BBQ fork in bag (reset) (FRONT DECK)'
];
const N_TASKS = 5;
const N_IMPOSTORS = 1;

let taskProgress = {};
let isMeeting = false;
let isGameActive = false;
let gameConfig = {
	tasks: TASKS,
	numImpostors: N_IMPOSTORS,
	emergencyCooldownMinutes: 0,
	killCooldownSeconds: 0,
	// Max number of players that can receive the same task label
	maxPlayersPerTask: 2,
	// New: sabotage duration in seconds
	sabotageDurationSeconds: 20,
	// New: shared sabotage charges for all impostors
	sabotageCharges: 2
};
let emergencyCooldownEndMs = 0;
let lastMeetingType = null; // 'emergency' | 'report' | null
let impostorIds = new Set();
let killCooldownEndMsBySocketId = {};
// Auth-based mappings for reconnect/rehydration
let socketIdToAuth = {};
let authToPlayer = {}; // auth -> { role: string, tasks: { [taskId]: label } }
let impostorAuths = new Set();
let killCooldownEndMsByAuth = {};
// Sabotage state
let isSabotageActive = false;
let sabotageEndMs = 0;
let sabotageTimeout = null;
let sabotageUsedAuths = new Set();
let sabotageChargesRemaining = 0;

app.use('/', express.static(path.join(__dirname, 'public')));

if (process.env.NODE_ENV === 'production') {
	const clientBuildPath = path.join(__dirname, '..', 'web', 'dist');
	app.use(express.static(clientBuildPath));
	app.get('*', (req, res) => {
		res.sendFile(path.join(clientBuildPath, 'index.html'));
	});
} else {
	app.get('/', (req, res) => {
		res.sendFile(path.join(__dirname, 'views', 'index.html'));
	});

	app.get('/admin', (req, res) => {
		res.sendFile(path.join(__dirname, 'views', 'admin.html'));
	});
}

io.on('connection', socket => {
	console.log(
		`A user connected with role: ${socket.handshake.query.role}, total: ${
			io.of('/').sockets.size
		}`
	);

	// Associate socket with auth token (fallback to socket.id)
	const auth = socket.handshake.query.auth || socket.id;
	socketIdToAuth[socket.id] = auth;
	console.log('[connect] socket', socket.id, 'auth', auth);

	// Send current state to newly connected clients
	socket.emit('state', { isMeeting, isGameActive, emergencyCooldownEndMs, config: gameConfig, sabotageEndMs, sabotageChargesRemaining });

	// If the connecting socket is an impostor, send its kill cooldown snapshot
	if (isGameActive && impostorIds.has(socket.id)) {
		const endMs = killCooldownEndMsBySocketId[socket.id] || 0;
		socket.emit('kill-cooldown-updated', { endMs });
	}

	// If a player joins mid-game, rehydrate role and cooldown if known
	if (isGameActive && socket.handshake.query.role === 'PLAYER') {
		if (impostorAuths.has(auth)) {
			impostorIds.add(socket.id);
			const endMs = killCooldownEndMsByAuth[auth] || 0;
			killCooldownEndMsBySocketId[socket.id] = endMs;
			socket.emit('role', 'Impostor');
			socket.emit('kill-cooldown-updated', { endMs });
			console.log('[rehydrate] impostor', { socketId: socket.id, auth, endMs });
		} else if (authToPlayer[auth]?.role === 'Crewmate') {
			socket.emit('role', 'Crewmate');
			console.log('[rehydrate] crewmate', { socketId: socket.id, auth });
		}
	}

	// Allow clients to request a fresh snapshot of state
	socket.on('get-state', () => {
		socket.emit('state', { isMeeting, isGameActive, emergencyCooldownEndMs, config: gameConfig, sabotageEndMs, sabotageChargesRemaining });
		console.log('[get-state]', { socketId: socket.id, auth: socketIdToAuth[socket.id], isMeeting, isGameActive, emergencyCooldownEndMs });
	});

	// Rehydration: client asks who am I with its auth
	socket.on('whoami', (payload) => {
		const incomingAuth = (payload && typeof payload === 'object' && payload.auth) ? String(payload.auth) : (socket.handshake.query.auth || socket.id);
		// Update mapping so subsequent events use this auth
		socketIdToAuth[socket.id] = incomingAuth;
		let info = authToPlayer[incomingAuth];
		// If not found, check if we accidentally stored by socket.id and migrate
		if (!info && authToPlayer[socket.id]) {
			authToPlayer[incomingAuth] = authToPlayer[socket.id];
			delete authToPlayer[socket.id];
			// Migrate impostor/auth cooldown mappings if present
			if (impostorAuths.has(socket.id)) {
				impostorAuths.delete(socket.id);
				impostorAuths.add(incomingAuth);
			}
			if (typeof killCooldownEndMsByAuth[socket.id] !== 'undefined') {
				killCooldownEndMsByAuth[incomingAuth] = killCooldownEndMsByAuth[socket.id];
				delete killCooldownEndMsByAuth[socket.id];
			}
			info = authToPlayer[incomingAuth];
		}
		// Always send state snapshot
		socket.emit('state', { isMeeting, isGameActive, emergencyCooldownEndMs, config: gameConfig, sabotageEndMs, sabotageChargesRemaining });
		console.log('[whoami]', { socketId: socket.id, incomingAuth, found: !!info, role: info?.role, tasks: info ? Object.keys(info.tasks || {}).length : 0, impostor: impostorAuths.has(incomingAuth) });
		if (!info) {
			// If game is starting, assignment might still be in-flight. Retry once shortly.
			setTimeout(() => {
				const later = authToPlayer[incomingAuth];
				if (!later) return;
				if (later.role) socket.emit('role', later.role);
				if (later.tasks) socket.emit('tasks', later.tasks);
				socket.emit('tasks-completed', getCompletionMapForAuth(incomingAuth));
				const vals = Object.values(taskProgress);
				const ratio = vals.length ? vals.filter(Boolean).length / vals.length : 0;
				socket.emit('progress', ratio);
				if (impostorAuths.has(incomingAuth)) {
					impostorIds.add(socket.id);
					const endMs = killCooldownEndMsByAuth[incomingAuth] || 0;
					killCooldownEndMsBySocketId[socket.id] = endMs;
					socket.emit('kill-cooldown-updated', { endMs });
				}
			}, 300);
			return;
		}
		if (info.role) socket.emit('role', info.role);
		if (info.tasks) socket.emit('tasks', info.tasks);
		socket.emit('tasks-completed', getCompletionMapForAuth(incomingAuth));
		// Hydrate sabotage status
		socket.emit('sabotage-usage', { used: sabotageUsedAuths.has(incomingAuth) });
		if (isSabotageActive && sabotageEndMs > Date.now()) {
			socket.emit('sabotage-started', { endMs: sabotageEndMs });
		}
		// Send current progress so the client can hydrate the progress bar
		const vals = Object.values(taskProgress);
		const ratio = vals.length ? vals.filter(Boolean).length / vals.length : 0;
		socket.emit('progress', ratio);
		if (impostorAuths.has(incomingAuth)) {
			impostorIds.add(socket.id);
			const endMs = killCooldownEndMsByAuth[incomingAuth] || 0;
			killCooldownEndMsBySocketId[socket.id] = endMs;
			socket.emit('kill-cooldown-updated', { endMs });
		}
	});

	socket.on('start-game', payload => {
		// Update runtime config from admin payload if provided
		if (payload && typeof payload === 'object') {
			if (Array.isArray(payload.tasks) && payload.tasks.length > 0) {
				gameConfig.tasks = payload.tasks;
			}
			if (typeof payload.numImpostors === 'number' && payload.numImpostors >= 0) {
				gameConfig.numImpostors = payload.numImpostors;
			}
			if (typeof payload.emergencyCooldownMinutes === 'number' && payload.emergencyCooldownMinutes >= 0) {
				gameConfig.emergencyCooldownMinutes = payload.emergencyCooldownMinutes;
			}
			if (typeof payload.killCooldownSeconds === 'number' && payload.killCooldownSeconds >= 0) {
				gameConfig.killCooldownSeconds = payload.killCooldownSeconds;
			}
			if (typeof payload.maxPlayersPerTask === 'number' && payload.maxPlayersPerTask > 0) {
				gameConfig.maxPlayersPerTask = payload.maxPlayersPerTask;
			}
			if (typeof payload.sabotageDurationSeconds === 'number' && payload.sabotageDurationSeconds >= 0) {
				gameConfig.sabotageDurationSeconds = payload.sabotageDurationSeconds;
			}
			if (typeof payload.sabotageCharges === 'number' && payload.sabotageCharges >= 0) {
				gameConfig.sabotageCharges = payload.sabotageCharges;
			}
		}
		console.log('[start-game] config', gameConfig);
		// Get player sockets
		const players = [];
		for (const [_, socket] of io.of('/').sockets) {
			if (socket.handshake.query.role === 'PLAYER') {
				players.push(socket);
			}
		}
		const playerIds = players.map(player => player.id);
		console.log('[start-game] player sockets', players.length);

		// Guard: need at least 1 player
		if (playerIds.length === 0) {
			return socket.emit('start-error', { reason: 'no-players' });
		}

		// Assign impostors (ensure at least 1, at most number of players)
		const impostorCount = Math.max(1, Math.min(gameConfig.numImpostors || 1, playerIds.length));
		const impostors = _.shuffle(playerIds).slice(0, impostorCount);
		impostorIds = new Set(impostors);
		// Build auth mapping for players and reset persisted maps
		const authBySocketId = {};
		for (const p of players) {
			authBySocketId[p.id] = p.handshake.query.auth || p.id;
		}
		impostorAuths = new Set(impostors.map(id => authBySocketId[id]));
		const uniqueAuths = Array.from(new Set(Object.values(authBySocketId)));
		console.log('[start-game] impostors (socketIds)', Array.from(impostorIds));
		console.log('[start-game] impostors (auths)', Array.from(impostorAuths));
		console.log('[start-game] unique players (auths)', uniqueAuths);
		authToPlayer = {};
		killCooldownEndMsByAuth = {};
		killCooldownEndMsBySocketId = {};
		// Reset sabotage state
		isSabotageActive = false;
		sabotageEndMs = 0;
		sabotageUsedAuths = new Set();
		sabotageChargesRemaining = Math.max(0, Number(gameConfig.sabotageCharges || 0));
		if (sabotageTimeout) {
			clearTimeout(sabotageTimeout);
			sabotageTimeout = null;
		}
		const initialKillCooldownMs = Math.max(0, (gameConfig.killCooldownSeconds || 0) * 1000);
		const startNow = Date.now();
		// Phase 1: assign all impostors first
		for (const id of impostors) {
			const socket = io.of('/').sockets.get(id);
			if (!socket || socket.handshake.query.role !== 'PLAYER') continue;
			socket.emit('role', 'Impostor');
			const a = authBySocketId[id] || id;
			killCooldownEndMsByAuth[a] = startNow + initialKillCooldownMs;
			killCooldownEndMsBySocketId[id] = killCooldownEndMsByAuth[a];
			socket.emit('kill-cooldown-updated', { endMs: killCooldownEndMsBySocketId[id] });
			console.log('[start-game] role-assigned', { socketId: id, auth: a, role: 'Impostor', killCooldownEndMs: killCooldownEndMsBySocketId[id] });
		}
		// Phase 2: assign the remaining players as crewmates
		for (const id of playerIds) {
			if (impostors.includes(id)) continue;
			const socket = io.of('/').sockets.get(id);
			if (!socket || socket.handshake.query.role !== 'PLAYER') continue;
			socket.emit('role', 'Crewmate');
			console.log('[start-game] role-assigned', { socketId: id, auth: authBySocketId[id] || id, role: 'Crewmate' });
		}

		// Assign tasks with per-player uniqueness and global per-task cap
		const tasksPool = Array.isArray(gameConfig.tasks) ? gameConfig.tasks.slice() : [];
		const maxPerTask = Math.max(1, Number(gameConfig.maxPlayersPerTask || 2));
		const assignedCountByTask = {};
		for (const t of tasksPool) assignedCountByTask[t] = 0;

		// Track each player's assigned labels to enforce uniqueness
		const playerTaskLabels = {};
		const playerTasks = {};
		taskProgress = {};
		for (const a of uniqueAuths) {
			playerTaskLabels[a] = new Set();
			playerTasks[a] = {};
		}

		for (let i = 0; i < N_TASKS; i++) {
			for (const a of uniqueAuths) {
				const labelSet = playerTaskLabels[a];
				// Preferred candidates: not already assigned to this player AND under cap
				let candidates = tasksPool.filter(t => !labelSet.has(t) && (assignedCountByTask[t] || 0) < maxPerTask);
				// Fallback if cap is too strict: allow any not-yet-assigned-to-this-player
				if (candidates.length === 0) {
					candidates = tasksPool.filter(t => !labelSet.has(t));
				}
				// If still none, we cannot assign more unique tasks to this player
				if (candidates.length === 0) {
					continue;
				}
				// Choose among least-used tasks to balance distribution
				const minCount = Math.min(...candidates.map(t => assignedCountByTask[t] || 0));
				const leastUsed = candidates.filter(t => (assignedCountByTask[t] || 0) === minCount);
				const taskLabel = _.shuffle(leastUsed)[0];

				labelSet.add(taskLabel);
				assignedCountByTask[taskLabel] = (assignedCountByTask[taskLabel] || 0) + 1;

				const taskId = uuid();
				playerTasks[a][taskId] = taskLabel;
				console.log('[assign-task]', { auth: a, taskId, taskLabel });
				if (!impostorAuths.has(a)) {
					taskProgress[taskId] = false;
				}
			}
		}
		console.log('[assignment-summary] per-task counts', assignedCountByTask);

		console.log('player tasks', playerTasks);

		for (const [id, socket] of io.of('/').sockets) {
			if (playerIds.includes(id)) {
				const a = authBySocketId[id] || id;
				socket.emit('tasks', playerTasks[a]);
				console.log('[emit-tasks]', { socketId: id, auth: a, count: Object.keys(playerTasks[a] || {}).length });
				// Also send completion snapshot and current progress for this auth
				socket.emit('tasks-completed', getCompletionMapForAuth(a));
				const vals = Object.values(taskProgress);
				const ratio = vals.length ? vals.filter(Boolean).length / vals.length : 0;
				socket.emit('progress', ratio);
			}
		}

		// Persist assigned role and tasks by auth
		for (const a of uniqueAuths) {
			const role = impostorAuths.has(a) ? 'Impostor' : 'Crewmate';
			authToPlayer[a] = authToPlayer[a] || {};
			authToPlayer[a].role = role;
			authToPlayer[a].tasks = playerTasks[a] || {};
		}

		// Broadcast initial sabotage charges to all clients
		io.emit('sabotage-charges', { remaining: sabotageChargesRemaining });

		emitTaskProgress();

		// Start game state
		isMeeting = false;
		isGameActive = true;
		emergencyCooldownEndMs = 0;
		lastMeetingType = null;
		io.emit('game-started');
		io.emit('cooldown-updated', { emergencyCooldownEndMs });
		console.log('[game-started]');
	});

	socket.on('report', () => {
		if (!isGameActive || isMeeting) return;
		isMeeting = true;
		lastMeetingType = 'report';
		io.emit('play-meeting');
		io.emit('meeting-started');
		console.log('[report]', { socketId: socket.id, auth: socketIdToAuth[socket.id] });
	});

	socket.on('emergency-meeting', () => {
		if (!isGameActive || isMeeting) return;
		if (Date.now() < emergencyCooldownEndMs) return;
		isMeeting = true;
		lastMeetingType = 'emergency';
		io.emit('play-meeting');
		io.emit('meeting-started');
		console.log('[emergency-meeting]', { socketId: socket.id, auth: socketIdToAuth[socket.id] });
	});

	socket.on('continue-game', () => {
		if (!isGameActive) return;
		isMeeting = false;
		// Reset kill cooldown for all impostors at the end of a meeting
		const killMs = Math.max(0, (gameConfig.killCooldownSeconds || 0) * 1000);
		const now = Date.now();
		for (const id of impostorIds) {
			killCooldownEndMsBySocketId[id] = now + killMs;
			const sock = io.of('/').sockets.get(id);
			if (sock) {
				sock.emit('kill-cooldown-updated', { endMs: killCooldownEndMsBySocketId[id] });
			}
			const a = socketIdToAuth[id];
			if (a) killCooldownEndMsByAuth[a] = now + killMs;
			console.log('[cooldown-reset-after-meeting]', { socketId: id, auth: a, endMs: killCooldownEndMsBySocketId[id] });
		}
		if (lastMeetingType === 'emergency' && gameConfig.emergencyCooldownMinutes > 0) {
			emergencyCooldownEndMs = Date.now() + gameConfig.emergencyCooldownMinutes * 60 * 1000;
		}
		io.emit('meeting-ended');
		io.emit('cooldown-updated', { emergencyCooldownEndMs });
		console.log('[meeting-ended]', { emergencyCooldownEndMs });
	});

	socket.on('end-game', () => {
		if (!isGameActive) return;
		isMeeting = false;
		isGameActive = false;
		emergencyCooldownEndMs = 0;
		impostorIds = new Set();
		impostorAuths = new Set();
		killCooldownEndMsBySocketId = {};
		killCooldownEndMsByAuth = {};
		// Clear sabotage
		isSabotageActive = false;
		sabotageEndMs = 0;
		sabotageUsedAuths = new Set();
		if (sabotageTimeout) {
			clearTimeout(sabotageTimeout);
			sabotageTimeout = null;
		}
		sabotageChargesRemaining = 0;
		for (const key of Object.keys(authToPlayer)) {
			if (authToPlayer[key]) {
				authToPlayer[key].tasks = {};
				authToPlayer[key].role = '';
			}
		}
		io.emit('game-ended');
		io.emit('cooldown-updated', { emergencyCooldownEndMs });
		console.log('[game-ended]');
	});

	// Impostor kill attempt
	socket.on('kill', () => {
		if (!isGameActive || isMeeting) return;
		if (!impostorIds.has(socket.id)) return;
		const now = Date.now();
		const endMs = killCooldownEndMsBySocketId[socket.id] || 0;
		if (now < endMs) return; // still cooling down
		const cooldownMs = Math.max(0, (gameConfig.killCooldownSeconds || 0) * 1000);
		killCooldownEndMsBySocketId[socket.id] = now + cooldownMs;
		const a = socketIdToAuth[socket.id];
		if (a) killCooldownEndMsByAuth[a] = killCooldownEndMsBySocketId[socket.id];
		socket.emit('kill-cooldown-updated', { endMs: killCooldownEndMsBySocketId[socket.id] });
		console.log('[kill]', { socketId: socket.id, auth: a, endMs: killCooldownEndMsBySocketId[socket.id] });
	});

	// Impostor sabotage attempt (one-time per impostor)
	socket.on('sabotage', () => {
		if (!isGameActive || isMeeting) return;
		if (!impostorIds.has(socket.id)) return;
		const a = socketIdToAuth[socket.id];
		if (!a) return;
		if (sabotageUsedAuths.has(a)) return;
		if (isSabotageActive && sabotageEndMs > Date.now()) return;
		if (sabotageChargesRemaining <= 0) return;
		const durationMs = Math.max(0, (gameConfig.sabotageDurationSeconds || 0) * 1000);
		const endMs = Date.now() + durationMs;
		isSabotageActive = true;
		sabotageEndMs = endMs;
		sabotageUsedAuths.add(a);
		sabotageChargesRemaining = Math.max(0, sabotageChargesRemaining - 1);
		io.emit('sabotage-started', { endMs });
		io.emit('sabotage-charges', { remaining: sabotageChargesRemaining });
		// Also inform this impostor they've used their sabotage
		socket.emit('sabotage-usage', { used: true });
		if (sabotageTimeout) clearTimeout(sabotageTimeout);
		sabotageTimeout = setTimeout(() => {
			isSabotageActive = false;
			sabotageEndMs = 0;
			io.emit('sabotage-ended');
			sabotageTimeout = null;
		}, durationMs);
	});

	socket.on('task-complete', taskId => {
		if (isMeeting || !isGameActive) return;
		if (typeof taskProgress[taskId] === 'boolean') {
			taskProgress[taskId] = true;
		}
		emitTaskProgress();
		console.log('[task-complete]', { socketId: socket.id, auth: socketIdToAuth[socket.id], taskId });
		const a = socketIdToAuth[socket.id];
		if (a) {
			socket.emit('tasks-completed', getCompletionMapForAuth(a));
		}
	});

	socket.on('task-incomplete', taskId => {
		if (isMeeting || !isGameActive) return;
		if (typeof taskProgress[taskId] === 'boolean') {
			taskProgress[taskId] = false;
		}
		emitTaskProgress();
		console.log('[task-incomplete]', { socketId: socket.id, auth: socketIdToAuth[socket.id], taskId });
		const a = socketIdToAuth[socket.id];
		if (a) {
			socket.emit('tasks-completed', getCompletionMapForAuth(a));
		}
	});

	socket.on('disconnect', () => {
		delete killCooldownEndMsBySocketId[socket.id];
		delete socketIdToAuth[socket.id];
	});
});

function emitTaskProgress() {
	const tasks = Object.values(taskProgress);
	const completed = tasks.filter(task => task).length;
	const total = completed / tasks.length;
	io.emit('progress', total);
	console.log('[progress]', { completed, totalTasks: tasks.length, ratio: total });

	if (total === 1) {
		io.emit('play-win');
	}
}

// Compute completion snapshot for a specific player auth
function getCompletionMapForAuth(a) {
	const info = authToPlayer[a];
	const result = {};
	if (!info || !info.tasks) return result;
	for (const taskId of Object.keys(info.tasks)) {
		result[taskId] = !!taskProgress[taskId];
	}
	return result;
}

server.listen(PORT, () => console.log(`Server listening on *:${PORT}`));
