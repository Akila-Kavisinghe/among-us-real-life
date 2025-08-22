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
	'Flip the light bulbs on or off (THE DOME)',
	'Set the A/C to 16 or 20 (THE DOME)',
	'Start a fire (wait 20 seconds at the fire) (FIRE PIT)',
	'Sit at picnic bench (30 seconds) (OUTSIDE)',
	'Sit in the sauna (wait 30 seconds) (SAUNA)',
	'Shoot cans (picnic tables) (reset)',
	'Put the hose back (reset) (THE SHED)',
	'Pump the bike pump 5 times (THE PORCH)',
	'Sweep the whole porch (THE PORCH)',
	'Build a house of cards (2 layers) (LIVING FIRST FLOOR)',
	'Get ring on the hook (DINING)',
	'Flip the light switch on or off (LIVING FIRST FLOOR)',
	'Wash your hands (KITCHEN)',
	'Fill a cup of water (KITCHEN)',
	'Climb the bunkbed (BR3)',
	'Hide in the closet (30 seconds) (BR3)',
	'Flip both light switches (BR2)',
	'Open/Close curtains (BR2)',
	'Flip both light switches (BR1)',
	'Flush the toilet (BATH 1st Floor)',
	'Wash your handss (BATH 1st Floor)',
	'Set thermostat to 22.5 or 23 (1st floor hallway)',
	'Put on life jacket and take off (basement stairs)',
	'Pick up and put snowshoe on the shelf (STORAGE)',
	'Turn lamp switch on or off (BR4)',
	'Climb bunch bed (BR4)',
	'Hide in closet (30 seconds) (BR4)',
	'Flush toilet (BATH basement)',
	'Wash hands (BATH basement)',
	'Serve a ping pong (LIVING basement)',
	'Flip lamp on off (LIVING basement)',
	'Set A/C to 66 or 67 and turn off (LIVING basement)',
	'Fix the satellite dish (30 seconds) (OUTSIDE front)',
	'2 Ball in hoop (OUTSIDE front)',
	'Fix car engine BMW(30 seconds) (outside front)',
	'Fix car engine CX-30(30 seconds) (outside front)',
	'Put BBQ fork in bag (reset) (FRONT DECK)'
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
	killCooldownSeconds: 0
};
let emergencyCooldownEndMs = 0;
let lastMeetingType = null; // 'emergency' | 'report' | null
let impostorIds = new Set();
let killCooldownEndMsBySocketId = {};

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

	// Send current state to newly connected clients
	socket.emit('state', { isMeeting, isGameActive, emergencyCooldownEndMs, config: gameConfig });

	// If the connecting socket is an impostor, send its kill cooldown snapshot
	if (isGameActive && impostorIds.has(socket.id)) {
		const endMs = killCooldownEndMsBySocketId[socket.id] || 0;
		socket.emit('kill-cooldown-updated', { endMs });
	}

	// If a player joins mid-game, tell them their role so UI reflects correctly
	if (isGameActive && socket.handshake.query.role === 'PLAYER') {
		if (impostorIds.has(socket.id)) {
			socket.emit('role', 'Impostor');
		} else {
			socket.emit('role', 'Crewmate');
		}
	}

	// Allow clients to request a fresh snapshot of state
	socket.on('get-state', () => {
		socket.emit('state', { isMeeting, isGameActive, emergencyCooldownEndMs, config: gameConfig });
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
		}
		// Get player sockets
		const players = [];
		for (const [_, socket] of io.of('/').sockets) {
			if (socket.handshake.query.role === 'PLAYER') {
				players.push(socket);
			}
		}
		const playerIds = players.map(player => player.id);
		console.log('player sockets', players.length);

		// Guard: need at least 1 player
		if (playerIds.length === 0) {
			return socket.emit('start-error', { reason: 'no-players' });
		}

		// Assign impostors (ensure at least 1, at most number of players)
		const impostorCount = Math.max(1, Math.min(gameConfig.numImpostors || 1, playerIds.length));
		const impostors = _.shuffle(playerIds).slice(0, impostorCount);
		impostorIds = new Set(impostors);
		killCooldownEndMsBySocketId = {};
		const initialKillCooldownMs = Math.max(0, (gameConfig.killCooldownSeconds || 0) * 1000);
		const startNow = Date.now();
		for (const [id, socket] of io.of('/').sockets) {
			if (socket.handshake.query.role === 'PLAYER') {
				if (impostors.includes(id)) {
					socket.emit('role', 'Impostor');
					killCooldownEndMsBySocketId[id] = startNow + initialKillCooldownMs;
					socket.emit('kill-cooldown-updated', { endMs: killCooldownEndMsBySocketId[id] });
					console.log(id, 'is impostor');
				} else {
					socket.emit('role', 'Crewmate');
					console.log(id, 'is crew');
				}
			}
		}

		// Pool of tasks so they are distributed evenly
		let shuffledTasks = [];

		// Dictionary with key as socket.id and value is array of tasks
		const playerTasks = {};

		// Assign tasks
		taskProgress = {};
		for (let i = 0; i < N_TASKS; i++) {
			for (const player of players) {
				// Make sure there's a pool of shuffled tasks
				if (shuffledTasks.length === 0) {
					shuffledTasks = _.shuffle(gameConfig.tasks);
				}

				if (!playerTasks[player.id]) {
					playerTasks[player.id] = {};
				}

				const taskId = uuid();
				playerTasks[player.id][taskId] = shuffledTasks.pop();

				if (!impostors.includes(player.id)) {
					taskProgress[taskId] = false;
				}
			}
		}

		console.log('player tasks', playerTasks);

		for (const [id, socket] of io.of('/').sockets) {
			if (playerIds.includes(id)) {
				socket.emit('tasks', playerTasks[id]);
			}
		}

		emitTaskProgress();

		// Start game state
		isMeeting = false;
		isGameActive = true;
		emergencyCooldownEndMs = 0;
		lastMeetingType = null;
		io.emit('game-started');
		io.emit('cooldown-updated', { emergencyCooldownEndMs });
	});

	socket.on('report', () => {
		if (!isGameActive || isMeeting) return;
		isMeeting = true;
		lastMeetingType = 'report';
		io.emit('play-meeting');
		io.emit('meeting-started');
	});

	socket.on('emergency-meeting', () => {
		if (!isGameActive || isMeeting) return;
		if (Date.now() < emergencyCooldownEndMs) return;
		isMeeting = true;
		lastMeetingType = 'emergency';
		io.emit('play-meeting');
		io.emit('meeting-started');
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
		}
		if (lastMeetingType === 'emergency' && gameConfig.emergencyCooldownMinutes > 0) {
			emergencyCooldownEndMs = Date.now() + gameConfig.emergencyCooldownMinutes * 60 * 1000;
		}
		io.emit('meeting-ended');
		io.emit('cooldown-updated', { emergencyCooldownEndMs });
	});

	socket.on('end-game', () => {
		if (!isGameActive) return;
		isMeeting = false;
		isGameActive = false;
		emergencyCooldownEndMs = 0;
		impostorIds = new Set();
		killCooldownEndMsBySocketId = {};
		io.emit('game-ended');
		io.emit('cooldown-updated', { emergencyCooldownEndMs });
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
		socket.emit('kill-cooldown-updated', { endMs: killCooldownEndMsBySocketId[socket.id] });
	});

	socket.on('task-complete', taskId => {
		if (isMeeting || !isGameActive) return;
		if (typeof taskProgress[taskId] === 'boolean') {
			taskProgress[taskId] = true;
		}
		emitTaskProgress();
	});

	socket.on('task-incomplete', taskId => {
		if (isMeeting || !isGameActive) return;
		if (typeof taskProgress[taskId] === 'boolean') {
			taskProgress[taskId] = false;
		}
		emitTaskProgress();
	});
});

function emitTaskProgress() {
	const tasks = Object.values(taskProgress);
	const completed = tasks.filter(task => task).length;
	const total = completed / tasks.length;
	io.emit('progress', total);

	if (total === 1) {
		io.emit('play-win');
	}
}

server.listen(PORT, () => console.log(`Server listening on *:${PORT}`));
