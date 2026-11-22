const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const walletRouter = require('./wallet');
const authRouter = require('./auth');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.use('/api/auth', authRouter);
app.use('/api/wallet', walletRouter);

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.send('👑 AlfaOne Real Money Multi-Game Engine Running'));

const server = http.createServer(app);
const io = require('socket.io')(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    transports: ['polling', 'websocket'],
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 60000
});

function emitAll(event, payload) {
    if (io.engine.clientsCount > 0) {
        io.emit(event, payload);
    }
}

function pickLowestPayout(payoutMap) {
    const entries = Object.entries(payoutMap);
    let minVal = Infinity;
    for (const [, val] of entries) {
        if (val < minVal) minVal = val;
    }
    const candidates = entries.filter(([, val]) => val === minVal).map(([key]) => key);
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function isAutoMode(val) {
    if (!val) return true;
    const s = String(val).trim().toUpperCase();
    return s === '' || s === 'AUTO' || s === 'AUTO_PROFIT' || s === 'PROFIT' || s === 'NONE' || s === 'NULL';
}

// ==========================================
// 1️⃣ DRAGON VS TIGER (LOCKED)
// ==========================================
let dvtState = {
    phase: 'BETTING',
    timeLeft: 20,
    cooldown: 0,
    roundStarted: false,
    roundId: Math.floor(100000 + Math.random() * 900000),
    bets: { DRAGON: 0, TIGER: 0, TIE: 0 },
    manualWinner: 'AUTO',
    lastResult: null
};

function generateDVTCards(winner) {
    if (winner === 'DRAGON') {
        const dCard = Math.floor(Math.random() * 12) + 2;
        const tCard = Math.floor(Math.random() * (dCard - 1)) + 1;
        return { dCard, tCard };
    }
    if (winner === 'TIGER') {
        const tCard = Math.floor(Math.random() * 12) + 2;
        const dCard = Math.floor(Math.random() * (tCard - 1)) + 1;
        return { dCard, tCard };
    }
    const tieVal = Math.floor(Math.random() * 13) + 1;
    return { dCard: tieVal, tCard: tieVal };
}

function settleDVT() {
    dvtState.phase = 'CALCULATING';
    emitAll('timer_tick', { state: 'CALCULATING', timeLeft: 0, bets: dvtState.bets });

    let winner = dvtState.manualWinner;
    if (isAutoMode(winner)) {
        const totalBets = (dvtState.bets.DRAGON || 0) + (dvtState.bets.TIGER || 0) + (dvtState.bets.TIE || 0);
        if (totalBets === 0) {
            winner = Math.random() < 0.48 ? 'DRAGON' : (Math.random() < 0.96 ? 'TIGER' : 'TIE');
        } else {
            winner = pickLowestPayout({
                DRAGON: (dvtState.bets.DRAGON || 0) * 2,
                TIGER: (dvtState.bets.TIGER || 0) * 2,
                TIE: (dvtState.bets.TIE || 0) * 9
            });
        }
    }

    const { dCard, tCard } = generateDVTCards(winner);
    dvtState.lastResult = { roundId: dvtState.roundId, winner, dCard, tCard };
    emitAll('round_result', dvtState.lastResult);
    dvtState.phase = 'RESULT';
    dvtState.cooldown = 5;
}

function tickDVT() {
    if (dvtState.phase === 'RESULT') {
        if (--dvtState.cooldown > 0) return;
        dvtState.phase = 'BETTING';
        dvtState.timeLeft = 20;
        dvtState.roundId = Math.floor(100000 + Math.random() * 900000);
        dvtState.bets = { DRAGON: 0, TIGER: 0, TIE: 0 };
        dvtState.lastResult = null;
        dvtState.roundStarted = true;
        emitAll('round_start', { roundId: dvtState.roundId, manualWinner: dvtState.manualWinner });
        emitAll('timer_tick', { state: 'BETTING', timeLeft: dvtState.timeLeft, bets: dvtState.bets });
        return;
    }
    if (!dvtState.roundStarted) {
        dvtState.roundStarted = true;
        emitAll('round_start', { roundId: dvtState.roundId, manualWinner: dvtState.manualWinner });
        emitAll('timer_tick', { state: 'BETTING', timeLeft: dvtState.timeLeft, bets: dvtState.bets });
        return;
    }
    if (--dvtState.timeLeft > 0) {
        emitAll('timer_tick', { state: 'BETTING', timeLeft: dvtState.timeLeft, bets: dvtState.bets });
    } else {
        settleDVT();
    }
}

// ==========================================
// 2️⃣ COLOR PREDICTION (LOCKED)
// ==========================================
let colorState = {
    phase: 'BETTING',
    roundId: Math.floor(100000 + Math.random() * 900000),
    timeLeft: 30,
    cooldown: 0,
    roundStarted: false,
    bets: { RED: { total: 0 }, GREEN: { total: 0 }, VIOLET: { total: 0 } },
    currentMode: 'AUTO',
    winningColor: null
};

function settleColor() {
    colorState.phase = 'CALCULATING';

    let winColor = colorState.currentMode;
    if (isAutoMode(winColor)) {
        winColor = pickLowestPayout({
            RED: (colorState.bets.RED.total || 0) * 2,
            GREEN: (colorState.bets.GREEN.total || 0) * 2,
            VIOLET: (colorState.bets.VIOLET.total || 0) * 4.5
        });
    }

    colorState.winningColor = winColor;
    emitAll('color_round_result', { roundId: String(colorState.roundId), winningColor: winColor });
    colorState.phase = 'RESULT';
    colorState.cooldown = 5;
}

function tickColor() {
    if (colorState.phase === 'RESULT') {
        if (--colorState.cooldown > 0) return;
        colorState.phase = 'BETTING';
        colorState.timeLeft = 30;
        colorState.roundId = Math.floor(100000 + Math.random() * 900000);
        colorState.bets = { RED: { total: 0 }, GREEN: { total: 0 }, VIOLET: { total: 0 } };
        colorState.winningColor = null;
        colorState.roundStarted = true;
    } else if (!colorState.roundStarted) {
        colorState.roundStarted = true;
    } else if (--colorState.timeLeft <= 0) {
        settleColor();
        return;
    }

    const tickPayload = {
        timeLeft: colorState.timeLeft,
        roundId: String(colorState.roundId),
        phase: colorState.phase
    };
    emitAll('admin_color_update', {
        roundId: colorState.roundId,
        timeLeft: colorState.timeLeft,
        liveUsers: io.engine.clientsCount,
        bets: colorState.bets,
        currentMode: colorState.currentMode
    });
    emitAll('color_timer_tick', tickPayload);
    emitAll('color_game_tick', tickPayload);
}

// ==========================================
// 3️⃣ ZOO ROULETTE
// ==========================================
const ANIMALS = [
    { id: 'swallow', multiplier: 6 }, { id: 'rabbit', multiplier: 6 },
    { id: 'monkey', multiplier: 8 }, { id: 'panda', multiplier: 8 },
    { id: 'peacock', multiplier: 8 }, { id: 'pigeon', multiplier: 8 },
    { id: 'eagle', multiplier: 12 }, { id: 'lion', multiplier: 12 },
    { id: 'silver_shark', multiplier: 24 }, { id: 'gold_shark', multiplier: 24 }
];

let zooState = {
    phase: 'BETTING',
    roundId: Math.floor(1000 + Math.random() * 9000),
    timeLeft: 15,
    cooldown: 0,
    roundStarted: false,
    bets: {},
    manualWinner: 'AUTO'
};

function resetZoo() {
    zooState.bets = {};
    ANIMALS.forEach(a => { zooState.bets[a.id] = { amount: 0, playerCount: 0 }; });
}
resetZoo();

function settleZoo() {
    zooState.phase = 'CALCULATING';

    let winAnimal = zooState.manualWinner;
    if (isAutoMode(winAnimal)) {
        const payoutMap = {};
        for (const a of ANIMALS) {
            payoutMap[a.id] = (zooState.bets[a.id]?.amount || 0) * a.multiplier;
        }
        winAnimal = pickLowestPayout(payoutMap);
    }

    const matched = ANIMALS.find(a => a.id === winAnimal) || ANIMALS[0];
    emitAll('zoo_round_result', {
        winningAnimal: matched.id,
        winner: matched.id,
        multiplier: matched.multiplier,
        roundId: zooState.roundId
    });
    zooState.phase = 'RESULT';
    zooState.cooldown = 6;
}

function tickZoo() {
    if (zooState.phase === 'RESULT') {
        if (--zooState.cooldown > 0) return;
        zooState.phase = 'BETTING';
        zooState.timeLeft = 15;
        zooState.roundId = Math.floor(1000 + Math.random() * 9000);
        resetZoo();
        zooState.roundStarted = true;
        emitAll('zoo_round_reset', { roundId: zooState.roundId, currentMode: zooState.manualWinner });
    } else if (!zooState.roundStarted) {
        zooState.roundStarted = true;
        emitAll('zoo_round_reset', { roundId: zooState.roundId, currentMode: zooState.manualWinner });
    } else if (--zooState.timeLeft <= 0) {
        settleZoo();
        return;
    }

    emitAll('zoo_timer_update', {
        timeLeft: zooState.timeLeft,
        state: 'BETTING',
        roundId: zooState.roundId,
        bets: zooState.bets,
        currentMode: zooState.manualWinner,
        livePlayers: io.engine.clientsCount
    });
}

// ==========================================
// 4️⃣ 7 UP DOWN (LIVE HTTP + SOCKET SYNC)
// ==========================================
let sevenState = {
    phase: 'BETTING',
    roundId: Math.floor(10000 + Math.random() * 90000),
    timeLeft: 15,
    cooldown: 0,
    roundStarted: false,
    bets: { DOWN: 0, SEVEN: 0, UP: 0 },
    manualWinner: 'AUTO',
    lastResult: null
};

function generateSevenDice(winner) {
    const pairs = [];
    for (let d1 = 1; d1 <= 6; d1++) {
        for (let d2 = 1; d2 <= 6; d2++) {
            const sum = d1 + d2;
            if (winner === 'DOWN' && sum < 7) pairs.push([d1, d2, sum]);
            else if (winner === 'SEVEN' && sum === 7) pairs.push([d1, d2, sum]);
            else if (winner === 'UP' && sum > 7) pairs.push([d1, d2, sum]);
        }
    }
    const picked = pairs[Math.floor(Math.random() * pairs.length)] || [3, 4, 7];
    return { dice1: picked[0], dice2: picked[1], total: picked[2] };
}

function settleSeven() {
    sevenState.phase = 'CALCULATING';

    let winner = sevenState.manualWinner;
    if (isAutoMode(winner)) {
        winner = pickLowestPayout({
            DOWN: (sevenState.bets.DOWN || 0) * 2,
            UP: (sevenState.bets.UP || 0) * 2,
            SEVEN: (sevenState.bets.SEVEN || 0) * 5
        });
    }

    const { dice1, dice2, total } = generateSevenDice(winner);
    const winningOption = winner === 'DOWN' ? 'TWO_TO_SIX' : (winner === 'UP' ? 'EIGHT_TO_TWELVE' : 'SEVEN');

    sevenState.lastResult = {
        roundId: String(sevenState.roundId),
        winner,
        winningOption,
        dice1,
        dice2,
        total
    };
    emitAll('seven_round_result', sevenState.lastResult);
    sevenState.phase = 'RESULT';
    sevenState.cooldown = 6;
}

function tickSeven() {
    if (sevenState.phase === 'RESULT') {
        if (--sevenState.cooldown > 0) return;
        sevenState.phase = 'BETTING';
        sevenState.timeLeft = 15;
        sevenState.roundId = Math.floor(10000 + Math.random() * 90000);
        sevenState.bets = { DOWN: 0, SEVEN: 0, UP: 0 };
        sevenState.lastResult = null;
        sevenState.roundStarted = true;
        emitAll('seven_round_reset', { roundId: sevenState.roundId, currentMode: sevenState.manualWinner });
    } else if (!sevenState.roundStarted) {
        sevenState.roundStarted = true;
    } else if (--sevenState.timeLeft <= 0) {
        settleSeven();
        return;
    }

    emitAll('seven_timer_update', {
        timeLeft: sevenState.timeLeft,
        state: 'BETTING',
        roundId: sevenState.roundId,
        bets: sevenState.bets,
        currentMode: sevenState.manualWinner
    });
}

setInterval(() => {
    tickDVT();
    tickColor();
    tickZoo();
    tickSeven();
}, 1000);

// ==========================================
// 🌐 HTTP LIVE GAME SYNC API (100% RELIABLE)
// ==========================================
app.get('/api/game/color-state', (req, res) => {
    res.json({
        success: true,
        roundId: String(colorState.roundId),
        timeLeft: colorState.timeLeft,
        phase: colorState.phase,
        winningColor: colorState.winningColor
    });
});

app.post('/api/game/color-bet', (req, res) => {
    const color = String(req.body?.color || '').trim().toUpperCase();
    const betAmt = Number(req.body?.amount) || 0;
    if (colorState.phase === 'BETTING' && betAmt > 0 && colorState.bets[color]) {
        colorState.bets[color].total += betAmt;
        emitAll('admin_color_update', {
            roundId: colorState.roundId,
            timeLeft: colorState.timeLeft,
            liveUsers: Math.max(1, io.engine.clientsCount),
            bets: colorState.bets,
            currentMode: colorState.currentMode
        });
    }
    res.json({ success: true, bets: colorState.bets });
});

app.get('/api/game/dvt-state', (req, res) => {
    res.json({
        success: true,
        roundId: dvtState.roundId,
        timeLeft: dvtState.timeLeft,
        phase: dvtState.phase,
        bets: dvtState.bets,
        result: dvtState.lastResult
    });
});

app.post('/api/game/dvt-bet', (req, res) => {
    const betOn = String(req.body?.bet_on || '').trim().toUpperCase();
    const betAmt = Number(req.body?.amount) || 0;
    if (dvtState.phase === 'BETTING' && betAmt > 0 && dvtState.bets[betOn] !== undefined) {
        dvtState.bets[betOn] += betAmt;
        emitAll('bets_updated', dvtState.bets);
        emitAll('timer_tick', { state: 'BETTING', timeLeft: dvtState.timeLeft, bets: dvtState.bets });
    }
    res.json({ success: true, bets: dvtState.bets });
});

app.get('/api/game/seven-state', (req, res) => {
    res.json({
        success: true,
        roundId: String(sevenState.roundId),
        timeLeft: sevenState.timeLeft,
        phase: sevenState.phase,
        bets: sevenState.bets,
        result: sevenState.lastResult
    });
});

app.post('/api/game/seven-bet', (req, res) => {
    const rawChoice = String(req.body?.choice || req.body?.option || '').trim().toUpperCase();
    const choice = rawChoice === 'TWO_TO_SIX' ? 'DOWN' : (rawChoice === 'EIGHT_TO_TWELVE' ? 'UP' : rawChoice);
    const betAmt = Number(req.body?.amount) || 0;
    if (sevenState.phase === 'BETTING' && betAmt > 0 && sevenState.bets[choice] !== undefined) {
        sevenState.bets[choice] += betAmt;
        emitAll('seven_timer_update', {
            timeLeft: sevenState.timeLeft,
            state: 'BETTING',
            roundId: sevenState.roundId,
            bets: sevenState.bets,
            currentMode: sevenState.manualWinner
        });
    }
    res.json({ success: true, bets: sevenState.bets });
});

// ==========================================
// 🔌 SOCKET EVENTS (GAMES + ADMIN CONTROLS)
// ==========================================
io.on('connection', (socket) => {
    socket.on('join_admin', () => {
        socket.emit('admin_status_update', {
            manualWinner: dvtState.manualWinner === 'AUTO' ? null : dvtState.manualWinner,
            currentMode: dvtState.manualWinner,
            bets: dvtState.bets
        });
        socket.emit('admin_color_update', {
            roundId: colorState.roundId,
            timeLeft: colorState.timeLeft,
            liveUsers: io.engine.clientsCount,
            bets: colorState.bets,
            currentMode: colorState.currentMode
        });
        socket.emit('zoo_timer_update', {
            timeLeft: zooState.timeLeft,
            state: zooState.phase,
            roundId: zooState.roundId,
            bets: zooState.bets,
            currentMode: zooState.manualWinner,
            livePlayers: io.engine.clientsCount
        });
        socket.emit('seven_timer_update', {
            timeLeft: sevenState.timeLeft,
            state: sevenState.phase,
            roundId: sevenState.roundId,
            bets: sevenState.bets,
            currentMode: sevenState.manualWinner
        });
    });

    socket.on('join_color_game', () => {
        const tickPayload = {
            timeLeft: colorState.timeLeft,
            roundId: String(colorState.roundId),
            phase: colorState.phase
        };
        socket.emit('color_timer_tick', tickPayload);
        socket.emit('color_game_tick', tickPayload);
    });

    socket.on('place_bet', (data) => {
        const betOn = String(data?.bet_on || '').trim().toUpperCase();
        const betAmt = Number(data?.amount) || 0;
        if (dvtState.phase !== 'BETTING' || betAmt <= 0) return;
        if (dvtState.bets[betOn] !== undefined) {
            dvtState.bets[betOn] += betAmt;
            emitAll('bets_updated', dvtState.bets);
        }
    });

    socket.on('admin_set_winner', (data) => {
        const raw = data?.winner ?? data?.mode ?? data?.choice ?? 'AUTO';
        const norm = isAutoMode(raw) ? 'AUTO' : String(raw).trim().toUpperCase();
        if (['AUTO', 'DRAGON', 'TIGER', 'TIE'].includes(norm)) {
            dvtState.manualWinner = norm;
            emitAll('admin_status_update', {
                manualWinner: norm === 'AUTO' ? null : norm,
                currentMode: norm,
                bets: dvtState.bets
            });
        }
    });

    socket.on('color_place_bet', (data) => {
        const color = String(data?.color || '').trim().toUpperCase();
        const betAmt = Number(data?.amount) || 0;
        if (colorState.phase !== 'BETTING' || betAmt <= 0) return;
        if (colorState.bets[color]) {
            colorState.bets[color].total += betAmt;
            emitAll('admin_color_update', {
                roundId: colorState.roundId,
                timeLeft: colorState.timeLeft,
                liveUsers: io.engine.clientsCount,
                bets: colorState.bets,
                currentMode: colorState.currentMode
            });
        }
    });

    socket.on('admin_set_color_mode', (data) => {
        const raw = data?.mode ?? data?.color ?? data?.winner ?? 'AUTO';
        const norm = isAutoMode(raw) ? 'AUTO' : String(raw).trim().toUpperCase();
        if (['AUTO', 'RED', 'GREEN', 'VIOLET'].includes(norm)) {
            colorState.currentMode = norm;
            emitAll('admin_color_update', {
                roundId: colorState.roundId,
                timeLeft: colorState.timeLeft,
                liveUsers: io.engine.clientsCount,
                bets: colorState.bets,
                currentMode: colorState.currentMode
            });
        }
    });

    socket.on('zoo_place_bet', (data) => {
        const rawAnimal = String(data?.animalId || data?.animal || '').replace(/^anim_/i, '').trim().toLowerCase();
        const betAmt = Number(data?.amount) || 0;
        if (zooState.phase !== 'BETTING' || zooState.timeLeft <= 3 || betAmt <= 0) return;
        if (zooState.bets[rawAnimal]) {
            zooState.bets[rawAnimal].amount += betAmt;
            zooState.bets[rawAnimal].playerCount += 1;
        }
    });

    socket.on('admin_set_zoo_winner', (data) => {
        const raw = data?.animal ?? data?.animalId ?? data?.mode ?? data?.winner ?? 'AUTO';
        if (isAutoMode(raw)) {
            zooState.manualWinner = 'AUTO';
        } else {
            const clean = String(raw).replace(/^anim_/i, '').trim().toLowerCase();
            if (ANIMALS.some(a => a.id === clean)) {
                zooState.manualWinner = clean;
            }
        }
        emitAll('zoo_mode_update', { currentMode: zooState.manualWinner });
        emitAll('zoo_timer_update', {
            timeLeft: zooState.timeLeft,
            state: zooState.phase,
            roundId: zooState.roundId,
            bets: zooState.bets,
            currentMode: zooState.manualWinner,
            livePlayers: io.engine.clientsCount
        });
    });

    socket.on('seven_place_bet', (data) => {
        const rawChoice = String(data?.choice || data?.option || '').trim().toUpperCase();
        const choice = rawChoice === 'TWO_TO_SIX' ? 'DOWN' : (rawChoice === 'EIGHT_TO_TWELVE' ? 'UP' : rawChoice);
        const betAmt = Number(data?.amount) || 0;
        if (sevenState.phase !== 'BETTING' || betAmt <= 0) return;
        if (sevenState.bets[choice] !== undefined) {
            sevenState.bets[choice] += betAmt;
            emitAll('seven_timer_update', {
                timeLeft: sevenState.timeLeft,
                state: 'BETTING',
                roundId: sevenState.roundId,
                bets: sevenState.bets,
                currentMode: sevenState.manualWinner
            });
        }
    });

    socket.on('admin_set_seven_winner', (data) => {
        const raw = data?.choice ?? data?.option ?? data?.mode ?? data?.winner ?? 'AUTO';
        if (isAutoMode(raw)) {
            sevenState.manualWinner = 'AUTO';
        } else {
            const upper = String(raw).trim().toUpperCase();
            const mapped = upper === 'TWO_TO_SIX' ? 'DOWN' : (upper === 'EIGHT_TO_TWELVE' ? 'UP' : upper);
            if (['DOWN', 'SEVEN', 'UP'].includes(mapped)) {
                sevenState.manualWinner = mapped;
            }
        }
        emitAll('seven_timer_update', {
            timeLeft: sevenState.timeLeft,
            state: sevenState.phase,
            roundId: sevenState.roundId,
            bets: sevenState.bets,
            currentMode: sevenState.manualWinner
        });
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 AlfaOne Multi-Game Server Live on port ${PORT}`));
