const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const db = require('./ledger_db');
const walletRouter = require('./wallet');
const authRouter = require('./auth');
const supabase = require('./supabase');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.use('/api/auth', authRouter);
app.use('/api/wallet', walletRouter);

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/', (req, res) => {
    res.send('👑 AlfaOne Real Money Multi-Game Engine Running');
});

const server = http.createServer(app);
const io = require('socket.io')(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 60000
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_UUID = '11111111-1111-1111-1111-111111111111';

function emitAll(event, payload) {
    if (io.engine.clientsCount > 0) {
        io.emit(event, payload);
    }
}

// ==========================================
// 💳 CENTRAL SUPABASE WALLET ENGINE (STRICT)
// ==========================================
async function resolveRealUserId(rawUserId) {
    if (!rawUserId || typeof rawUserId !== 'string') return null;
    const trimmed = rawUserId.trim();
    if (!trimmed || trimmed.toUpperCase().includes('GUEST') || trimmed === DEFAULT_UUID) {
        return null;
    }
    if (UUID_REGEX.test(trimmed)) {
        return trimmed;
    }
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 10) {
        const phone = digits.slice(-10);
        const { data } = await supabase
            .from('users')
            .select('id')
            .eq('phone', phone)
            .maybeSingle();
        if (data && data.id) return data.id;
    }
    return null;
}

async function deductWalletBalance(rawUserId, amount) {
    const betAmt = Number(amount);
    if (!Number.isFinite(betAmt) || betAmt <= 0) {
        return { success: false, message: 'Invalid bet amount' };
    }

    const userId = await resolveRealUserId(rawUserId);
    if (!userId) {
        return { success: false, message: 'Session expired. Kripya dobara login karein.' };
    }

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('id, wallet_balance')
            .eq('id', userId)
            .maybeSingle();

        if (error || !user) return { success: false, message: 'User not found in database' };
        const currentBal = Number(user.wallet_balance || 0);
        if (currentBal < betAmt) {
            return { success: false, message: 'Insufficient wallet balance' };
        }

        const newBal = Number((currentBal - betAmt).toFixed(2));
        const { data: updated, error: updateErr } = await supabase
            .from('users')
            .update({ wallet_balance: newBal })
            .eq('id', userId)
            .select('id, wallet_balance')
            .single();

        if (updateErr || !updated) return { success: false, message: 'Balance deduction failed' };
        return { success: true, userId, balance: Number(updated.wallet_balance || 0) };
    } catch (e) {
        console.error('Wallet deduct error:', e.message);
        return { success: false, message: 'Server error while deducting balance' };
    }
}

async function creditWalletBalance(rawUserId, amount) {
    const winAmt = Number(amount);
    if (!Number.isFinite(winAmt) || winAmt <= 0) return null;

    const userId = await resolveRealUserId(rawUserId);
    if (!userId) return null;

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('id, wallet_balance')
            .eq('id', userId)
            .maybeSingle();

        if (error || !user) return null;

        const newBal = Number((Number(user.wallet_balance || 0) + winAmt).toFixed(2));
        const { data: updated, error: updateErr } = await supabase
            .from('users')
            .update({ wallet_balance: newBal })
            .eq('id', userId)
            .select('id, wallet_balance')
            .single();

        if (updateErr || !updated) return null;
        return { userId, balance: Number(updated.wallet_balance || 0) };
    } catch (e) {
        console.error('Wallet credit error:', e.message);
        return null;
    }
}

async function recordTurnover(userId, amount) {
    try {
        if (walletRouter.recordBetTurnover) {
            await walletRouter.recordBetTurnover(userId, amount);
        }
    } catch (err) {
        console.error('Failed to record bet turnover:', err.message);
    }
}

// ==========================================
// 1️⃣ GAME: DRAGON VS TIGER STATE & LOGIC
// ==========================================
let dvtState = {
    phase: 'BETTING',
    timeLeft: 20,
    cooldown: 0,
    roundStarted: false,
    isSettling: false,
    roundId: Math.floor(100000 + Math.random() * 900000),
    bets: { DRAGON: 0, TIGER: 0, TIE: 0 },
    userBets: [],
    manualWinner: null
};

