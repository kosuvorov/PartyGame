/* ─── Controller.js — Phone/Player client logic ───────────────────── */
(function () {
    const socket = io();
    const LABELS = 'ABCDEFGHIJKLMNOP';
    const SESSION_KEY = 'fibbage_session';

    // ── DOM refs ─────────────────────────────────────────────────────
    const screens = {
        join: document.getElementById('screen-join'),
        waiting: document.getElementById('screen-waiting'),
        collectFact: document.getElementById('screen-collect-fact'),
        factSubmitted: document.getElementById('screen-fact-submitted'),
        captainPick: document.getElementById('screen-captain-pick'),
        categoryWait: document.getElementById('screen-category-wait'),
        write: document.getElementById('screen-write'),
        submitted: document.getElementById('screen-submitted'),
        factOwner: document.getElementById('screen-fact-owner'),
        vote: document.getElementById('screen-vote'),
        voted: document.getElementById('screen-voted'),
        reveal: document.getElementById('screen-ctrl-reveal'),
        gameover: document.getElementById('screen-ctrl-gameover'),
    };

    const refs = {
        inputCode: document.getElementById('input-code'),
        inputName: document.getElementById('input-name'),
        btnJoin: document.getElementById('btn-join'),
        joinError: document.getElementById('join-error'),
        myNameTag: document.getElementById('my-name-tag'),
        inputFact: document.getElementById('input-fact'),
        btnFact: document.getElementById('btn-submit-fact'),
        factError: document.getElementById('fact-error'),
        captainCats: document.getElementById('captain-categories'),
        captainPicking: document.getElementById('captain-picking'),
        ctrlPromptW: document.getElementById('ctrl-prompt-w'),
        inputLie: document.getElementById('input-lie'),
        btnSubmit: document.getElementById('btn-submit-lie'),
        btnLieForMe: document.getElementById('btn-lie-for-me'),
        writeError: document.getElementById('write-error'),
        ctrlPromptV: document.getElementById('ctrl-prompt-v'),
        ctrlOptions: document.getElementById('ctrl-options'),
        voteError: document.getElementById('vote-error'),
        ctrlScore: document.getElementById('ctrl-score'),
        ctrlFinal: document.getElementById('ctrl-final-score'),
        roundBadgeW: document.getElementById('ctrl-round-w'),
        roundBadgeV: document.getElementById('ctrl-round-v'),
    };

    let myName = '';
    let myToken = '';

    // ── Auto-fill room code from URL ─────────────────────────────────
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('code')) {
        refs.inputCode.value = urlParams.get('code').toUpperCase();
    }

    // ── Session persistence ──────────────────────────────────────────
    function saveSession(code, name, token) {
        const session = { code, name, token, ts: Date.now() };
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { }
    }

    function loadSession() {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            const session = JSON.parse(raw);
            // expire after 2 hours
            if (Date.now() - session.ts > 2 * 60 * 60 * 1000) {
                localStorage.removeItem(SESSION_KEY);
                return null;
            }
            return session;
        } catch (e) { return null; }
    }

    function clearSession() {
        try { localStorage.removeItem(SESSION_KEY); } catch (e) { }
    }

    // ── Auto-reconnect from session on page load ─────────────────────
    const savedSession = loadSession();
    if (savedSession) {
        refs.inputCode.value = savedSession.code;
        refs.inputName.value = savedSession.name;
        myName = savedSession.name;
        myToken = savedSession.token;
        socket.emit('join-room', {
            code: savedSession.code,
            name: savedSession.name,
            token: savedSession.token,
        });
    }

    // ── Helpers ──────────────────────────────────────────────────────
    function showScreen(name) {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        if (screens[name]) screens[name].classList.add('active');
    }

    function roundLabel(data) {
        return `Round ${data.round + 1}/${data.totalRounds}`;
    }

    function clearErrors() {
        refs.joinError.textContent = '';
        refs.writeError.textContent = '';
        refs.voteError.textContent = '';
        refs.factError.textContent = '';
    }

    // ── Join flow ────────────────────────────────────────────────────
    refs.btnJoin.addEventListener('click', () => {
        clearErrors();
        const code = refs.inputCode.value.trim().toUpperCase();
        const name = refs.inputName.value.trim();
        if (!code || code.length < 4) { refs.joinError.textContent = 'Enter a 4-letter code.'; return; }
        if (!name) { refs.joinError.textContent = 'Enter your name.'; return; }
        socket.emit('join-room', { code, name });
    });

    refs.inputCode.addEventListener('keydown', e => { if (e.key === 'Enter') refs.inputName.focus(); });
    refs.inputName.addEventListener('keydown', e => { if (e.key === 'Enter') refs.btnJoin.click(); });

    socket.on('joined', ({ code, name, token }) => {
        myName = name;
        myToken = token;
        refs.myNameTag.textContent = name;
        saveSession(code, name, token);
        showScreen('waiting');
    });

    // ── Submit fact (Fan Facts) ──────────────────────────────────────
    refs.btnFact.addEventListener('click', () => {
        clearErrors();
        const text = refs.inputFact.value.trim();
        if (!text) { refs.factError.textContent = 'Share something!'; return; }
        socket.emit('submit-fact', { text });
    });

    // ── Submit lie ───────────────────────────────────────────────────
    refs.btnSubmit.addEventListener('click', () => {
        clearErrors();
        const text = refs.inputLie.value.trim();
        if (!text) { refs.writeError.textContent = 'Type something!'; return; }
        socket.emit('submit-lie', { text });
    });

    refs.inputLie.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); refs.btnSubmit.click(); }
    });

    // ── Lie for Me ───────────────────────────────────────────────────
    refs.btnLieForMe.addEventListener('click', () => {
        clearErrors();
        socket.emit('lie-for-me');
    });

    // ── Error handling ───────────────────────────────────────────────
    socket.on('error-msg', msg => {
        if (screens.join.classList.contains('active')) refs.joinError.textContent = msg;
        else if (screens.write.classList.contains('active')) refs.writeError.textContent = msg;
        else if (screens.vote.classList.contains('active')) refs.voteError.textContent = msg;
        else if (screens.collectFact.classList.contains('active')) refs.factError.textContent = msg;
        else alert(msg);
    });

    // ── State update handler ─────────────────────────────────────────
    socket.on('state-update', (data) => {
        clearErrors();

        switch (data.phase) {
            case 'lobby':
                if (myName) showScreen('waiting');
                break;

            case 'collect-facts':
                if (data.submitted) {
                    showScreen('factSubmitted');
                } else {
                    showScreen('collectFact');
                    refs.inputFact.value = '';
                }
                break;

            case 'category-select':
                if (data.isCaptain) {
                    showScreen('captainPick');
                    renderCaptainCategories(data.categories);
                } else {
                    showScreen('categoryWait');
                    refs.captainPicking.textContent = data.captainName || '???';
                }
                break;

            case 'writing':
                if (data.isFactOwner) {
                    showScreen('factOwner');
                } else if (data.submitted) {
                    showScreen('submitted');
                } else {
                    showScreen('write');
                    refs.roundBadgeW.textContent = roundLabel(data);
                    refs.ctrlPromptW.textContent = data.prompt;
                    refs.inputLie.value = '';
                }
                break;

            case 'voting':
                if (data.voted) {
                    showScreen('voted');
                } else {
                    showScreen('vote');
                    refs.roundBadgeV.textContent = roundLabel(data);
                    refs.ctrlPromptV.textContent = data.prompt;
                    renderVotingOptions(data.options);
                }
                break;

            case 'aboutyou-vote':
                if (data.voted) {
                    showScreen('voted');
                } else {
                    showScreen('vote');
                    refs.roundBadgeV.textContent = roundLabel(data);
                    refs.ctrlPromptV.textContent = data.prompt;
                    renderAboutYouOptions(data.options);
                }
                break;

            case 'reveal':
            case 'aboutyou-reveal':
                showScreen('reveal');
                refs.ctrlScore.textContent = (data.yourScore || 0).toLocaleString();
                break;

            case 'gameover':
                showScreen('gameover');
                refs.ctrlFinal.textContent = (data.yourScore || 0).toLocaleString();
                clearSession(); // clear session when game is over
                break;
        }
    });

    // ── Render captain category choices ──────────────────────────────
    function renderCaptainCategories(categories) {
        refs.captainCats.innerHTML = '';
        categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-option';
            btn.textContent = cat;
            btn.addEventListener('click', () => socket.emit('select-category', { category: cat }));
            refs.captainCats.appendChild(btn);
        });
    }

    // ── Render voting options (classic / fan facts) ──────────────────
    function renderVotingOptions(options) {
        refs.ctrlOptions.innerHTML = '';
        options.forEach(opt => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-option';
            btn.innerHTML = `<strong>${LABELS[opt.index]}.</strong>&nbsp; ${opt.text}`;
            btn.addEventListener('click', () => socket.emit('submit-vote', { optionIndex: opt.index }));
            refs.ctrlOptions.appendChild(btn);
        });
    }

    // ── Render voting options (about you) ────────────────────────────
    function renderAboutYouOptions(options) {
        refs.ctrlOptions.innerHTML = '';
        options.forEach(opt => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-option';
            btn.textContent = opt.text;
            btn.addEventListener('click', () => socket.emit('submit-vote', { optionIndex: opt.index }));
            refs.ctrlOptions.appendChild(btn);
        });
    }

    // ── Auto-reconnect on socket reconnect ──────────────────────────
    socket.on('connect', () => {
        if (myName && myToken) {
            const code = refs.inputCode.value.trim().toUpperCase();
            if (code) {
                socket.emit('join-room', { code, name: myName, token: myToken });
            }
        }
    });
})();
