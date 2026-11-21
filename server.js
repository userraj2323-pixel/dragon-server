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
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 60000
});

function emitAll(event, payload) {
    if (io.engine.clientsCount > 0) {
        io.emit(event, payload);
    }
}

// 1️⃣ DRAGON VS TIGER
let dvtState = {
    phase: 'BETTING', timeLeft: 20, cooldown: 0, roundStarted: false,
    roundId: Math.floor(100000 + Math.random() * 900000),
    bets: { DRAGON: 0, TIGER: 0, TIE: 0 }, userBets: [], manualWinner: null
};

function settleDVT() {
    dvtState.phase = 'CALCULATING';
    emitAll('timer_tick', { state: 'CALCULATING', timeLeft: 0, bets: dvtState.bets });
    let winner = dvtState.manualWinner;
    if (!winner || winner === 'AUTO') {
        const dPay = (dvtState.bets.DRAGON || 0) * 2;
        const tPay = (dvtState.bets.TIGER || 0) * 2;
        const tiePay = (dvtState.bets.TIE || 0) * 9;
        winner = (tiePay < dPay && tiePay < tPay && dvtState.bets.TIE > 0) ? 'TIE' : (dPay <= tPay ? 'DRAGON' : 'TIGER');
    }
    const dCard = winner === 'DRAGON' ? 13 : (winner === 'TIGER' ? 5 : 9);
    const tCard = winner === 'DRAGON' ? 7 : (winner === 'TIGER' ? 12 : 9);
    emitAll('round_result', { roundId: dvtState.roundId, winner, dCard, tCard });
    dvtState.phase = 'RESULT';
    dvtState.cooldown = 5;
}

