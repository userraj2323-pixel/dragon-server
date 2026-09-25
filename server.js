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
// 🎨 1. COLOR PREDICTION GAME LOGIC
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
// 🐉 2. DRAGON VS TIGER GAME LOGIC
// ====================================================
let dtRoundId = Math.floor(1000 + Math.random() * 9000);
let dtTimer = 15;
let dtState = 'BETTING'; 
let dtManualWinner = null; 

let dtBets = {
  DRAGON: 0,
  TIGER: 0,
  TIE: 0
};

setInterval(() => {
  dtTimer--;

  if (dtState === 'BETTING') {
    if (dtTimer <= 0) {
      dtState = 'RESULT';
      dtTimer = 5; 

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
    dCard = Math.floor(Math.random() * 11) + 3;
    tCard = Math.floor(Math.random() * (dCard - 1)) + 1;
  } else if (winner === 'TIGER') {
    tCard = Math.floor(Math.random() * 11) + 3;
    dCard = Math.floor(Math.random() * (tCard - 1)) + 1;
  } else {
    const cardVal = Math.floor(Math.random() * 13) + 1;
    dCard = cardVal;
    tCard = cardVal;
  }

  return { dCard, tCard, winner };
}

// ====================================================
// 🦁 3. ZOO ROULETTE LOGIC (Auto-Profit + Force Control)
// ====================================================
const ZOO_ANIMALS = {
  swallow:      { id: "swallow",      multiplier: 6  },
  rabbit:       { id: "rabbit",       multiplier: 6  },
  monkey:       { id: "monkey",       multiplier: 8  },
  panda:        { id: "panda",        multiplier: 8  },
  peacock:      { id: "peacock",      multiplier: 8  },
  pigeon:       { id: "pigeon",       multiplier: 8  },
  eagle:        { id: "eagle",        multiplier: 12 },
  lion:         { id: "lion",         multiplier: 12 },
  silver_shark: { id: "silver_shark", multiplier: 24 },
  gold_shark:   { id: "gold_shark",   multiplier: 24 }
};

let zooRoundId = Math.floor(10000 + Math.random() * 90000);
let zooTimer = 15;
let zooState = 'BETTING'; // 'BETTING', 'SPINNING', 'SETTLING'
let zooManualWinner = null; 
let zooBets = {};

function initZooBets() {
  zooBets = {};
  for (let key in ZOO_ANIMALS) {
    zooBets[key] = 0;
  }
}
initZooBets();

// REST Endpoint: Force Winner
app.get("/admin/zoo/force/:animal", (req, res) => {
  const chosen = req.params.animal.toLowerCase();
  if (ZOO_ANIMALS[chosen]) {
    zooManualWinner = chosen;
    res.json({ success: true, message: `Zoo next winner set to: ${chosen}` });
  } else {
    res.status(400).json({ success: false, message: `Invalid animal. Choose from: ${Object.keys(ZOO_ANIMALS).join(', ')}` });
  }
});

// Auto-Profit Algorithm: Minimum payout to users
function calculateZooWinner() {
  if (zooManualWinner && ZOO_ANIMALS[zooManualWinner]) {
    const forced = zooManualWinner;
    zooManualWinner = null; // Single use override
    return forced;
  }

  let minPayout = Infinity;
  let candidates = [];

  for (let id in ZOO_ANIMALS) {
    const payout = (zooBets[id] || 0) * ZOO_ANIMALS[id].multiplier;
    if (payout < minPayout) {
      minPayout = payout;
      candidates = [id];
    } else if (payout === minPayout) {
      candidates.push(id);
    }
  }

  // Agar multiple animals ka payout same (ya 0) ho to unme se random pick
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Zoo Game Loop (Independent 1s ticker)
setInterval(() => {
  zooTimer--;

  if (zooState === 'BETTING') {
    if (zooTimer <= 0) {
      zooState = 'SPINNING';
      zooTimer = 8; // Wheel spinning duration

      const winningAnimal = calculateZooWinner();

      io.emit('zoo_round_result', {
        roundId: zooRoundId,
        winner: winningAnimal,
        multiplier: ZOO_ANIMALS[winningAnimal].multiplier
      });
    } else {
      io.emit('zoo_timer_update', {
        roundId: zooRoundId,
        timeLeft: zooTimer,
        state: 'BETTING',
        bets: zooBets
      });
    }
  } else if (zooState === 'SPINNING') {
    if (zooTimer <= 0) {
      zooState = 'SETTLING';
      zooTimer = 3; // Win celebration display
    }
  } else if (zooState === 'SETTLING') {
    if (zooTimer <= 0) {
      zooState = 'BETTING';
      zooTimer = 15;
      zooRoundId = Math.floor(10000 + Math.random() * 90000);
      initZooBets();

      io.emit('zoo_round_reset', {
        roundId: zooRoundId,
        timeLeft: zooTimer
      });
    }
  }
}, 1000);

// ====================================================
// 🔌 4. UNIFIED SOCKET DISPATCHER
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

  // --- Zoo Roulette Handlers ---
  socket.emit('zoo_timer_update', {
    roundId: zooRoundId,
    timeLeft: zooTimer,
    state: zooState,
    bets: zooBets
  });

  socket.on('place_zoo_bet', ({ animal, amount }) => {
    if (zooState !== 'BETTING' || zooTimer <= 1) return;
    if (zooBets[animal] !== undefined) {
      zooBets[animal] += Number(amount);
      io.emit('zoo_bets_updated', zooBets);
    }
  });

  socket.on('admin_set_zoo_winner', ({ animal }) => {
    const chosen = (animal || '').toLowerCase();
    if (ZOO_ANIMALS[chosen]) {
      zooManualWinner = chosen;
    } else if (animal === 'AUTO') {
      zooManualWinner = null;
    }
  });

  socket.on('disconnect', () => {
    liveUsers = Math.max(0, liveUsers - 1);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Unified Master Server running on port ${PORT}`));
