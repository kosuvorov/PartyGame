const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const triviaQuestions = require('./questions.json');
const aboutYouQuestions = require('./questions-aboutyou.json');
const eayPrompts = require('./questions-eay.json');

// ── Bootstrap ────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ── Data structures ──────────────────────────────────────────────────
const rooms = new Map();          // roomCode → Room
const tokenToRoom = new Map();    // playerToken → { roomCode, socketId }

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function generateToken() {
  return crypto.randomBytes(12).toString('hex');
}

const avatarColors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#FF8C42', '#98D8C8'];

function createRoom(hostSocketId) {
  const code = generateCode();
  const room = {
    code,
    hostId: hostSocketId,
    mode: 'classic',
    // Phases: lobby | collect-eay | category-select | writing | voting | reveal
    //         | aboutyou-vote | aboutyou-reveal | gameover
    phase: 'lobby',
    players: new Map(),       // socketId → PlayerData
    playerOrder: [],          // array of socketIds for captain rotation
    captainIndex: 0,          // who picks category this round
    round: 0,
    totalRounds: 8,
    questions: [],
    questionPool: [],         // unused questions grouped by category
    currentQuestion: null,
    categoryChoices: [],      // 3 categories to choose from
    options: [],
    votes: new Map(),
    truthIndex: -1,
    isFinalRound: false,
    scoreMultiplier: 1,
    // EAY (Enough About You)
    eayAnswers: new Map(),            // socketId → { answer }
    eayPromptAssignments: new Map(),  // socketId → prompt string
    currentSubjectId: null,
  };
  rooms.set(code, room);
  return room;
}

// ── Helpers ──────────────────────────────────────────────────────────
function normalize(str) {
  return str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getPlayers(room) {
  const players = [];
  // Use playerOrder for stable, consistent ordering
  room.playerOrder.forEach(id => {
    const p = room.players.get(id);
    if (p) players.push({ id, name: p.name, score: p.score, avatar: p.avatar, connected: p.connected });
  });
  return players;
}

function getCaptainName(room) {
  if (room.playerOrder.length === 0) return null;
  const captainId = room.playerOrder[room.captainIndex % room.playerOrder.length];
  const captain = room.players.get(captainId);
  return captain ? captain.name : null;
}

// ── Category logic (Classic) ─────────────────────────────────────────
function buildQuestionPool(room) {
  const shuffled = [...triviaQuestions].sort(() => Math.random() - 0.5);
  const pool = {};
  shuffled.forEach(q => {
    if (!pool[q.category]) pool[q.category] = [];
    pool[q.category].push(q);
  });
  room.questionPool = pool;
}

function pickCategoryChoices(room) {
  const available = Object.keys(room.questionPool).filter(cat => room.questionPool[cat].length > 0);
  const shuffled = available.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(3, shuffled.length));
}

function pickQuestionFromCategory(room, category) {
  const pool = room.questionPool[category];
  if (!pool || pool.length === 0) return null;
  return pool.shift();
}

// ── EAY logic ────────────────────────────────────────────────────────
function assignEAYPrompts(room) {
  const shuffled = [...eayPrompts].sort(() => Math.random() - 0.5);
  let i = 0;
  room.playerOrder.forEach(sid => {
    const p = room.players.get(sid);
    if (p) {
      // personalise the prompt template with this player's name
      const template = shuffled[i % shuffled.length];
      const personalPrompt = template.replace(/\{PLAYER\}/g, p.name.toUpperCase());
      room.eayPromptAssignments.set(sid, { template, personalPrompt });
      i++;
    }
  });
}

