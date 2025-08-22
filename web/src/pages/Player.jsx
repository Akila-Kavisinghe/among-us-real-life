import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Alert, Backdrop, Box, Card, CardContent, Checkbox, FormControlLabel, LinearProgress, List, ListItem, ListItemText, Stack, Typography, Dialog, DialogContent, IconButton, Tooltip } from '@mui/material';
import MapIcon from '@mui/icons-material/Map';

export default function Player() {
  const [tasks, setTasks] = useState({});
  const [progress, setProgress] = useState(0);
  const [role, setRole] = useState('');
  const audioRef = useRef(null);
  const socketRef = useRef(null);
  const [meeting, setMeeting] = useState(false);
  const [gameActive, setGameActive] = useState(false);
  const [isImpostor, setIsImpostor] = useState(false);
  const [killCooldownRemainingMs, setKillCooldownRemainingMs] = useState(0);
  const [mapOpen, setMapOpen] = useState(false);

  useEffect(() => {
    const socket = io({ query: { role: 'PLAYER' } });
    socketRef.current = socket;

    socket.on('tasks', (t) => setTasks(t || {}));
    socket.on('progress', (p) => setProgress(p || 0));
    socket.on('role', (r) => { setRole(r || ''); setIsImpostor(r === 'Impostor'); });
    socket.on('play-meeting', async () => {
      await playSound('/sounds/meeting.mp3');
      await waitMs(2000);
      await playSound('/sounds/sussy-boy.mp3');
    });
    socket.on('meeting-started', () => setMeeting(true));
    socket.on('meeting-ended', () => setMeeting(false));
    socket.on('game-started', () => setGameActive(true));
    socket.on('game-ended', () => { setGameActive(false); setMeeting(false); setTasks({}); setProgress(0); });
    socket.on('state', (s) => { setMeeting(!!s?.isMeeting); setGameActive(!!s?.isGameActive) });
    socket.on('kill-cooldown-updated', ({ endMs }) => {
      const remaining = endMs - Date.now();
      setKillCooldownRemainingMs(Math.max(0, remaining));
    });
    socket.on('play-win', async () => {
      await playSound('/sounds/you-win.mp3');
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  function toggleTask(taskId, checked) {
    const socket = socketRef.current;
    if (!socket) return;
    socket.emit(checked ? 'task-complete' : 'task-incomplete', taskId);
  }

  async function waitMs(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async function playSound(url) {
    const el = audioRef.current;
    if (!el) return;
    el.src = url;
    try {
      await el.play();
    } catch (_) {}
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

  const hasTasks = Object.keys(tasks).length > 0;

  if (!gameActive) {
    return (
      <Stack spacing={2} alignItems="center" sx={{ width: '100%' }}>
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
                <FormControlLabel control={<Checkbox disabled={disableTasks} onChange={(e) => toggleTask(taskId, e.target.checked)} />} label={<ListItemText primary={label} />} />
              </ListItem>
            ))}
          </List>
        </CardContent>
      </Card>

      <audio ref={audioRef} />

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


