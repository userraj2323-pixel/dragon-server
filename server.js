const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  next();
});

app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====================================================
// 🎨 1. COLOR PREDICTION GAME LOGIC (For Android & Admin)
// ====================================================
let colorTimer = 30;
let colorRoundId = "DA-" + Math.floor(100000 + Math.random() * 900000);
let currentColorMode = 'AUTO'; 

let colorBets = {
  RED: { total: 0, users: 0 },
  GREEN: { total: 0, users: 0 },
  VIOLET: { total: 0, users: 0 }
};

let liveUsers = 0;

setInterval(async () => {
  colorTimer--;

  if (colorTimer <= 0) {
    await declareColorResult();

    colorTimer = 30;
    colorRoundId = "DA-" + Math.floor(100000 + Math.random() * 900000);
    colorBets = {
      RED: { total: 0, users: 0 },
      GREEN: { total: 0, users: 0 },
      VIOLET: { total: 0, users: 0 }
    };
  }

  io.to('room_color_game').emit('color_game_tick', {
    roundId: colorRoundId,
    timeLeft: colorTimer,
    bettingOpen: colorTimer > 5
  });

  io.to('admin_room').emit('admin_color_update', {
    roundId: colorRoundId,
    timeLeft: colorTimer,
    liveUsers: liveUsers,
    bets: colorBets,
    currentMode: currentColorMode
  });

}, 1000);

async function declareColorResult() {
  let winner = null;

  if (currentColorMode !== 'AUTO') {
    winner = currentColorMode;
  } else {
    const colors = ['RED', 'GREEN', 'VIOLET'];
    colors.sort((a, b) => colorBets[a].total - colorBets[b].total);
    winner = colors[0];
  }

  io.to('room_color_game').emit('color_round_result', {
    roundId: colorRoundId,
    winningColor: winner
  });

  const supabaseUrl = process.env.SUPABASE_URL || 'https://olmvohfxwzrmktdkxqms.supabase.co';
  const supabaseKey = process.env.SUPABASE_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/color_rounds`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify([{
          round_id: colorRoundId,
          winning_color: winner,
          total_red: colorBets.RED.total,
          total_green: colorBets.GREEN.total,
          total_violet: colorBets.VIOLET.total
        }])
      });
    } catch (err) {
      console.error("Supabase Save Error:", err.message);
    }
  }
}

// ====================================================
// 🐉 2. DRAGON VS TIGER GAME LOGIC (For game.html)
// ====================================================
let dtRoundId = Math.floor(1000 + Math.random() * 9000);
let dtTimer = 15;
let dtState = 'BETTING'; // 'BETTING' or 'RESULT'
let dtManualWinner = null; // 'DRAGON', 'TIGER', 'TIE', or null (AUTO)

let dtBets = {
  DRAGON: 0,
  TIGER: 0,
  TIE: 0
};

setInterval(() => {
  dtTimer--;

  if (dtState === 'BETTING') {
    if (dtTimer <= 0) {
      // Result Declare Phase
      dtState = 'RESULT';
      dtTimer = 5; // 5 seconds result screen display

      const result = calculateDragonTigerResult();

      io.emit('round_result', {
        dCard: result.dCard,
        tCard: result.tCard,
        winner: result.winner
      });
    } else {
      io.emit('timer_tick', {
        state: 'BETTING',
        timeLeft: dtTimer,
        bets: dtBets
      });
    }
  } else if (dtState === 'RESULT') {
    if (dtTimer <= 0) {
      // New Round Start
      dtState = 'BETTING';
      dtTimer = 15;
      dtRoundId = Math.floor(1000 + Math.random() * 9000);
      dtBets = { DRAGON: 0, TIGER: 0, TIE: 0 };

      io.emit('round_start', {
        roundId: dtRoundId,
        manualWinner: dtManualWinner
      });
    }
  }
}, 1000);

function calculateDragonTigerResult() {
  let winner = dtManualWinner;

  // Auto-profit: Jis taraf sabse kam bet lagi ho wo jitega
  if (!winner || winner === 'AUTO') {
    if (dtBets.DRAGON < dtBets.TIGER) {
      winner = 'DRAGON';
    } else if (dtBets.TIGER < dtBets.DRAGON) {
      winner = 'TIGER';
    } else {
      winner = Math.random() > 0.5 ? 'DRAGON' : 'TIGER';
    }
  }

  let dCard = 1, tCard = 1;

  if (winner === 'DRAGON') {
    dCard = Math.floor(Math.random() * 11) + 3; // 3 to 13
    tCard = Math.floor(Math.random() * (dCard - 1)) + 1; // less than dCard
  } else if (winner === 'TIGER') {
    tCard = Math.floor(Math.random() * 11) + 3; // 3 to 13
    dCard = Math.floor(Math.random() * (tCard - 1)) + 1; // less than tCard
  } else {
    // TIE
    const cardVal = Math.floor(Math.random() * 13) + 1;
    dCard = cardVal;
    tCard = cardVal;
  }

  return { dCard, tCard, winner };
}

// ====================================================
// 🔌 3. UNIFIED SOCKET CONNECTIONS
// ====================================================
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';

io.on('connection', (socket) => {
  liveUsers++;

  // --- Dragon Tiger Handlers ---
  socket.emit('admin_status_update', {
    manualWinner: dtManualWinner,
    bets: dtBets
  });

  socket.on('place_bet', ({ bet_on, amount }) => {
    if (dtState !== 'BETTING' || dtTimer <= 1) return;
    if (dtBets[bet_on] !== undefined) {
      dtBets[bet_on] += Number(amount);
      io.emit('bets_updated', dtBets);
    }
  });

  socket.on('admin_set_winner', ({ winner }) => {
    dtManualWinner = (winner === 'AUTO') ? null : winner;
    io.emit('admin_status_update', {
      manualWinner: dtManualWinner,
      bets: dtBets
    });
  });

  // --- Color Game Handlers ---
  socket.on('join_color_game', () => {
    socket.join('room_color_game');
  });

  socket.on('place_color_bet', ({ color, amount }) => {
    if (colorTimer <= 5) return;
    if (colorBets[color]) {
      colorBets[color].total += Number(amount);
      colorBets[color].users += 1;
    }
  });

  socket.on('join_admin', (secret) => {
    if (secret === ADMIN_SECRET || secret === 'admin123') {
      socket.join('admin_room');
      socket.emit('admin_color_update', {
        roundId: colorRoundId,
        timeLeft: colorTimer,
        liveUsers: liveUsers,
        bets: colorBets,
        currentMode: currentColorMode
      });
    }
  });

  socket.on('admin_set_color_mode', ({ secret, mode }) => {
    if (secret === ADMIN_SECRET || secret === 'admin123') {
      currentColorMode = mode;
      io.to('admin_room').emit('admin_color_update', {
        roundId: colorRoundId,
        timeLeft: colorTimer,
        liveUsers: liveUsers,
        bets: colorBets,
        currentMode: currentColorMode
      });
    }
  });

  socket.on('disconnect', () => {
    liveUsers = Math.max(0, liveUsers - 1);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Master Server running on port ${PORT}`));