// ── Broadcast ────────────────────────────────────────────────────────
function broadcastState(room) {
  const players = getPlayers(room);
  const base = {
    phase: room.phase,
    code: room.code,
    mode: room.mode,
    players,
    round: room.round,
    totalRounds: room.totalRounds,
    isFinalRound: room.isFinalRound,
  };

  let tvData = { ...base };

  switch (room.phase) {
    case 'lobby':
      tvData.message = 'Waiting for players…';
      break;

    case 'collect-eay': {
      const submitted = [];
      room.eayAnswers.forEach((a, id) => {
        const p = room.players.get(id);
        if (p) submitted.push(p.name);
      });
      tvData.submitted = submitted;
      tvData.total = room.players.size;
      break;
    }

    case 'category-select':
      tvData.categories = room.categoryChoices;
      tvData.captainName = getCaptainName(room);
      break;

    case 'writing': {
      const submitted = [];
      room.players.forEach(p => { if (p.lie !== null) submitted.push(p.name); });
      tvData.prompt = room.currentQuestion.prompt;
      tvData.category = room.currentQuestion.category;
      tvData.submitted = submitted;
      if (room.mode === 'eay') {
        const subject = room.players.get(room.currentSubjectId);
        tvData.subjectName = subject ? subject.name : '???';
        tvData.total = room.players.size - 1; // subject doesn't write
      } else {
        tvData.total = room.players.size;
      }
      break;
    }

    case 'voting':
      tvData.prompt = room.currentQuestion.prompt;
      tvData.category = room.currentQuestion.category;
      tvData.options = room.options.map(o => o.text);
      if (room.mode === 'eay') {
        const subject = room.players.get(room.currentSubjectId);
        tvData.subjectName = subject ? subject.name : '???';
      }
      break;

    case 'reveal':
      tvData.prompt = room.currentQuestion.prompt;
      tvData.category = room.currentQuestion.category;
      tvData.results = buildRevealResults(room);
      tvData.truthIndex = room.truthIndex;
      if (room.mode === 'eay') {
        const subject = room.players.get(room.currentSubjectId);
        tvData.subjectName = subject ? subject.name : '???';
        // count how many guessed the truth (for reputation bonus display)
        const correctCount = (room.votes.get(room.truthIndex) || []).length;
        tvData.reputationBonus = correctCount * 1000;
      }
      break;

    case 'aboutyou-vote':
      tvData.prompt = room.currentQuestion.prompt;
      tvData.options = players.map(p => p.name);
      break;

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

  // ── Per-player controller data ──
  room.players.forEach((player, socketId) => {
    if (!player.connected) return;
    let cd = { ...base, you: player.name, yourScore: player.score };
    const isCaptain = room.playerOrder.length > 0 &&
      room.playerOrder[room.captainIndex % room.playerOrder.length] === socketId;

    switch (room.phase) {
      case 'collect-eay': {
        cd.submitted = room.eayAnswers.has(socketId);
        // send THIS player's personal prompt
        const assignment = room.eayPromptAssignments.get(socketId);
        if (assignment) {
          // For the answering phase, show the prompt with "you" instead of their name
          cd.eayPrompt = assignment.template.replace(/\{PLAYER\}/g, 'you');
        }
        break;
      }

      case 'category-select':
        cd.isCaptain = isCaptain;
        cd.categories = isCaptain ? room.categoryChoices : [];
        cd.captainName = getCaptainName(room);
        break;

      case 'writing':
        cd.prompt = room.currentQuestion.prompt;
        cd.category = room.currentQuestion.category;
        cd.submitted = player.lie !== null;
        if (room.mode === 'eay' && player.name === room.currentQuestion.subjectName) {
          cd.isSubject = true;
          cd.submitted = true;
        }
        break;

      case 'voting': {
        cd.prompt = room.currentQuestion.prompt;
        // Subject doesn't vote in EAY mode
        if (room.mode === 'eay' && player.name === room.currentQuestion.subjectName) {
          cd.isSubject = true;
          cd.voted = true; // they don't vote
        } else {
          cd.options = room.options
            .map((o, i) => ({ text: o.text, index: i }))
            .filter(o => o.text !== player.lie);
          cd.voted = player.vote !== null;
        }
        break;
      }

      case 'reveal':
        cd.results = buildRevealResults(room);
        cd.truthIndex = room.truthIndex;
        cd.prompt = room.currentQuestion.prompt;
        if (room.mode === 'eay' && player.name === room.currentQuestion.subjectName) {
          cd.isSubject = true;
          const correctCount = (room.votes.get(room.truthIndex) || []).length;
          cd.reputationBonus = correctCount * 1000;
        }
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
    isLieForMe: opt.isLieForMe || false,
    voters: (room.votes.get(idx) || []).map(id => {
      const p = room.players.get(id);
      return p ? p.name : '?';
    }),
  }));
}

// ── Game logic ───────────────────────────────────────────────────────
function prepareQuestions(room) {
  if (room.mode === 'classic') {
    buildQuestionPool(room);
    room.totalRounds = 8;
  } else if (room.mode === 'eay') {
    // build one round per player, using assigned prompts + answers
    const questions = [];
    room.playerOrder.forEach(sid => {
      const p = room.players.get(sid);
      const assignment = room.eayPromptAssignments.get(sid);
      const answer = room.eayAnswers.get(sid);
      if (p && assignment && answer) {
        questions.push({
          prompt: assignment.personalPrompt,
          truth: answer.answer,
          subjectId: sid,
          subjectName: p.name,
          category: 'Enough About You',
          decoys: [],
        });
      }
    });
    room.questions = questions.sort(() => Math.random() - 0.5);
    room.totalRounds = room.questions.length;
  } else if (room.mode === 'aboutyou') {
    room.questions = [...aboutYouQuestions].sort(() => Math.random() - 0.5);
    room.totalRounds = Math.min(room.questions.length, 8);
  }
}

function startRound(room) {
  room.options = [];
  room.votes = new Map();
  room.truthIndex = -1;
  room.players.forEach(p => { p.lie = null; p.vote = null; p.usedLieForMe = false; });

  // Final round check (last round = triple points) — Classic only
  room.isFinalRound = (room.round === room.totalRounds - 1) && room.mode === 'classic';
  room.scoreMultiplier = room.isFinalRound ? 3 : 1;

  if (room.mode === 'aboutyou') {
    room.currentQuestion = room.questions[room.round];
    room.phase = 'aboutyou-vote';
    broadcastState(room);
  } else if (room.mode === 'eay') {
    room.currentQuestion = room.questions[room.round];
    room.currentSubjectId = room.currentQuestion.subjectId;
    // Subject already has the truth, mark their vote as done
    const subject = room.players.get(room.currentSubjectId);
    if (subject) subject.vote = '__SUBJECT__'; // sentinel value
    room.phase = 'writing';
    broadcastState(room);
  } else {
    // Classic: captain picks a category
    room.categoryChoices = pickCategoryChoices(room);
    if (room.categoryChoices.length === 0) {
      room.phase = 'gameover';
      broadcastState(room);
      return;
    }
    room.phase = 'category-select';
    broadcastState(room);
  }
}

function beginWritingPhase(room, question) {
  room.currentQuestion = question;
  room.phase = 'writing';
  broadcastState(room);
}

function buildVotingOptions(room) {
  const opts = [];
  room.players.forEach((p, id) => {
    if (p.lie) opts.push({ text: p.lie, author: p.name, authorId: id, isLieForMe: p.usedLieForMe });
  });
  opts.push({ text: room.currentQuestion.truth, author: '✦ TRUTH', authorId: null });
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  room.options = opts;
  room.truthIndex = opts.findIndex(o => o.authorId === null);
}

function calculateScoresForRound(room) {
  const m = room.scoreMultiplier;
  // +1000 for guessing truth
  room.votes.forEach((voterIds, optIdx) => {
    if (optIdx === room.truthIndex) {
      voterIds.forEach(id => {
        const p = room.players.get(id);
        if (p) p.score += 1000 * m;
      });
    }
  });
  // +500 for each player fooled (half if "Lie for Me" was used)
  room.options.forEach((opt, idx) => {
    if (opt.authorId && idx !== room.truthIndex) {
      const fooled = (room.votes.get(idx) || []).length;
      const author = room.players.get(opt.authorId);
      if (author) {
        const points = opt.isLieForMe ? 250 : 500;
        author.score += fooled * points * m;
      }
    }
  });
  // EAY Reputation Bonus: Subject gets +1000 for each person who guessed their truth
  if (room.mode === 'eay' && room.currentSubjectId) {
    const correctVoters = room.votes.get(room.truthIndex) || [];
    const subject = room.players.get(room.currentSubjectId);
    if (subject) {
      subject.score += correctVoters.length * 1000;
    }
  }
}

function calculateAboutYouScores(room) {
  let maxVotes = 0;
  let topAnswer = null;
  room.votes.forEach((voterIds, targetName) => {
    if (voterIds.length > maxVotes) { maxVotes = voterIds.length; topAnswer = targetName; }
  });
  if (topAnswer && maxVotes > 1) {
    (room.votes.get(topAnswer) || []).forEach(id => {
      const p = room.players.get(id);
      if (p) p.score += 500;
    });
  }
}

function checkAllSubmitted(room) {
  let allSubmitted = true;
  room.players.forEach((p, id) => {
    if (room.mode === 'eay' && p.name === room.currentQuestion.subjectName) return;
    if (p.lie === null) allSubmitted = false;
  });
  return allSubmitted;
}

function checkAllVoted(room) {
  let allVoted = true;
  room.players.forEach(p => { if (p.vote === null) allVoted = false; });
  return allVoted;
}

// ── Socket.io ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;

  // ── CREATE ROOM ──────────────────────────────────
  socket.on('create-room', () => {
    const room = createRoom(socket.id);
    currentRoom = room.code;
    socket.join(room.code);
    broadcastState(room);
  });

  // ── JOIN ROOM ────────────────────────────────────
  socket.on('join-room', ({ code, name, token }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error-msg', 'Room not found.');

    // ── Reconnection with token ──
    if (token) {
      const existing = tokenToRoom.get(token);
      if (existing && existing.roomCode === roomCode) {
        const oldId = existing.socketId;
        const player = room.players.get(oldId);
        if (player) {
          room.players.delete(oldId);
          room.players.set(socket.id, player);
          player.connected = true;
          const orderIdx = room.playerOrder.indexOf(oldId);
          if (orderIdx !== -1) room.playerOrder[orderIdx] = socket.id;

          // migrate EAY data
          if (room.eayPromptAssignments.has(oldId)) {
            room.eayPromptAssignments.set(socket.id, room.eayPromptAssignments.get(oldId));
            room.eayPromptAssignments.delete(oldId);
          }
          if (room.eayAnswers.has(oldId)) {
            room.eayAnswers.set(socket.id, room.eayAnswers.get(oldId));
            room.eayAnswers.delete(oldId);
          }
          if (room.currentSubjectId === oldId) room.currentSubjectId = socket.id;

          existing.socketId = socket.id;

          currentRoom = roomCode;
          socket.join(roomCode);
          socket.emit('joined', { code: roomCode, name: player.name, token });
          broadcastState(room);
          return;
        }
      }
    }

    // ── Fresh join ──
    if (room.phase !== 'lobby') return socket.emit('error-msg', 'Game already in progress.');
    if (room.players.size >= 8) return socket.emit('error-msg', 'Room is full (max 8).');

    let taken = false;
    room.players.forEach(p => { if (p.name.toLowerCase() === name.trim().toLowerCase()) taken = true; });
    if (taken) return socket.emit('error-msg', 'That name is taken.');

    const playerToken = generateToken();
    room.players.set(socket.id, {
      name: name.trim(),
      score: 0,
      lie: null,
      vote: null,
      avatar: avatarColors[room.players.size % avatarColors.length],
      connected: true,
      usedLieForMe: false,
      token: playerToken,
    });
    room.playerOrder.push(socket.id);

    tokenToRoom.set(playerToken, { roomCode, socketId: socket.id });

    currentRoom = roomCode;
    socket.join(roomCode);
    socket.emit('joined', { code: roomCode, name: name.trim(), token: playerToken });
    broadcastState(room);
  });

  // ── SET MODE ─────────────────────────────────────
  socket.on('set-mode', ({ mode }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (['classic', 'eay', 'aboutyou'].includes(mode)) {
      room.mode = mode;
      broadcastState(room);
    }
  });

  // ── START GAME ───────────────────────────────────
  socket.on('start-game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 2) return socket.emit('error-msg', 'Need at least 2 players.');

    room.captainIndex = 0;

    if (room.mode === 'eay') {
      room.eayAnswers = new Map();
      room.eayPromptAssignments = new Map();
      assignEAYPrompts(room);
      room.phase = 'collect-eay';
      broadcastState(room);
    } else {
      prepareQuestions(room);
      room.round = 0;
      startRound(room);
    }
  });

  // ── SELECT CATEGORY (Captain) ────────────────────
  socket.on('select-category', ({ category }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'category-select') return;
    const captainId = room.playerOrder[room.captainIndex % room.playerOrder.length];
    if (socket.id !== captainId) return socket.emit('error-msg', "It's not your turn to pick!");

    const question = pickQuestionFromCategory(room, category);
    if (!question) return socket.emit('error-msg', 'No questions left in that category.');

    room.captainIndex++;
    beginWritingPhase(room, question);
  });

  // ── SUBMIT EAY ANSWER (honest answer) ────────────
  socket.on('submit-eay-answer', ({ text }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'collect-eay') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const cleaned = (text || '').trim();
    if (!cleaned) return socket.emit('error-msg', 'Cannot be empty.');
    if (room.eayAnswers.has(socket.id)) return socket.emit('error-msg', 'Already submitted.');

    room.eayAnswers.set(socket.id, { answer: cleaned });
    broadcastState(room);

    // check if all players have answered
    let allDone = true;
    room.players.forEach((p, id) => { if (!room.eayAnswers.has(id)) allDone = false; });
    if (allDone) {
      prepareQuestions(room);
      room.round = 0;
      startRound(room);
    }
  });

  // ── SUBMIT LIE ───────────────────────────────────
  socket.on('submit-lie', ({ text }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'writing') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.lie !== null) return socket.emit('error-msg', 'Already submitted.');
    if (room.mode === 'eay' && player.name === room.currentQuestion.subjectName) return;

    const cleaned = (text || '').trim();
    if (!cleaned) return socket.emit('error-msg', 'Cannot be empty.');
    if (normalize(cleaned) === normalize(room.currentQuestion.truth)) {
      return socket.emit('error-msg', "That's the actual truth! Try to lie. 🤥");
    }
    let duplicate = false;
    room.players.forEach(p => {
      if (p.lie && normalize(p.lie) === normalize(cleaned)) duplicate = true;
    });
    if (duplicate) return socket.emit('error-msg', 'Someone already submitted that!');

    player.lie = cleaned;
    broadcastState(room);

    if (checkAllSubmitted(room)) {
      buildVotingOptions(room);
      room.phase = 'voting';
      broadcastState(room);
    }
  });

  // ── LIE FOR ME ───────────────────────────────────
  socket.on('lie-for-me', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'writing') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.lie !== null) return socket.emit('error-msg', 'Already submitted.');
    if (room.mode === 'eay' && player.name === room.currentQuestion.subjectName) return;

    const q = room.currentQuestion;
    const decoys = q.decoys || [];
    const usedLies = new Set();
    room.players.forEach(p => { if (p.lie) usedLies.add(normalize(p.lie)); });

    const available = decoys.filter(d => !usedLies.has(normalize(d)));
    if (available.length === 0) {
      return socket.emit('error-msg', 'No auto-lies available. Write your own!');
    }

    const picked = available[Math.floor(Math.random() * available.length)];
    player.lie = picked;
    player.usedLieForMe = true;
    broadcastState(room);

    if (checkAllSubmitted(room)) {
      buildVotingOptions(room);
      room.phase = 'voting';
      broadcastState(room);
    }
  });

  // ── SUBMIT VOTE ──────────────────────────────────
  socket.on('submit-vote', ({ optionIndex }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.vote !== null) return socket.emit('error-msg', 'Already voted.');

    if (room.phase === 'voting') {
      // Subject can't vote in EAY
      if (room.mode === 'eay' && player.name === room.currentQuestion.subjectName) return;

      const opt = room.options[optionIndex];
      if (opt && opt.authorId === socket.id) return socket.emit('error-msg', "You can't vote for your own lie!");
      player.vote = optionIndex;
      if (!room.votes.has(optionIndex)) room.votes.set(optionIndex, []);
      room.votes.get(optionIndex).push(socket.id);
      broadcastState(room);

      if (checkAllVoted(room)) {
        calculateScoresForRound(room);
        room.phase = 'reveal';
        broadcastState(room);
      }
    } else if (room.phase === 'aboutyou-vote') {
      const targetName = optionIndex;
      player.vote = targetName;
      if (!room.votes.has(targetName)) room.votes.set(targetName, []);
      room.votes.get(targetName).push(socket.id);
      broadcastState(room);

      if (checkAllVoted(room)) {
        calculateAboutYouScores(room);
        room.phase = 'aboutyou-reveal';
        broadcastState(room);
      }
    }
  });

  // ── NEXT ROUND ───────────────────────────────────
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

  // ── REROLL QUESTION ──────────────────────────────
  socket.on('reroll-question', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'writing' && room.phase !== 'aboutyou-vote') return;

    let newQ = null;

    if (room.mode === 'classic') {
      // Pick another question from the same category pool
      const cat = room.currentQuestion.category;
      newQ = pickQuestionFromCategory(room, cat);
      // If that category is exhausted, try any category
      if (!newQ) {
        const available = Object.keys(room.questionPool).filter(c => room.questionPool[c].length > 0);
        if (available.length > 0) {
          newQ = pickQuestionFromCategory(room, available[0]);
        }
      }
    } else if (room.mode === 'aboutyou') {
      // Swap current question with one from later in the shuffled list
      const remaining = room.questions.slice(room.round + 1);
      if (remaining.length > 0) {
        // Move current question to the end and bring the next one forward
        const skipped = room.questions.splice(room.round, 1)[0];
        room.questions.push(skipped); // push to end so it might appear later
        newQ = room.questions[room.round]; // the one that slid into this slot
      }
    } else if (room.mode === 'eay') {
      return socket.emit('error-msg', 'Cannot reroll in Enough About You — questions are personal!');
    }

    if (newQ) {
      room.currentQuestion = newQ;
      // Reset player submissions and votes since the question changed
      room.votes = new Map();
      room.players.forEach(p => {
        p.lie = null;
        p.vote = null;
        p.usedLieForMe = false;
      });
      broadcastState(room);
    } else {
      socket.emit('error-msg', 'No more questions available to reroll!');
    }
  });

  // ── KICK PLAYER ──────────────────────────────────
  socket.on('kick-player', ({ targetName }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;

    // Find the player by name
    let targetId = null;
    room.players.forEach((p, id) => {
      if (p.name === targetName) targetId = id;
    });
    if (!targetId) return;

    const player = room.players.get(targetId);
    if (player && player.token) tokenToRoom.delete(player.token);
    room.players.delete(targetId);
    const orderIdx = room.playerOrder.indexOf(targetId);
    if (orderIdx !== -1) room.playerOrder.splice(orderIdx, 1);

    // Notify the kicked player
    io.to(targetId).emit('error-msg', 'You have been removed from the game by the host.');

    broadcastState(room);
  });

  // ── END GAME EARLY ───────────────────────────────
  socket.on('end-game-early', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'gameover';
    broadcastState(room);
  });

  // ── RESTART ──────────────────────────────────────
  socket.on('restart-game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.round = 0;
    room.phase = 'lobby';
    room.eayAnswers = new Map();
    room.eayPromptAssignments = new Map();
    room.currentSubjectId = null;
    room.captainIndex = 0;
    room.isFinalRound = false;
    room.scoreMultiplier = 1;
    room.players.forEach(p => { p.score = 0; p.lie = null; p.vote = null; p.usedLieForMe = false; });
    broadcastState(room);
  });

  // ── DISCONNECT ───────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (socket.id === room.hostId) {
      io.to(currentRoom).emit('error-msg', 'The host has disconnected. Game ended.');
      room.players.forEach(p => {
        if (p.token) tokenToRoom.delete(p.token);
      });
      rooms.delete(currentRoom);
    } else {
      const player = room.players.get(socket.id);
      if (player) {
        player.connected = false;
        setTimeout(() => {
          const r = rooms.get(currentRoom);
          if (r) {
            const p = r.players.get(socket.id);
            if (p && !p.connected) {
              if (p.token) tokenToRoom.delete(p.token);
              r.players.delete(socket.id);
              const orderIdx = r.playerOrder.indexOf(socket.id);
              if (orderIdx !== -1) r.playerOrder.splice(orderIdx, 1);
              if (r.players.size === 0 && r.phase !== 'lobby') {
                rooms.delete(currentRoom);
              } else {
                broadcastState(r);
              }
            }
          }
        }, 5 * 60 * 1000);
        broadcastState(room);
      }
    }
  });
});

// ── Start ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎉 Party Game server running at http://localhost:${PORT}\n`);
});