async function settleDVT() {
    dvtState.isSettling = true;
    dvtState.phase = 'CALCULATING';
    emitAll('timer_tick', { state: 'CALCULATING', timeLeft: 0, bets: dvtState.bets });

    try {
        let winner = dvtState.manualWinner;
        if (!winner || winner === 'AUTO') {
            const dPayout = (dvtState.bets.DRAGON || 0) * 2;
            const tPayout = (dvtState.bets.TIGER || 0) * 2;
            const tiePayout = (dvtState.bets.TIE || 0) * 9;

            if (tiePayout < dPayout && tiePayout < tPayout && (dvtState.bets.TIE || 0) > 0) {
                winner = 'TIE';
            } else if (dPayout <= tPayout) {
                winner = 'DRAGON';
            } else {
                winner = 'TIGER';
            }
        }

        const dCard = winner === 'DRAGON' ? 13 : (winner === 'TIGER' ? 5 : 9);
        const tCard = winner === 'DRAGON' ? 7 : (winner === 'TIGER' ? 12 : 9);

        const mult = winner === 'TIE' ? 9 : 2;
        for (const b of dvtState.userBets) {
            if (b.bet_on === winner && b.userId) {
                const winAmt = b.amount * mult;
                const credited = await creditWalletBalance(b.userId, winAmt);
                io.to(b.socketId).emit('bet_won', {
                    userId: b.userId,
                    amount: winAmt,
                    winner,
                    balance: credited ? credited.balance : undefined
                });
                if (credited) {
                    io.to(b.socketId).emit('wallet_updated', { userId: credited.userId, balance: credited.balance });
                }
            }
        }

        emitAll('round_result', { roundId: dvtState.roundId, winner, dCard, tCard });
    } catch (err) {
        console.error('DVT settle error:', err.message);
    } finally {
        dvtState.phase = 'RESULT';
        dvtState.cooldown = 5;
        dvtState.isSettling = false;
    }
}

