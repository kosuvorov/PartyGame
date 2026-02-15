const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const triviaQuestions = require('./questions.json');
const aboutYouQuestions = require('./questions-aboutyou.json');

// ── Bootstrap ────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ── Data structures ──────────────────────────────────────────────────
const rooms = new Map(); // roomCode → Room

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(hostSocketId) {
  const code = generateCode();
  const room = {
    code,
    hostId: hostSocketId,
    mode: 'classic',       // classic | fanfacts | aboutyou
    phase: 'lobby',        // lobby | collect-facts | writing | voting | reveal | aboutyou-vote | aboutyou-reveal | gameover
    players: new Map(),
    round: 0,
    totalRounds: 8,
    questions: [],
    currentQuestion: null,
    options: [],
    votes: new Map(),
    truthIndex: -1,
    // Fan Facts
    fanFacts: new Map(),        // socketId → { fact, used }
    currentFactOwnerId: null,
    // About You
    aboutYouTarget: null,       // the player name being asked about
  };
  rooms.set(code, room);
  return room;
}

// ── Helpers ──────────────────────────────────────────────────────────
function normalize(str) {
  return str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const avatarColors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#FF8C42', '#98D8C8'];

function getPlayers(room) {
  const players = [];
  room.players.forEach((p, id) => {
    players.push({ id, name: p.name, score: p.score, avatar: p.avatar });
  });
  return players;
}

function broadcastState(room) {
  const players = getPlayers(room);
  const base = {
    phase: room.phase,
    code: room.code,
    mode: room.mode,
    players,
    round: room.round,
    totalRounds: room.totalRounds,
  };

  // ── TV data ──────────────────────────────
  let tvData = { ...base };
  switch (room.phase) {
    case 'lobby':
      tvData.message = 'Waiting for players…';
      break;

    case 'collect-facts': {
      const submitted = [];
      room.fanFacts.forEach((f, id) => {
        const p = room.players.get(id);
        if (p) submitted.push(p.name);
      });
      tvData.submitted = submitted;
      tvData.total = room.players.size;
      break;
    }

    case 'writing': {
      const submitted = [];
      room.players.forEach(p => { if (p.lie !== null) submitted.push(p.name); });
      tvData.prompt = room.currentQuestion.prompt;
      tvData.submitted = submitted;
      tvData.total = room.mode === 'fanfacts'
        ? Array.from(room.players.values()).filter(p => p.name !== room.currentQuestion.ownerName).length
        : room.players.size;
      if (room.mode === 'fanfacts') tvData.factOwner = room.currentQuestion.ownerName;
      break;
    }

    case 'voting':
      tvData.prompt = room.currentQuestion.prompt;
      tvData.options = room.options.map(o => o.text);
      if (room.mode === 'fanfacts') tvData.factOwner = room.currentQuestion.ownerName;
      break;

    case 'reveal': {
      tvData.prompt = room.currentQuestion.prompt;
      tvData.results = buildRevealResults(room);
      tvData.truthIndex = room.truthIndex;
      if (room.mode === 'fanfacts') tvData.factOwner = room.currentQuestion.ownerName;
      break;
    }

    case 'aboutyou-vote': {
      tvData.prompt = room.currentQuestion.prompt;
      tvData.options = players.map(p => p.name);
      break;
    }

    case 'aboutyou-reveal': {
      tvData.prompt = room.currentQuestion.prompt;
      const voteCounts = {};
      players.forEach(p => { voteCounts[p.name] = 0; });
      room.votes.forEach((voterIds, targetName) => {
        voteCounts[targetName] = (voteCounts[targetName] || 0) + voterIds.length;
      });
      tvData.voteCounts = voteCounts;
      break;
    }

    case 'gameover':
      tvData.message = 'Game Over!';
      break;
  }

  io.to(room.hostId).emit('state-update', tvData);

  // ── Controller data (personalized) ──────
  room.players.forEach((player, socketId) => {
    let cd = { ...base, you: player.name, yourScore: player.score };

    switch (room.phase) {
      case 'collect-facts':
        cd.submitted = room.fanFacts.has(socketId);
        break;

      case 'writing':
        cd.prompt = room.currentQuestion.prompt;
        cd.submitted = player.lie !== null;
        // In Fan Facts, the fact owner doesn't write
        if (room.mode === 'fanfacts' && socketId === room.currentFactOwnerId) {
          cd.isFactOwner = true;
          cd.submitted = true; // skip writing
        }
        break;

      case 'voting':
        cd.prompt = room.currentQuestion.prompt;
        cd.options = room.options
          .map((o, i) => ({ text: o.text, index: i }))
          .filter(o => o.text !== player.lie);
        cd.voted = player.vote !== null;
        break;

      case 'reveal':
        cd.results = buildRevealResults(room);
        cd.truthIndex = room.truthIndex;
        cd.prompt = room.currentQuestion.prompt;
        break;

      case 'aboutyou-vote':
        cd.prompt = room.currentQuestion.prompt;
        cd.options = players.map(p => ({ text: p.name, index: p.name }));
        cd.voted = player.vote !== null;
        break;

      case 'aboutyou-reveal': {
        const voteCounts = {};
        players.forEach(p => { voteCounts[p.name] = 0; });
        room.votes.forEach((voterIds, targetName) => {
          voteCounts[targetName] = (voteCounts[targetName] || 0) + voterIds.length;
        });
        cd.voteCounts = voteCounts;
        cd.prompt = room.currentQuestion.prompt;
        break;
      }
    }

    io.to(socketId).emit('state-update', cd);
  });
}

function buildRevealResults(room) {
  return room.options.map((opt, idx) => ({
    text: opt.text,
    isTruth: idx === room.truthIndex,
    author: opt.author,
    voters: (room.votes.get(idx) || []).map(id => {
      const p = room.players.get(id);
      return p ? p.name : '?';
    }),
  }));
}

// ── Game logic ───────────────────────────────────────────────────────
function prepareQuestions(room) {
  if (room.mode === 'classic') {
    room.questions = [...triviaQuestions].sort(() => Math.random() - 0.5);
    room.totalRounds = Math.min(room.questions.length, 8);
  } else if (room.mode === 'fanfacts') {
    // questions built from collected facts
    const facts = [];
    room.fanFacts.forEach((f, id) => {
      const p = room.players.get(id);
      if (p) {
        facts.push({
          prompt: `Something that happened to ${p.name}: ____`,
          truth: f.fact,
          ownerId: id,
          ownerName: p.name,
        });
      }
    });
    room.questions = facts.sort(() => Math.random() - 0.5);
    room.totalRounds = room.questions.length;
  } else if (room.mode === 'aboutyou') {
    room.questions = [...aboutYouQuestions].sort(() => Math.random() - 0.5);
    room.totalRounds = Math.min(room.questions.length, 8);
  }
}

function startRound(room) {
  room.currentQuestion = room.questions[room.round];
  room.options = [];
  room.votes = new Map();
  room.truthIndex = -1;
  room.players.forEach(p => { p.lie = null; p.vote = null; });

  if (room.mode === 'aboutyou') {
    room.phase = 'aboutyou-vote';
  } else {
    room.phase = 'writing';
    if (room.mode === 'fanfacts') {
      room.currentFactOwnerId = room.currentQuestion.ownerId;
    }
  }
  broadcastState(room);
}

function buildVotingOptions(room) {
  const opts = [];
  room.players.forEach((p, id) => {
    if (p.lie) opts.push({ text: p.lie, author: p.name, authorId: id });
  });
  opts.push({ text: room.currentQuestion.truth, author: '✦ TRUTH', authorId: null });
  // shuffle
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  room.options = opts;
  room.truthIndex = opts.findIndex(o => o.authorId === null);
}

function calculateScoresForRound(room) {
  // +1000 for guessing the truth
  room.votes.forEach((voterIds, optIdx) => {
    if (optIdx === room.truthIndex) {
      voterIds.forEach(id => {
        const p = room.players.get(id);
        if (p) p.score += 1000;
      });
    }
  });
  // +500 for each player fooled by your lie
  room.options.forEach((opt, idx) => {
    if (opt.authorId && idx !== room.truthIndex) {
      const fooled = (room.votes.get(idx) || []).length;
      const author = room.players.get(opt.authorId);
      if (author) author.score += fooled * 500;
    }
  });
}

function calculateAboutYouScores(room) {
  // Find the most-voted answer — everyone who picked it gets 500 pts (consensus bonus)
  let maxVotes = 0;
  let topAnswer = null;
  room.votes.forEach((voterIds, targetName) => {
    if (voterIds.length > maxVotes) { maxVotes = voterIds.length; topAnswer = targetName; }
  });
  if (topAnswer && maxVotes > 1) {
    const voterIds = room.votes.get(topAnswer) || [];
    voterIds.forEach(id => {
      const p = room.players.get(id);
      if (p) p.score += 500;
    });
  }
}

// ── Socket.io ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', () => {
    const room = createRoom(socket.id);
    currentRoom = room.code;
    socket.join(room.code);
    broadcastState(room);
  });

  socket.on('join-room', ({ code, name }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error-msg', 'Room not found.');
    if (room.phase !== 'lobby') return socket.emit('error-msg', 'Game already in progress.');
    if (room.players.size >= 8) return socket.emit('error-msg', 'Room is full (max 8).');

    let taken = false;
    room.players.forEach(p => { if (p.name.toLowerCase() === name.trim().toLowerCase()) taken = true; });
    if (taken) return socket.emit('error-msg', 'That name is taken.');

    room.players.set(socket.id, {
      name: name.trim(),
      score: 0,
      lie: null,
      vote: null,
      avatar: avatarColors[room.players.size % avatarColors.length],
    });
    currentRoom = roomCode;
    socket.join(roomCode);
    socket.emit('joined', { code: roomCode, name: name.trim() });
    broadcastState(room);
  });

  socket.on('set-mode', ({ mode }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (['classic', 'fanfacts', 'aboutyou'].includes(mode)) {
      room.mode = mode;
      broadcastState(room);
    }
  });

  socket.on('start-game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 2) return socket.emit('error-msg', 'Need at least 2 players.');

    if (room.mode === 'fanfacts') {
      room.phase = 'collect-facts';
      room.fanFacts = new Map();
      broadcastState(room);
    } else {
      prepareQuestions(room);
      room.round = 0;
      startRound(room);
    }
  });

  socket.on('submit-fact', ({ text }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'collect-facts') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const cleaned = (text || '').trim();
    if (!cleaned) return socket.emit('error-msg', 'Cannot be empty.');
    if (room.fanFacts.has(socket.id)) return socket.emit('error-msg', 'Already submitted.');

    room.fanFacts.set(socket.id, { fact: cleaned });
    broadcastState(room);

    // check if all submitted
    let allDone = true;
    room.players.forEach((p, id) => { if (!room.fanFacts.has(id)) allDone = false; });
    if (allDone) {
      prepareQuestions(room);
      room.round = 0;
      startRound(room);
    }
  });

  socket.on('submit-lie', ({ text }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'writing') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.lie !== null) return socket.emit('error-msg', 'Already submitted.');
    // In Fan Facts, the fact owner doesn't write
    if (room.mode === 'fanfacts' && socket.id === room.currentFactOwnerId) return;

    const cleaned = (text || '').trim();
    if (!cleaned) return socket.emit('error-msg', 'Cannot be empty.');
    if (normalize(cleaned) === normalize(room.currentQuestion.truth)) {
      return socket.emit('error-msg', "That's the actual truth! Try to lie. 🤥");
    }
    let duplicate = false;
    room.players.forEach(p => {
      if (p.lie && normalize(p.lie) === normalize(cleaned)) duplicate = true;
    });
    if (duplicate) return socket.emit('error-msg', 'Someone already submitted that. Try something else!');

    player.lie = cleaned;
    broadcastState(room);

    // check if all submitted (excluding fact owner in fanfacts mode)
    let allSubmitted = true;
    room.players.forEach((p, id) => {
      if (room.mode === 'fanfacts' && id === room.currentFactOwnerId) return;
      if (p.lie === null) allSubmitted = false;
    });
    if (allSubmitted) {
      buildVotingOptions(room);
      room.phase = 'voting';
      broadcastState(room);
    }
  });

  socket.on('submit-vote', ({ optionIndex }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.vote !== null) return socket.emit('error-msg', 'Already voted.');

    if (room.phase === 'voting') {
      const opt = room.options[optionIndex];
      if (opt && opt.authorId === socket.id) return socket.emit('error-msg', "You can't vote for your own lie!");
      player.vote = optionIndex;
      if (!room.votes.has(optionIndex)) room.votes.set(optionIndex, []);
      room.votes.get(optionIndex).push(socket.id);
      broadcastState(room);

      let allVoted = true;
      room.players.forEach(p => { if (p.vote === null) allVoted = false; });
      if (allVoted) {
        calculateScoresForRound(room);
        room.phase = 'reveal';
        broadcastState(room);
      }
    } else if (room.phase === 'aboutyou-vote') {
      // optionIndex is actually the player name
      const targetName = optionIndex;
      player.vote = targetName;
      if (!room.votes.has(targetName)) room.votes.set(targetName, []);
      room.votes.get(targetName).push(socket.id);
      broadcastState(room);

      let allVoted = true;
      room.players.forEach(p => { if (p.vote === null) allVoted = false; });
      if (allVoted) {
        calculateAboutYouScores(room);
        room.phase = 'aboutyou-reveal';
        broadcastState(room);
      }
    }
  });

  socket.on('next-round', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;

    room.round++;
    if (room.round >= room.totalRounds) {
      room.phase = 'gameover';
      broadcastState(room);
    } else {
      startRound(room);
    }
  });

  socket.on('restart-game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.round = 0;
    room.phase = 'lobby';
    room.fanFacts = new Map();
    room.players.forEach(p => { p.score = 0; p.lie = null; p.vote = null; });
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (socket.id === room.hostId) {
      io.to(currentRoom).emit('error-msg', 'The host has disconnected. Game ended.');
      rooms.delete(currentRoom);
    } else {
      room.players.delete(socket.id);
      if (room.players.size === 0 && room.phase !== 'lobby') {
        rooms.delete(currentRoom);
      } else {
        broadcastState(room);
      }
    }
  });
});

// ── Start ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎉 Party Game server running at http://localhost:${PORT}\n`);
});
