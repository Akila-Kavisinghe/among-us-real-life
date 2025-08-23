import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Alert, Backdrop, Box, Card, CardContent, Checkbox, FormControlLabel, LinearProgress, List, ListItem, ListItemText, Stack, Typography, Dialog, DialogContent, IconButton, Tooltip, Button } from '@mui/material';
import MapIcon from '@mui/icons-material/Map';

export default function Player() {
  const [tasks, setTasks] = useState({});
  const [completed, setCompleted] = useState({});
  const [progress, setProgress] = useState(0);
  const [role, setRole] = useState('');
  const [authId, setAuthId] = useState('');
  const audioRef = useRef(null);
  const socketRef = useRef(null);
  const [meeting, setMeeting] = useState(false);
  const [gameActive, setGameActive] = useState(false);
  const [isImpostor, setIsImpostor] = useState(false);
  const [killCooldownRemainingMs, setKillCooldownRemainingMs] = useState(0);
  const [mapOpen, setMapOpen] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [sabotageEndMs, setSabotageEndMs] = useState(0);
  const isSabotageActive = sabotageEndMs > Date.now();

  useEffect(() => {
    // Generate or load a per-tab auth token (so multiple tabs == multiple players)
    const params = new URLSearchParams(window.location.search);
    const forceNew = params.get('forceNewAuth') === '1';
    const urlAuth = params.get('auth');
    let auth = (!forceNew && sessionStorage.getItem('auth')) || urlAuth || '';
    if (!auth) {
      auth = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('auth', auth);
    } else if (forceNew) {
      auth = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('auth', auth);
    } else if (!sessionStorage.getItem('auth')) {
      sessionStorage.setItem('auth', auth);
    }
    const socket = io({ query: { role: 'PLAYER', auth } });
    console.log('[client] connect with auth', auth);
    setAuthId(auth);
    socketRef.current = socket;

    socket.on('tasks', (t) => { console.log('[client] tasks', t && Object.keys(t).length); setTasks(t || {}); });
    socket.on('progress', (p) => { console.log('[client] progress', p); setProgress(p || 0); });
    socket.on('tasks-completed', (m) => { console.log('[client] tasks-completed', m); setCompleted(m || {}); });
    socket.on('role', (r) => { console.log('[client] role', r); setRole(r || ''); setIsImpostor(r === 'Impostor'); });
    socket.on('play-meeting', async () => {
      await playSound('/sounds/meeting.mp3');
      await waitMs(2000);
      await playSound('/sounds/sussy-boy.mp3');
    });
    socket.on('meeting-started', () => { console.log('[client] meeting-started'); setMeeting(true); });
    socket.on('meeting-ended', () => { console.log('[client] meeting-ended'); setMeeting(false); });
    socket.on('game-started', () => { console.log('[client] game-started'); setGameActive(true); });
    socket.on('game-ended', () => { console.log('[client] game-ended'); setGameActive(false); setMeeting(false); setTasks({}); setProgress(0); });
    socket.on('state', (s) => { console.log('[client] state', s); setMeeting(!!s?.isMeeting); setGameActive(!!s?.isGameActive) });
    socket.on('sabotage-started', ({ endMs }) => {
      console.log('[client] sabotage-started', endMs);
      setSabotageEndMs(endMs || 0);
      playLoop('/sounds/sabotage.mp3', endMs);
    });
    socket.on('sabotage-ended', () => {
      console.log('[client] sabotage-ended');
      setSabotageEndMs(0);
      stopLoop();
    });
    socket.on('sabotage-usage', ({ used }) => {
      // Could disable button client-side; we'll compute from this
      if (used) setHasUsedSabotage(true);
    });
    socket.on('kill-cooldown-updated', ({ endMs }) => {
      const remaining = endMs - Date.now();
      setKillCooldownRemainingMs(Math.max(0, remaining));
    });
    socket.on('play-win', async () => {
      await playSound('/sounds/you-win.mp3');
    });

    // Ask server to rehydrate our identity/tasks if available
    console.log('[client] whoami', auth);
    socket.emit('whoami', { auth });

    return () => {
      socket.disconnect();
    };
  }, []);

  function toggleTask(taskId, checked) {
    const socket = socketRef.current;
    if (!socket) return;
    if (isImpostor) {
      // Local-only toggle for impostors (UI tracking, no server emit)
      setCompleted((prev) => {
        const next = { ...prev, [taskId]: !!checked };
        try {
          const key = `imp_completed_${authId || 'unknown'}`;
          const current = JSON.parse(sessionStorage.getItem(key) || '{}');
          current[taskId] = !!checked;
          sessionStorage.setItem(key, JSON.stringify(current));
        } catch (_) {}
        return next;
      });
      return;
    }
    socket.emit(checked ? 'task-complete' : 'task-incomplete', taskId);
  }

  async function waitMs(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async function playSound(url) {
    const el = audioRef.current;
    if (!el) return;
    // Ensure audio is user-unlocked on mobile before attempting playback
    if (!audioReady) {
      try {
        await enableAudio();
      } catch (_) {}
    }
    el.src = url;
    try {
      await el.play();
    } catch (_) {
      // Ignore; mobile may still block
    }
  }

  // Simple loop helper for sabotage alarm
  const loopRef = useRef(null);
  async function playLoop(url, endMs) {
    stopLoop();
    const el = audioRef.current;
    if (!el) return;
    if (!audioReady) {
      try { await enableAudio(); } catch (_) {}
    }
    const tick = async () => {
      if (Date.now() >= (endMs || 0)) { stopLoop(); return; }
      try {
        el.src = url;
        await el.play();
      } catch (_) {}
      loopRef.current = setTimeout(tick, (el.duration && !isNaN(el.duration) ? el.duration * 1000 : 1500));
    };
    tick();
  }
  function stopLoop() {
    if (loopRef.current) { clearTimeout(loopRef.current); loopRef.current = null; }
    try { const el = audioRef.current; if (el) { el.pause(); el.currentTime = 0; } } catch (_) {}
  }

  async function enableAudio() {
    const el = audioRef.current;
    if (!el) return;
    try {
      // Try to unlock by playing a short muted sound on a user gesture
      el.muted = true;
      el.playsInline = true;
      el.src = '/sounds/start.mp3';
      await el.play();
      el.pause();
      el.currentTime = 0;
      el.muted = false;
      setAudioReady(true);
    } catch (_) {
      // Some devices require explicit user action; a tap handler below retries
    }
  }

  // Players report by clicking the report image, not via keyboard

  const disableTasks = meeting || !gameActive;
  useEffect(() => {
    const i = setInterval(() => {
      setKillCooldownRemainingMs((prev) => {
        const next = prev - 1000;
        return next > 0 ? next : 0;
      });
    }, 1000);
    return () => clearInterval(i);
  }, []);

  // Add a one-time user-gesture handler to unlock audio on mobile
  useEffect(() => {
    function onFirstInteract() {
      if (!audioReady) {
        enableAudio();
      }
      window.removeEventListener('pointerdown', onFirstInteract);
      window.removeEventListener('touchend', onFirstInteract);
      window.removeEventListener('click', onFirstInteract);
    }
    window.addEventListener('pointerdown', onFirstInteract, { passive: true });
    window.addEventListener('touchend', onFirstInteract, { passive: true });
    window.addEventListener('click', onFirstInteract, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onFirstInteract);
      window.removeEventListener('touchend', onFirstInteract);
      window.removeEventListener('click', onFirstInteract);
    };
  }, [audioReady]);

  // Hydrate impostor local completion and merge on top of server map
  useEffect(() => {
    if (!authId || !isImpostor) return;
    try {
      const key = `imp_completed_${authId}`;
      const stored = JSON.parse(sessionStorage.getItem(key) || '{}');
      const merged = { ...completed };
      for (const tid of Object.keys(tasks || {})) {
        if (typeof stored[tid] === 'boolean') merged[tid] = stored[tid];
      }
      setCompleted(merged);
    } catch (_) {}
  }, [authId, isImpostor, tasks]);

  const hasTasks = Object.keys(tasks).length > 0;
  const [hasUsedSabotage, setHasUsedSabotage] = useState(false);

  if (!gameActive) {
    return (
      <Stack spacing={2} alignItems="center" sx={{ width: '100%' }}>
        <Typography variant="overline">Player ({authId || '...'})</Typography>
        <Card sx={{ width: '100%', maxWidth: 420 }}>
          <CardContent>
            <Typography variant="h5" align="center">GAME NOT STARTED</Typography>
          </CardContent>
        </Card>
        <Tooltip title="Open Map">
          <IconButton color="primary" onClick={() => setMapOpen(true)}>
            <MapIcon />
          </IconButton>
        </Tooltip>
        <Dialog open={mapOpen} onClose={() => setMapOpen(false)} maxWidth="lg">
          <DialogContent sx={{ p: 0 }}>
            <Box component="img" src="/images/MAP.JPG" alt="Map" sx={{ maxWidth: '90vw', maxHeight: '80vh', display: 'block' }} />
          </DialogContent>
        </Dialog>
      </Stack>
    );
  }

  if (gameActive && !hasTasks) {
    return (
      <Stack spacing={2} alignItems="center" sx={{ width: '100%' }}>
        <Typography variant="overline">Player ({authId || '...'})</Typography>
        <Card sx={{ width: '100%', maxWidth: 420 }}>
          <CardContent>
            <Typography variant="h5" align="center">A GAME IS IN PROGRESS</Typography>
            <Typography align="center">Please wait until the next round to join.</Typography>
          </CardContent>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack spacing={2} alignItems="center" sx={{ width: '100%' }}>
      <Typography variant="overline">Player ({authId || '...'})</Typography>
      <Stack direction="row" spacing={2} alignItems="center" justifyContent="center">
        <Box component="img" src="/images/report.png" alt="Report" sx={{ width: 140, cursor: 'pointer', borderRadius: 1 }} onClick={() => socketRef.current?.emit('report')} />
        {isImpostor && (
          <Box sx={{ position: 'relative', width: 140 }}>
            <Box component="img" src={killCooldownRemainingMs > 0 ? '/images/kill-cooldown.png' : '/images/kill.png'} alt="Kill" sx={{ width: '100%', cursor: killCooldownRemainingMs > 0 ? 'not-allowed' : 'pointer', borderRadius: 1 }} onClick={() => { if (killCooldownRemainingMs <= 0) socketRef.current?.emit('kill'); }} />
            {killCooldownRemainingMs > 0 && (
              <Box sx={{ position: 'absolute', bottom: 6, right: 6, bgcolor: 'rgba(0,0,0,0.85)', color: '#fff', px: 1, py: 0.25, borderRadius: '12px', fontSize: 14, fontWeight: 700 }}>
                {Math.ceil(killCooldownRemainingMs / 1000)}s
              </Box>
            )}
          </Box>
        )}
        <Tooltip title="Open Map">
          <IconButton color="primary" onClick={() => setMapOpen(true)}>
            <MapIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      {isImpostor && (
        <Button variant="contained" color="error" disabled={hasUsedSabotage || isSabotageActive || !gameActive || meeting} onClick={() => socketRef.current?.emit('sabotage')}>
          Sabotage
        </Button>
      )}

      {role ? (
        <Alert severity="info">
          You are {role === 'Impostor' ? 'an' : 'a'} {role}.
        </Alert>
      ) : null}

      <Card sx={{ width: '100%', maxWidth: 420, textAlign: 'left' }}>
        <CardContent>
          <Typography gutterBottom>Progress</Typography>
          <Box display="flex" alignItems="center" gap={2}>
            <Box flexGrow={1}>
              <LinearProgress variant="determinate" value={progress * 100} />
            </Box>
            <Typography variant="body2">{(progress * 100).toFixed(0)}%</Typography>
          </Box>
        </CardContent>
      </Card>

      <Card sx={{ width: '100%', maxWidth: 420, textAlign: 'left' }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Tasks</Typography>
          <List>
            {Object.entries(tasks).map(([taskId, label]) => (
              <ListItem key={taskId} disableGutters>
                <FormControlLabel control={<Checkbox disabled={disableTasks} checked={!!completed[taskId]} onChange={(e) => toggleTask(taskId, e.target.checked)} />} label={<ListItemText primary={label} />} />
              </ListItem>
            ))}
          </List>
        </CardContent>
      </Card>

      <audio ref={audioRef} preload="auto" playsInline />

      <Backdrop open={meeting} sx={{ color: '#fff', zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Typography variant="h4" align="center">COME BACK FOR A MEETING</Typography>
      </Backdrop>

      <Dialog open={mapOpen} onClose={() => setMapOpen(false)} maxWidth="lg">
        <DialogContent sx={{ p: 0 }}>
          <Box component="img" src="/images/MAP.JPG" alt="Map" sx={{ maxWidth: '90vw', maxHeight: '80vh', display: 'block' }} />
        </DialogContent>
      </Dialog>
    </Stack>
  );
}


