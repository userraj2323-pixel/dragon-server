const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Supabase Connection
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ==========================================
// 🎨 COLOR PREDICTION GAME LOGIC
// ==========================================
let colorTimer = 30;
let colorRoundId = "DA-" + Math.floor(100000 + Math.random() * 900000);
let manualColorResult = null; // Admin ki choice

let colorBets = {
  RED: { total: 0, users: 0 },
  GREEN: { total: 0, users: 0 },
  VIOLET: { total: 0, users: 0 }
};

let liveUsers = 0;

// Har 1 Second me chalne wala Game Loop
setInterval(async () => {
  colorTimer--;

  // Jab 30 second poore ho jayein: Result Declare
  if (colorTimer <= 0) {
    await declareColorResult();
    
    // Naya round start
    colorTimer = 30;
    colorRoundId = "DA-" + Math.floor(100000 + Math.random() * 900000);
    colorBets = {
      RED: { total: 0, users: 0 },
      GREEN: { total: 0, users: 0 },
      VIOLET: { total: 0, users: 0 }
    };
    manualColorResult = null;
  }

  // Color Game screen wale users ko live timer bhejna
  io.to('room_color_game').emit('color_game_tick', {
    roundId: colorRoundId,
    timeLeft: colorTimer,
    bettingOpen: colorTimer > 5
  });

  // Admin Dashboard ko bet details aur timer bhejna
  io.to('admin_room').emit('admin_color_update', {
    roundId: colorRoundId,
    timeLeft: colorTimer,
    liveUsers: liveUsers,
    bets: colorBets
  });

}, 1000);

async function declareColorResult() {
  let winner = manualColorResult;

  // Agar admin ne select nahi kiya, toh automatically least bet wala color jitega
  if (!winner) {
    const colors = ['RED', 'GREEN', 'VIOLET'];
    colors.sort((a, b) => colorBets[a].total - colorBets[b].total);
    winner = colors[0];
  }

  // Sabhi users ko result send karna
  io.to('room_color_game').emit('color_round_result', {
    roundId: colorRoundId,
    winningColor: winner
  });

  // Supabase Database me record save karna
  try {
    await supabase.from('color_rounds').insert([{
      round_id: colorRoundId,
      winning_color: winner,
      total_red: colorBets.RED.total,
      total_green: colorBets.GREEN.total,
      total_violet: colorBets.VIOLET.total
    }]);
  } catch (err) {
    console.error("DB Save Error:", err);
  }
}

// ==========================================
// 🔌 SOCKET CONNECTIONS
// ==========================================
io.on('connection', (socket) => {
  liveUsers++;

  // User Color Prediction game room join karega
  socket.on('join_color_game', () => {
    socket.join('room_color_game');
  });

  // User Bet Lagayega
  socket.on('place_color_bet', ({ color, amount }) => {
    if (colorTimer <= 5) return; // Aakhri 5 second me bet lock

    if (colorBets[color]) {
      colorBets[color].total += Number(amount);
      colorBets[color].users += 1;
    }
  });

  // Admin Room Join (Password check)
  socket.on('join_admin', (secret) => {
    if (secret === process.env.ADMIN_SECRET) {
      socket.join('admin_room');
    }
  });

  // Admin Result Set Karega (Manual Win)
  socket.on('admin_set_color_winner', ({ secret, color }) => {
    if (secret === process.env.ADMIN_SECRET) {
      manualColorResult = color; // E.g., 'RED', 'GREEN', ya 'VIOLET'
    }
  });

  socket.on('disconnect', () => {
    liveUsers = Math.max(0, liveUsers - 1);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server live on port ${PORT}`));
