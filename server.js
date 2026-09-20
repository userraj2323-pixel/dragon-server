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

// ==========================================
// 🎨 COLOR PREDICTION GAME LOGIC
// ==========================================
let colorTimer = 30;
let colorRoundId = "DA-" + Math.floor(100000 + Math.random() * 900000);

// Admin Mode: 'AUTO', 'RED', 'GREEN', ya 'VIOLET' (hamesha bana rahega jab tak badle na)
let currentMode = 'AUTO'; 

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

    // Naya Round shuru
    colorTimer = 30;
    colorRoundId = "DA-" + Math.floor(100000 + Math.random() * 900000);
    colorBets = {
      RED: { total: 0, users: 0 },
      GREEN: { total: 0, users: 0 },
      VIOLET: { total: 0, users: 0 }
    };
    // currentMode ko reset NAHI kiya hai - ye continuous wahi rahega!
  }

  // Users ko tick bhejna
  io.to('room_color_game').emit('color_game_tick', {
    roundId: colorRoundId,
    timeLeft: colorTimer,
    bettingOpen: colorTimer > 5
  });

  // Admin Panel ko tick aur active mode bhejna
  io.to('admin_room').emit('admin_color_update', {
    roundId: colorRoundId,
    timeLeft: colorTimer,
    liveUsers: liveUsers,
    bets: colorBets,
    currentMode: currentMode
  });

}, 1000);

async function declareColorResult() {
  let winner = null;

  if (currentMode !== 'AUTO') {
    winner = currentMode; // Admin ki persistent choice
  } else {
    // Auto-profit: Sabse kam bet wala jitega
    const colors = ['RED', 'GREEN', 'VIOLET'];
    colors.sort((a, b) => colorBets[a].total - colorBets[b].total);
    winner = colors[0];
  }

  io.to('room_color_game').emit('color_round_result', {
    roundId: colorRoundId,
    winningColor: winner
  });

  // Supabase Save
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

// ==========================================
// 🔌 SOCKET CONNECTIONS
// ==========================================
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';

io.on('connection', (socket) => {
  liveUsers++;

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
        currentMode: currentMode
      });
    }
  });

  // Admin Mode Set karna ('AUTO', 'RED', 'GREEN', 'VIOLET')
  socket.on('admin_set_color_mode', ({ secret, mode }) => {
    if (secret === ADMIN_SECRET || secret === 'admin123') {
      currentMode = mode;
      console.log("Admin switched mode to:", currentMode);
      
      io.to('admin_room').emit('admin_color_update', {
        roundId: colorRoundId,
        timeLeft: colorTimer,
        liveUsers: liveUsers,
        bets: colorBets,
        currentMode: currentMode
      });
    }
  });

  socket.on('disconnect', () => {
    liveUsers = Math.max(0, liveUsers - 1);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server live on port ${PORT}`));
