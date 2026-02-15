/* ─── TV.js — Host/TV client logic ─────────────────────────────────── */
(function () {
    const socket = io();
    const LABELS = 'ABCDEFGHIJKLMNOP';

    // ── DOM refs ─────────────────────────────────────────────────────
    const screens = {
        create: document.getElementById('screen-create'),
        lobby: document.getElementById('screen-lobby'),
        collectEay: document.getElementById('screen-collect-eay'),
        category: document.getElementById('screen-category'),
        writing: document.getElementById('screen-writing'),
        voting: document.getElementById('screen-voting'),
        reveal: document.getElementById('screen-reveal'),
        aboutyouVote: document.getElementById('screen-aboutyou-vote'),
        aboutyouReveal: document.getElementById('screen-aboutyou-reveal'),
        gameover: document.getElementById('screen-gameover'),
    };

    const refs = {
        btnCreate: document.getElementById('btn-create'),
        roomCode: document.getElementById('room-code'),
        joinUrl: document.getElementById('join-url'),
        qrContainer: document.getElementById('qr-container'),
        playerList: document.getElementById('player-list'),
        btnStart: document.getElementById('btn-start'),
        collectEayCount: document.getElementById('collect-eay-count'),
        collectEayAvatars: document.getElementById('collect-eay-avatars'),
        captainName: document.getElementById('captain-name'),
        categoryChoices: document.getElementById('category-choices'),
        finalBadgeCat: document.getElementById('final-badge-cat'),
        subjectTagW: document.getElementById('subject-tag-w'),
        subjectTagV: document.getElementById('subject-tag-v'),
        subjectTagR: document.getElementById('subject-tag-r'),
        promptW: document.getElementById('prompt-writing'),
        promptV: document.getElementById('prompt-voting'),
        promptR: document.getElementById('prompt-reveal'),
        categoryTagW: document.getElementById('category-tag-w'),
        categoryTagV: document.getElementById('category-tag-v'),
        finalBadgeW: document.getElementById('final-badge-w'),
        finalBadgeV: document.getElementById('final-badge-v'),
        submitCount: document.getElementById('submit-count'),
        submitAvatars: document.getElementById('submit-avatars'),
        optionsList: document.getElementById('options-list'),
        revealResults: document.getElementById('reveal-results'),
        reputationBonus: document.getElementById('reputation-bonus'),
        btnNext: document.getElementById('btn-next'),
        promptAY: document.getElementById('prompt-aboutyou'),
        aboutyouOptions: document.getElementById('aboutyou-options'),
        promptAYR: document.getElementById('prompt-aboutyou-r'),
        aboutyouResults: document.getElementById('aboutyou-results'),
        btnNextAY: document.getElementById('btn-next-ay'),
        finalScores: document.getElementById('final-scores'),
        btnRestart: document.getElementById('btn-restart'),
        roundBadgeW: document.getElementById('round-badge-w'),
        roundBadgeV: document.getElementById('round-badge-v'),
        roundBadgeR: document.getElementById('round-badge-r'),
        roundBadgeAV: document.getElementById('round-badge-av'),
        roundBadgeAR: document.getElementById('round-badge-ar'),
        confetti: document.getElementById('confetti-canvas'),
    };

    // ── Helpers ──────────────────────────────────────────────────────
    function showScreen(name) {
        Object.values(screens).forEach(s => s?.classList.remove('active'));
        if (screens[name]) screens[name].classList.add('active');
    }

    function roundLabel(data) {
        return `Round ${data.round + 1}/${data.totalRounds}`;
    }

    // ── Create room ──────────────────────────────────────────────────
    refs.btnCreate.addEventListener('click', () => socket.emit('create-room'));

    // ── Mode selector ────────────────────────────────────────────────
    document.querySelectorAll('.btn-mode').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-mode').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            socket.emit('set-mode', { mode: btn.dataset.mode });
        });
    });

    // ── Start / Next / Restart ───────────────────────────────────────
    refs.btnStart.addEventListener('click', () => socket.emit('start-game'));
    refs.btnNext.addEventListener('click', () => socket.emit('next-round'));
    refs.btnNextAY.addEventListener('click', () => socket.emit('next-round'));
    refs.btnRestart.addEventListener('click', () => socket.emit('restart-game'));

    // ── Error handling ───────────────────────────────────────────────
    socket.on('error-msg', msg => alert(msg));

    // ── State update handler ─────────────────────────────────────────
    socket.on('state-update', (data) => {
        switch (data.phase) {
            case 'lobby': renderLobby(data); break;
            case 'collect-eay': renderCollectEay(data); break;
            case 'category-select': renderCategorySelect(data); break;
            case 'writing': renderWriting(data); break;
            case 'voting': renderVoting(data); break;
            case 'reveal': renderReveal(data); break;
            case 'aboutyou-vote': renderAboutYouVote(data); break;
            case 'aboutyou-reveal': renderAboutYouReveal(data); break;
            case 'gameover': renderGameover(data); break;
        }
    });

    // ── Renderers ────────────────────────────────────────────────────
    function renderLobby(data) {
        showScreen('lobby');
        refs.roomCode.textContent = data.code;

        const baseUrl = location.origin + '/controller.html';
        refs.joinUrl.textContent = location.host + '/controller.html';

        // QR Code
        refs.qrContainer.innerHTML = '';
        try {
            const qr = qrcode(0, 'M');
            qr.addData(baseUrl + '?code=' + data.code);
            qr.make();
            refs.qrContainer.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
        } catch (e) { console.warn('QR generation failed', e); }

        // Update mode buttons
        document.querySelectorAll('.btn-mode').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === data.mode);
        });

        refs.playerList.innerHTML = '';
        data.players.forEach(p => {
            const li = document.createElement('li');
            li.innerHTML = `
        <span class="player-avatar" style="background:${p.avatar}">${p.name[0]}</span>
        <span>${p.name}</span>
        ${!p.connected ? '<span class="disconnected-tag">📴</span>' : ''}
      `;
            refs.playerList.appendChild(li);
        });

        refs.btnStart.disabled = data.players.filter(p => p.connected).length < 2;
    }

    function renderCollectEay(data) {
        showScreen('collectEay');
        refs.collectEayCount.textContent = `${data.submitted.length} / ${data.total} answered`;
        refs.collectEayAvatars.innerHTML = '';
        data.players.forEach(p => {
            const dot = document.createElement('div');
            dot.className = 'avatar-dot ' + (data.submitted.includes(p.name) ? 'done' : 'pending');
            dot.style.background = p.avatar;
            dot.textContent = p.name[0];
            refs.collectEayAvatars.appendChild(dot);
        });
    }

    function renderCategorySelect(data) {
        showScreen('category');
        refs.captainName.textContent = data.captainName;
        refs.finalBadgeCat.style.display = data.isFinalRound ? 'block' : 'none';

        refs.categoryChoices.innerHTML = '';
        data.categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = 'btn-category';
            btn.textContent = cat;
            refs.categoryChoices.appendChild(btn);
        });
    }

    function renderWriting(data) {
        showScreen('writing');
        refs.roundBadgeW.textContent = roundLabel(data);
        refs.promptW.textContent = data.prompt;
        refs.categoryTagW.textContent = data.category || '';
        if (data.mode === 'eay') {
            refs.subjectTagW.textContent = `About ${data.subjectName}`;
            refs.subjectTagW.style.display = 'block';
        } else {
            refs.subjectTagW.style.display = 'none';
        }
        refs.finalBadgeW.style.display = data.isFinalRound ? 'block' : 'none';
        refs.submitCount.textContent = `${data.submitted.length} / ${data.total} submitted`;

        refs.submitAvatars.innerHTML = '';
        data.players.forEach(p => {
            // In EAY, skip the subject in the submitted tracking bubbles if desired, or show them as distinct
            if (data.mode === 'eay' && p.name === data.subjectName) return;

            const dot = document.createElement('div');
            dot.className = 'avatar-dot ' + (data.submitted.includes(p.name) ? 'done' : 'pending');
            dot.style.background = p.avatar;
            dot.textContent = p.name[0];
            refs.submitAvatars.appendChild(dot);
        });
    }

    function renderVoting(data) {
        showScreen('voting');
        refs.roundBadgeV.textContent = roundLabel(data);
        refs.promptV.textContent = data.prompt;
        refs.categoryTagV.textContent = data.category || '';
        if (data.mode === 'eay') {
            refs.subjectTagV.textContent = `About ${data.subjectName}`;
            refs.subjectTagV.style.display = 'block';
        } else {
            refs.subjectTagV.style.display = 'none';
        }
        refs.finalBadgeV.style.display = data.isFinalRound ? 'block' : 'none';

        refs.optionsList.innerHTML = '';
        data.options.forEach((text, i) => {
            const div = document.createElement('div');
            div.className = 'option-card';
            div.innerHTML = `
        <div class="option-label">${LABELS[i]}</div>
        <div class="option-text">${text}</div>
      `;
            refs.optionsList.appendChild(div);
        });
    }

    function renderReveal(data) {
        showScreen('reveal');
        refs.roundBadgeR.textContent = roundLabel(data);
        refs.promptR.textContent = data.prompt;
        if (data.mode === 'eay') {
            refs.subjectTagR.textContent = `About ${data.subjectName}`;
            refs.subjectTagR.style.display = 'block';
            if (data.reputationBonus > 0) {
                refs.reputationBonus.style.display = 'block';
                refs.reputationBonus.textContent = `⭐ REPUTATION BONUS: +${data.reputationBonus}`;
            } else {
                refs.reputationBonus.style.display = 'none';
            }
        } else {
            refs.subjectTagR.style.display = 'none';
            refs.reputationBonus.style.display = 'none';
        }

        refs.revealResults.innerHTML = '';
        data.results.forEach((r, i) => {
            const div = document.createElement('div');
            div.className = 'reveal-card' + (r.isTruth ? ' truth' : '');
            div.style.animationDelay = `${i * 0.12}s`;
            let authorLabel = '';
            if (r.isTruth) authorLabel = '✅ TRUTH';
            else if (r.isLieForMe) authorLabel = 'Lie for Me 🤖';
            else if (r.author) authorLabel = 'Written by ' + r.author;

            div.innerHTML = `
        <div class="option-label">${LABELS[i]}</div>
        <div class="option-text">${textToHtml(r.text)}</div>
        <div class="author-tag">${authorLabel}</div>
        <div class="voters">${r.voters.length > 0 ? '👆 ' + r.voters.join(', ') : ''}</div>
      `;
            refs.revealResults.appendChild(div);
        });
        fireConfetti();
    }

    function textToHtml(str) {
        return str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderAboutYouVote(data) {
        showScreen('aboutyouVote');
        refs.roundBadgeAV.textContent = roundLabel(data);
        refs.promptAY.textContent = data.prompt;

        refs.aboutyouOptions.innerHTML = '';
        data.options.forEach(name => {
            const div = document.createElement('div');
            div.className = 'option-card';
            div.innerHTML = `<div class="option-text">${name}</div>`;
            refs.aboutyouOptions.appendChild(div);
        });
    }

    function renderAboutYouReveal(data) {
        showScreen('aboutyouReveal');
        refs.roundBadgeAR.textContent = roundLabel(data);
        refs.promptAYR.textContent = data.prompt;

        const counts = data.voteCounts;
        const maxCount = Math.max(...Object.values(counts), 1);
        refs.aboutyouResults.innerHTML = '';

        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        entries.forEach(([name, count]) => {
            const row = document.createElement('div');
            row.className = 'aboutyou-row';
            row.innerHTML = `
        <span class="aboutyou-name">${name}</span>
        <div class="aboutyou-bar-bg">
          <div class="aboutyou-bar-fill" style="width:${(count / maxCount) * 100}%"></div>
        </div>
        <span class="aboutyou-count">${count} vote${count !== 1 ? 's' : ''}</span>
      `;
            refs.aboutyouResults.appendChild(row);
        });
        fireConfetti();
    }

    function renderGameover(data) {
        showScreen('gameover');
        const sorted = [...data.players].sort((a, b) => b.score - a.score);
        refs.finalScores.innerHTML = '';
        const medals = ['🥇', '🥈', '🥉'];
        sorted.forEach((p, i) => {
            const row = document.createElement('div');
            row.className = 'score-row';
            row.style.animationDelay = `${i * 0.1}s`;
            row.innerHTML = `
        <div><span class="rank">${medals[i] || '#' + (i + 1)}</span>${p.name}</div>
        <span class="pts">${p.score.toLocaleString()}</span>
      `;
            refs.finalScores.appendChild(row);
        });
        fireConfetti();
    }

    // ── Confetti ─────────────────────────────────────────────────────
    function fireConfetti() {
        const canvas = refs.confetti;
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        const colors = ['#7c5cfc', '#ff6bcb', '#4ecdc4', '#ffd700', '#ff5252', '#4caf50'];
        const pieces = Array.from({ length: 120 }, () => ({
            x: Math.random() * canvas.width,
            y: -10 - Math.random() * 200,
            w: 6 + Math.random() * 6,
            h: 10 + Math.random() * 8,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: (Math.random() - 0.5) * 4,
            vy: 2 + Math.random() * 4,
            rot: Math.random() * Math.PI * 2,
            rv: (Math.random() - 0.5) * 0.15,
        }));
        let frame = 0;
        function animate() {
            frame++;
            if (frame > 180) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            pieces.forEach(p => {
                p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.rot += p.rv;
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            });
            requestAnimationFrame(animate);
        }
        animate();
    }
})();