function tickDVT() {
    if (dvtState.isSettling) return;

    if (dvtState.phase === 'RESULT') {
        dvtState.cooldown -= 1;
        if (dvtState.cooldown > 0) return;

        dvtState.phase = 'BETTING';
        dvtState.timeLeft = 20;
        dvtState.roundId = Math.floor(100000 + Math.random() * 900000);
        dvtState.bets = { DRAGON: 0, TIGER: 0, TIE: 0 };
        dvtState.userBets = [];
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

    dvtState.timeLeft -= 1;
    if (dvtState.timeLeft > 0) {
        emitAll('timer_tick', { state: 'BETTING', timeLeft: dvtState.timeLeft, bets: dvtState.bets });
    } else {
        settleDVT();
    }
}

// ==========================================
// 2️⃣ GAME: COLOR PREDICTION STATE & LOGIC
// ==========================================
let colorState = {
    phase: 'BETTING',
    roundId: Math.floor(100000 + Math.random() * 900000),
    timeLeft: 30,
    cooldown: 0,
    roundStarted: false,
    isSettling: false,
    bets: {
        RED: { total: 0 },
        GREEN: { total: 0 },
        VIOLET: { total: 0 }
    },
    userBets: [],
    currentMode: 'AUTO'
};

async function settleColor() {
    colorState.isSettling = true;
    colorState.phase = 'CALCULATING';

    try {
        let winColor = colorState.currentMode;
        if (!winColor || winColor === 'AUTO') {
            const redPayout = (colorState.bets.RED.total || 0) * 2;
            const greenPayout = (colorState.bets.GREEN.total || 0) * 2;
            const violetPayout = (colorState.bets.VIOLET.total || 0) * 4.5;

            if (redPayout <= greenPayout && redPayout <= violetPayout) {
                winColor = 'RED';
            } else if (greenPayout <= redPayout && greenPayout <= violetPayout) {
                winColor = 'GREEN';
            } else {
                winColor = 'VIOLET';
            }
        }

        const mult = winColor === 'VIOLET' ? 4.5 : 2;
        for (const b of colorState.userBets) {
            if (b.color === winColor && b.userId) {
                const winAmt = b.amount * mult;
                const credited = await creditWalletBalance(b.userId, winAmt);
                io.to(b.socketId).emit('color_bet_won', {
                    userId: b.userId,
                    amount: winAmt,
                    color: winColor,
                    balance: credited ? credited.balance : undefined
                });
                if (credited) {
                    io.to(b.socketId).emit('wallet_updated', { userId: credited.userId, balance: credited.balance });
                }
            }
        }

        emitAll('color_round_result', {
            roundId: String(colorState.roundId),
            winningColor: winColor
        });
    } catch (err) {
        console.error('Color settle error:', err.message);
    } finally {
        colorState.phase = 'RESULT';
        colorState.cooldown = 5;
        colorState.isSettling = false;
    }
}

function tickColor() {
    if (colorState.isSettling) return;

    if (colorState.phase === 'RESULT') {
        colorState.cooldown -= 1;
        if (colorState.cooldown > 0) return;

        colorState.phase = 'BETTING';
        colorState.timeLeft = 30;
        colorState.roundId = Math.floor(100000 + Math.random() * 900000);
        colorState.bets = { RED: { total: 0 }, GREEN: { total: 0 }, VIOLET: { total: 0 } };
        colorState.userBets = [];
        colorState.roundStarted = true;
    } else if (!colorState.roundStarted) {
        colorState.roundStarted = true;
    } else {
        colorState.timeLeft -= 1;
        if (colorState.timeLeft <= 0) {
            settleColor();
            return;
        }
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
// 3️⃣ GAME: ZOO ROULETTE STATE & LOGIC
// ==========================================
const ANIMALS = [
    { id: 'swallow', multiplier: 6 },
    { id: 'rabbit', multiplier: 6 },
    { id: 'monkey', multiplier: 8 },
    { id: 'panda', multiplier: 8 },
    { id: 'peacock', multiplier: 8 },
    { id: 'pigeon', multiplier: 8 },
    { id: 'eagle', multiplier: 12 },
    { id: 'lion', multiplier: 12 },
    { id: 'silver_shark', multiplier: 24 },
    { id: 'gold_shark', multiplier: 24 }
];

let zooState = {
    phase: 'BETTING',
    roundId: Math.floor(1000 + Math.random() * 9000),
    timeLeft: 15,
    cooldown: 0,
    roundStarted: false,
    isSettling: false,
    bets: {},
    userBets: [],
    manualWinner: 'AUTO'
};

function resetZoo() {
    zooState.bets = {};
    zooState.userBets = [];
    ANIMALS.forEach(a => { zooState.bets[a.id] = { amount: 0, playerCount: 0 }; });
}
resetZoo();

async function settleZoo() {
    zooState.isSettling = true;
    zooState.phase = 'CALCULATING';

    try {
        let winAnimal = zooState.manualWinner;
        if (!winAnimal || winAnimal === 'AUTO') {
            let lowestPayout = Infinity;
            winAnimal = ANIMALS[0].id;
            for (const a of ANIMALS) {
                const payout = (zooState.bets[a.id]?.amount || 0) * a.multiplier;
                if (payout < lowestPayout) {
                    lowestPayout = payout;
                    winAnimal = a.id;
                }
            }
        }

        const matchedAnimal = ANIMALS.find(a => a.id === winAnimal);
        const mult = matchedAnimal ? matchedAnimal.multiplier : 6;
        for (const b of zooState.userBets) {
            if (b.animalId === winAnimal && b.userId) {
                const winAmt = b.amount * mult;
                const credited = await creditWalletBalance(b.userId, winAmt);
                io.to(b.socketId).emit('zoo_bet_won', {
                    userId: b.userId,
                    amount: winAmt,
                    animal: winAnimal,
                    balance: credited ? credited.balance : undefined
                });
                if (credited) {
                    io.to(b.socketId).emit('wallet_updated', { userId: credited.userId, balance: credited.balance });
                }
            }
        }

        emitAll('zoo_round_result', { winningAnimal: winAnimal, roundId: zooState.roundId });
    } catch (err) {
        console.error('Zoo settle error:', err.message);
    } finally {
        zooState.phase = 'RESULT';
        zooState.cooldown = 6;
        zooState.isSettling = false;
    }
}

function tickZoo() {
    if (zooState.isSettling) return;

    if (zooState.phase === 'RESULT') {
        zooState.cooldown -= 1;
        if (zooState.cooldown > 0) return;

        zooState.phase = 'BETTING';
        zooState.timeLeft = 15;
        zooState.roundId = Math.floor(1000 + Math.random() * 9000);
        resetZoo();
        zooState.roundStarted = true;
        emitAll('zoo_round_reset', { roundId: zooState.roundId, currentMode: zooState.manualWinner });
    } else if (!zooState.roundStarted) {
        zooState.roundStarted = true;
        emitAll('zoo_round_reset', { roundId: zooState.roundId, currentMode: zooState.manualWinner });
    } else {
        zooState.timeLeft -= 1;
        if (zooState.timeLeft <= 0) {
            settleZoo();
            return;
        }
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
// 4️⃣ GAME: 7 UP DOWN STATE & LOGIC
// ==========================================
let sevenState = {
    phase: 'BETTING',
    roundId: Math.floor(10000 + Math.random() * 90000),
    timeLeft: 15,
    cooldown: 0,
    roundStarted: false,
    isSettling: false,
    bets: { DOWN: 0, SEVEN: 0, UP: 0 },
    userBets: [],
    manualWinner: 'AUTO'
};

async function settleSeven() {
    sevenState.isSettling = true;
    sevenState.phase = 'CALCULATING';

    try {
        let winner = sevenState.manualWinner;
        if (!winner || winner === 'AUTO') {
            const downPay = (sevenState.bets.DOWN || 0) * 2;
            const upPay = (sevenState.bets.UP || 0) * 2;
            const sevenPay = (sevenState.bets.SEVEN || 0) * 5;

            if (sevenPay < downPay && sevenPay < upPay && (sevenState.bets.SEVEN || 0) > 0) {
                winner = 'SEVEN';
            } else if (downPay <= upPay) {
                winner = 'DOWN';
            } else {
                winner = 'UP';
            }
        }

        const mult = winner === 'SEVEN' ? 5 : 2;
        for (const b of sevenState.userBets) {
            if (b.choice === winner && b.userId) {
                const winAmt = b.amount * mult;
                const credited = await creditWalletBalance(b.userId, winAmt);
                io.to(b.socketId).emit('seven_bet_won', {
                    userId: b.userId,
                    amount: winAmt,
                    winner,
                    balance: credited ? credited.balance : undefined
                });
                if (credited) {
                    io.to(b.socketId).emit('wallet_updated', { userId: credited.userId, balance: credited.balance });
                }
            }
        }

        emitAll('seven_round_result', { roundId: sevenState.roundId, winner });
    } catch (err) {
        console.error('7 Up Down settle error:', err.message);
    } finally {
        sevenState.phase = 'RESULT';
        sevenState.cooldown = 5;
        sevenState.isSettling = false;
    }
}

function tickSeven() {
    if (sevenState.isSettling) return;

    if (sevenState.phase === 'RESULT') {
        sevenState.cooldown -= 1;
        if (sevenState.cooldown > 0) return;

        sevenState.phase = 'BETTING';
        sevenState.timeLeft = 15;
        sevenState.roundId = Math.floor(10000 + Math.random() * 90000);
        sevenState.bets = { DOWN: 0, SEVEN: 0, UP: 0 };
        sevenState.userBets = [];
        sevenState.roundStarted = true;
    } else if (!sevenState.roundStarted) {
        sevenState.roundStarted = true;
    } else {
        sevenState.timeLeft -= 1;
        if (sevenState.timeLeft <= 0) {
            settleSeven();
            return;
        }
    }

    emitAll('seven_timer_update', {
        timeLeft: sevenState.timeLeft,
        roundId: sevenState.roundId,
        bets: sevenState.bets,
        currentMode: sevenState.manualWinner
    });
}

// ==========================================
// ⏱️ UNIFIED MASTER GAME LOOP (1 TICK / SEC)
// ==========================================
function startMasterGameLoop() {
    setInterval(() => {
        tickDVT();
        tickColor();
        tickZoo();
        tickSeven();
    }, 1000);
}

// ==========================================
// 🔌 UNIFIED SOCKET EVENT LISTENERS
// ==========================================
io.on('connection', (socket) => {

    // ADMIN JOIN
    socket.on('join_admin', () => {
        socket.emit('admin_status_update', {
            manualWinner: dvtState.manualWinner,
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
            roundId: sevenState.roundId,
            bets: sevenState.bets,
            currentMode: sevenState.manualWinner
        });
    });

    // COLOR GAME JOIN (instant sync)
    socket.on('join_color_game', () => {
        const tickPayload = {
            timeLeft: colorState.timeLeft,
            roundId: String(colorState.roundId),
            phase: colorState.phase
        };
        socket.emit('color_timer_tick', tickPayload);
        socket.emit('color_game_tick', tickPayload);
    });

    // 🐉 1. DRAGON TIGER BET
    socket.on('place_bet', async (data) => {
        const { bet_on, amount, userId } = data || {};
        const betAmt = Number(amount) || 0;
        if (dvtState.phase !== 'BETTING') return socket.emit('bet_error', { message: 'Betting closed' });

        const res = await deductWalletBalance(userId, betAmt);
        if (!res.success) return socket.emit('bet_error', { message: res.message });

        socket.emit('wallet_updated', { userId: res.userId, balance: res.balance });
        await recordTurnover(res.userId, betAmt);

        dvtState.bets[bet_on] = (dvtState.bets[bet_on] || 0) + betAmt;
        dvtState.userBets.push({ socketId: socket.id, userId: res.userId, bet_on, amount: betAmt });
        emitAll('bets_updated', dvtState.bets);
    });

    socket.on('admin_set_winner', (data) => {
        dvtState.manualWinner = data.winner === 'AUTO' ? null : data.winner;
        emitAll('admin_status_update', { manualWinner: dvtState.manualWinner, bets: dvtState.bets });
    });

    // 🎨 2. COLOR PREDICTION BET
    socket.on('color_place_bet', async (data) => {
        const { color, amount, userId } = data || {};
        const betAmt = Number(amount) || 0;
        if (colorState.phase !== 'BETTING' || colorState.timeLeft <= 5) {
            return socket.emit('bet_error', { message: 'Betting closed for this round' });
        }

        const res = await deductWalletBalance(userId, betAmt);
        if (!res.success) return socket.emit('bet_error', { message: res.message });

        socket.emit('wallet_updated', { userId: res.userId, balance: res.balance });
        socket.emit('color_bet_accepted', {
            userId: res.userId,
            color,
            amount: betAmt,
            balance: res.balance,
            roundId: String(colorState.roundId)
        });
        await recordTurnover(res.userId, betAmt);

        if (colorState.bets[color]) colorState.bets[color].total += betAmt;
        colorState.userBets.push({ socketId: socket.id, userId: res.userId, color, amount: betAmt });
        emitAll('admin_color_update', {
            roundId: colorState.roundId,
            timeLeft: colorState.timeLeft,
            liveUsers: io.engine.clientsCount,
            bets: colorState.bets,
            currentMode: colorState.currentMode
        });
    });

    socket.on('admin_set_color_mode', (data) => {
        colorState.currentMode = data.mode;
        emitAll('admin_color_update', {
            roundId: colorState.roundId,
            timeLeft: colorState.timeLeft,
            liveUsers: io.engine.clientsCount,
            bets: colorState.bets,
            currentMode: colorState.currentMode
        });
    });

    // 🦁 3. ZOO ROULETTE BET
    socket.on('zoo_place_bet', async (data) => {
        const { animalId, amount, userId } = data || {};
        const betAmt = Number(amount) || 0;
        if (zooState.phase !== 'BETTING' || zooState.timeLeft <= 3) {
            return socket.emit('bet_error', { message: 'Betting closed' });
        }

        const res = await deductWalletBalance(userId, betAmt);
        if (!res.success) return socket.emit('bet_error', { message: res.message });

        socket.emit('wallet_updated', { userId: res.userId, balance: res.balance });
        await recordTurnover(res.userId, betAmt);

        if (zooState.bets[animalId]) {
            zooState.bets[animalId].amount += betAmt;
            zooState.bets[animalId].playerCount += 1;
        }
        zooState.userBets.push({ socketId: socket.id, userId: res.userId, animalId, amount: betAmt });
    });

    socket.on('admin_set_zoo_winner', (data) => {
        zooState.manualWinner = data.animal;
        emitAll('zoo_mode_update', { currentMode: zooState.manualWinner });
    });

    // 🎲 4. 7 UP DOWN BET
    socket.on('seven_place_bet', async (data) => {
        const rawChoice = (data?.choice || data?.option || '').toUpperCase();
        const choice = rawChoice === 'TWO_TO_SIX' ? 'DOWN' : (rawChoice === 'EIGHT_TO_TWELVE' ? 'UP' : rawChoice);
        const betAmt = Number(data?.amount) || 0;
        if (sevenState.phase !== 'BETTING' || sevenState.timeLeft <= 3) {
            return socket.emit('bet_error', { message: 'Betting closed' });
        }

        const res = await deductWalletBalance(data?.userId, betAmt);
        if (!res.success) return socket.emit('bet_error', { message: res.message });

        socket.emit('wallet_updated', { userId: res.userId, balance: res.balance });
        await recordTurnover(res.userId, betAmt);

        if (sevenState.bets[choice] !== undefined) sevenState.bets[choice] += betAmt;
        sevenState.userBets.push({ socketId: socket.id, userId: res.userId, choice, amount: betAmt });
    });

    socket.on('admin_set_seven_winner', (data) => {
        sevenState.manualWinner = data.choice;
        emitAll('seven_timer_update', {
            timeLeft: sevenState.timeLeft,
            roundId: sevenState.roundId,
            bets: sevenState.bets,
            currentMode: sevenState.manualWinner
        });
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 AlfaOne Multi-Game Real Money Server Live on port ${PORT}`);
    console.log(`👑 Admin Dashboard: http://localhost:${PORT}/admin`);
    startMasterGameLoop();
});
