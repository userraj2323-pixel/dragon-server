const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

// CORS allow karna
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  next();
});

app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// ==========================================
// 🎨 COLOR PREDICTION GAME LOGIC
// ==========================================
let colorTimer = 30;
let colorRoundId = "DA-" + Math.floor(100000 + Math.random() * 900000);
let manualColorResult = null; // Admin choice

let colorBets = {
  RED: { total: 0, users: 0 },
  GREEN: { total: 0, users: 0 },
  VIOLET: { total: 0, users: 0 }
};

let liveUsers = 0;

// Har second chalne wala loop
setInterval(async () => {
  colorTimer--;

  // 30 seconds khatam: Result declare
  if (colorTimer <= 0) {
    await declareColorResult();

    // Naya Round Reset
    colorTimer = 30;
    colorRoundId = "DA-" + Math.floor(100000 + Math.random() * 900000);
    colorBets = {
      RED: { total: 0, users: 0 },
      GREEN: { total: 0, users: 0 },
      VIOLET: { total: 0, users: 0 }
    };
    manualColorResult = null;
  }

  // Live countdown aur status send karna
  io.to('room_color_game').emit('color_game_tick', {
    roundId: colorRoundId,
    timeLeft: colorTimer,
    bettingOpen: colorTimer > 5
  });

  // Admin Dashboard ko update bhejna
  io.to('admin_room').emit('admin_color_update', {
    roundId: colorRoundId,
    timeLeft: colorTimer,
    liveUsers: liveUsers,
    bets: colorBets
  });

}, 1000);

async function declareColorResult() {
  let winner = manualColorResult;

  // Agar admin ne select nahi kiya, toh auto lowest bet wala color
  if (!winner) {
    const colors = ['RED', 'GREEN', 'VIOLET'];
    colors.sort((a, b) => colorBets[a].total - colorBets[b].total);
    winner = colors[0];
  }

  io.to('room_color_game').emit('color_round_result', {
    roundId: colorRoundId,
    winningColor: winner
  });

  // Supabase REST API
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
      // Connect hote hi turant data bhejna
      socket.emit('admin_color_update', {
        roundId: colorRoundId,
        timeLeft: colorTimer,
        liveUsers: liveUsers,
        bets: colorBets
      });
    }
  });

  socket.on('admin_set_color_winner', ({ secret, color }) => {
    if (secret === ADMIN_SECRET || secret === 'admin123') {
      manualColorResult = color;
      console.log("Admin forced result:", color);
    }
  });

  socket.on('disconnect', () => {
    liveUsers = Math.max(0, liveUsers - 1);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