function tickDVT() {
    if (dvtState.phase === 'RESULT') {
        if (--dvtState.cooldown > 0) return;
        dvtState.phase = 'BETTING'; dvtState.timeLeft = 20;
        dvtState.roundId = Math.floor(100000 + Math.random() * 900000);
        dvtState.bets = { DRAGON: 0, TIGER: 0, TIE: 0 }; dvtState.userBets = []; dvtState.roundStarted = true;
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

// 2️⃣ COLOR PREDICTION
let colorState = {
    phase: 'BETTING', roundId: Math.floor(100000 + Math.random() * 900000),
    timeLeft: 30, cooldown: 0, roundStarted: false,
    bets: { RED: { total: 0 }, GREEN: { total: 0 }, VIOLET: { total: 0 } },
    userBets: [], currentMode: 'AUTO'
};

function settleColor() {
    colorState.phase = 'CALCULATING';
    let winColor = colorState.currentMode;
    if (!winColor || winColor === 'AUTO') {
        const rPay = (colorState.bets.RED.total || 0) * 2;
        const gPay = (colorState.bets.GREEN.total || 0) * 2;
        const vPay = (colorState.bets.VIOLET.total || 0) * 4.5;
        winColor = (rPay <= gPay && rPay <= vPay) ? 'RED' : (gPay <= rPay && gPay <= vPay ? 'GREEN' : 'VIOLET');
    }
    emitAll('color_round_result', { roundId: String(colorState.roundId), winningColor: winColor });
    colorState.phase = 'RESULT';
    colorState.cooldown = 5;
}

function tickColor() {
    if (colorState.phase === 'RESULT') {
        if (--colorState.cooldown > 0) return;
        colorState.phase = 'BETTING'; colorState.timeLeft = 30;
        colorState.roundId = Math.floor(100000 + Math.random() * 900000);
        colorState.bets = { RED: { total: 0 }, GREEN: { total: 0 }, VIOLET: { total: 0 } };
        colorState.userBets = []; colorState.roundStarted = true;
    } else if (!colorState.roundStarted) {
        colorState.roundStarted = true;
    } else if (--colorState.timeLeft <= 0) {
        settleColor();
        return;
    }
    const tickPayload = { timeLeft: colorState.timeLeft, roundId: String(colorState.roundId), phase: colorState.phase };
    emitAll('admin_color_update', {
        roundId: colorState.roundId, timeLeft: colorState.timeLeft,
        liveUsers: io.engine.clientsCount, bets: colorState.bets, currentMode: colorState.currentMode
    });
    emitAll('color_timer_tick', tickPayload);
    emitAll('color_game_tick', tickPayload);
}

// 3️⃣ ZOO ROULETTE
const ANIMALS = [
    { id: 'swallow', multiplier: 6 }, { id: 'rabbit', multiplier: 6 },
    { id: 'monkey', multiplier: 8 }, { id: 'panda', multiplier: 8 },
    { id: 'peacock', multiplier: 8 }, { id: 'pigeon', multiplier: 8 },
    { id: 'eagle', multiplier: 12 }, { id: 'lion', multiplier: 12 },
    { id: 'silver_shark', multiplier: 24 }, { id: 'gold_shark', multiplier: 24 }
];
let zooState = {
    phase: 'BETTING', roundId: Math.floor(1000 + Math.random() * 9000),
    timeLeft: 15, cooldown: 0, roundStarted: false, bets: {}, userBets: [], manualWinner: 'AUTO'
};
function resetZoo() {
    zooState.bets = {}; zooState.userBets = [];
    ANIMALS.forEach(a => { zooState.bets[a.id] = { amount: 0, playerCount: 0 }; });
}
resetZoo();

function settleZoo() {
    zooState.phase = 'CALCULATING';
    let winAnimal = zooState.manualWinner;
    if (!winAnimal || winAnimal === 'AUTO') {
        let lowest = Infinity; winAnimal = ANIMALS[0].id;
        for (const a of ANIMALS) {
            const p = (zooState.bets[a.id]?.amount || 0) * a.multiplier;
            if (p < lowest) { lowest = p; winAnimal = a.id; }
        }
    }
    emitAll('zoo_round_result', { winningAnimal: winAnimal, roundId: zooState.roundId });
    zooState.phase = 'RESULT';
    zooState.cooldown = 6;
}

function tickZoo() {
    if (zooState.phase === 'RESULT') {
        if (--zooState.cooldown > 0) return;
        zooState.phase = 'BETTING'; zooState.timeLeft = 15;
        zooState.roundId = Math.floor(1000 + Math.random() * 9000);
        resetZoo(); zooState.roundStarted = true;
        emitAll('zoo_round_reset', { roundId: zooState.roundId, currentMode: zooState.manualWinner });
    } else if (!zooState.roundStarted) {
        zooState.roundStarted = true;
        emitAll('zoo_round_reset', { roundId: zooState.roundId, currentMode: zooState.manualWinner });
    } else if (--zooState.timeLeft <= 0) {
        settleZoo();
        return;
    }
    emitAll('zoo_timer_update', {
        timeLeft: zooState.timeLeft, state: 'BETTING', roundId: zooState.roundId,
        bets: zooState.bets, currentMode: zooState.manualWinner, livePlayers: io.engine.clientsCount
    });
}

// 4️⃣ 7 UP DOWN
let sevenState = {
    phase: 'BETTING', roundId: Math.floor(10000 + Math.random() * 90000),
    timeLeft: 15, cooldown: 0, roundStarted: false,
    bets: { DOWN: 0, SEVEN: 0, UP: 0 }, userBets: [], manualWinner: 'AUTO'
};

function settleSeven() {
    sevenState.phase = 'CALCULATING';
    let winner = sevenState.manualWinner;
    if (!winner || winner === 'AUTO') {
        const dPay = (sevenState.bets.DOWN || 0) * 2;
        const uPay = (sevenState.bets.UP || 0) * 2;
        const sPay = (sevenState.bets.SEVEN || 0) * 5;
        winner = (sPay < dPay && sPay < uPay && sevenState.bets.SEVEN > 0) ? 'SEVEN' : (dPay <= uPay ? 'DOWN' : 'UP');
    }
    emitAll('seven_round_result', { roundId: sevenState.roundId, winner });
    sevenState.phase = 'RESULT';
    sevenState.cooldown = 5;
}

function tickSeven() {
    if (sevenState.phase === 'RESULT') {
        if (--sevenState.cooldown > 0) return;
        sevenState.phase = 'BETTING'; sevenState.timeLeft = 15;
        sevenState.roundId = Math.floor(10000 + Math.random() * 90000);
        sevenState.bets = { DOWN: 0, SEVEN: 0, UP: 0 }; sevenState.userBets = []; sevenState.roundStarted = true;
    } else if (!sevenState.roundStarted) {
        sevenState.roundStarted = true;
    } else if (--sevenState.timeLeft <= 0) {
        settleSeven();
        return;
    }
    emitAll('seven_timer_update', {
        timeLeft: sevenState.timeLeft, roundId: sevenState.roundId,
        bets: sevenState.bets, currentMode: sevenState.manualWinner
    });
}

setInterval(() => { tickDVT(); tickColor(); tickZoo(); tickSeven(); }, 1000);

// 🔌 SOCKET EVENTS
io.on('connection', (socket) => {
    socket.on('join_admin', () => {
        socket.emit('admin_status_update', { manualWinner: dvtState.manualWinner, bets: dvtState.bets });
        socket.emit('admin_color_update', {
            roundId: colorState.roundId, timeLeft: colorState.timeLeft,
            liveUsers: io.engine.clientsCount, bets: colorState.bets, currentMode: colorState.currentMode
        });
        socket.emit('zoo_timer_update', {
            timeLeft: zooState.timeLeft, state: zooState.phase, roundId: zooState.roundId,
            bets: zooState.bets, currentMode: zooState.manualWinner, livePlayers: io.engine.clientsCount
        });
        socket.emit('seven_timer_update', {
            timeLeft: sevenState.timeLeft, roundId: sevenState.roundId,
            bets: sevenState.bets, currentMode: sevenState.manualWinner
        });
    });

    socket.on('join_color_game', () => {
        const tickPayload = { timeLeft: colorState.timeLeft, roundId: String(colorState.roundId), phase: colorState.phase };
        socket.emit('color_timer_tick', tickPayload);
        socket.emit('color_game_tick', tickPayload);
    });

    socket.on('place_bet', (data) => {
        const { bet_on, amount } = data || {};
        const betAmt = Number(amount) || 0;
        if (dvtState.phase !== 'BETTING' || betAmt <= 0) return;
        dvtState.bets[bet_on] = (dvtState.bets[bet_on] || 0) + betAmt;
        emitAll('bets_updated', dvtState.bets);
    });

    socket.on('admin_set_winner', (data) => {
        dvtState.manualWinner = data.winner === 'AUTO' ? null : data.winner;
        emitAll('admin_status_update', { manualWinner: dvtState.manualWinner, bets: dvtState.bets });
    });

    socket.on('color_place_bet', (data) => {
        const { color, amount } = data || {};
        const betAmt = Number(amount) || 0;
        if (colorState.phase !== 'BETTING' || colorState.timeLeft <= 5 || betAmt <= 0) return;
        if (colorState.bets[color]) colorState.bets[color].total += betAmt;
        emitAll('admin_color_update', {
            roundId: colorState.roundId, timeLeft: colorState.timeLeft,
            liveUsers: io.engine.clientsCount, bets: colorState.bets, currentMode: colorState.currentMode
        });
    });

    socket.on('admin_set_color_mode', (data) => {
        colorState.currentMode = data.mode;
        emitAll('admin_color_update', {
            roundId: colorState.roundId, timeLeft: colorState.timeLeft,
            liveUsers: io.engine.clientsCount, bets: colorState.bets, currentMode: colorState.currentMode
        });
    });

    socket.on('zoo_place_bet', (data) => {
        const { animalId, amount } = data || {};
        const betAmt = Number(amount) || 0;
        if (zooState.phase !== 'BETTING' || zooState.timeLeft <= 3 || betAmt <= 0) return;
        if (zooState.bets[animalId]) {
            zooState.bets[animalId].amount += betAmt;
            zooState.bets[animalId].playerCount += 1;
        }
    });

    socket.on('admin_set_zoo_winner', (data) => {
        zooState.manualWinner = data.animal;
        emitAll('zoo_mode_update', { currentMode: zooState.manualWinner });
    });

    socket.on('seven_place_bet', (data) => {
        const rawChoice = (data?.choice || data?.option || '').toUpperCase();
        const choice = rawChoice === 'TWO_TO_SIX' ? 'DOWN' : (rawChoice === 'EIGHT_TO_TWELVE' ? 'UP' : rawChoice);
        const betAmt = Number(data?.amount) || 0;
        if (sevenState.phase !== 'BETTING' || sevenState.timeLeft <= 3 || betAmt <= 0) return;
        if (sevenState.bets[choice] !== undefined) sevenState.bets[choice] += betAmt;
    });

    socket.on('admin_set_seven_winner', (data) => {
        sevenState.manualWinner = data.choice;
        emitAll('seven_timer_update', {
            timeLeft: sevenState.timeLeft, roundId: sevenState.roundId,
            bets: sevenState.bets, currentMode: sevenState.manualWinner
        });
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 AlfaOne Multi-Game Server Live on port ${PORT}`));
