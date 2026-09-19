const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let roundId = 1;
let timeLeft = 15;
let gameState = 'BETTING'; 
let manualWinner = null; // 'DRAGON', 'TIGER', 'TIE', ya null (Auto-Profit)

// Live round bets tracking
let currentBets = {
  DRAGON: 0,
  TIE: 0,
  TIGER: 0
};

app.get('/', (req, res) => {
  res.send('Dragon Tiger Admin Profit Engine Live');
});

// Winner ke hisaab se guaranteed cards generate karne ka logic
function generateWinningCards(targetWinner) {
  let dCard, tCard;

  if (targetWinner === 'DRAGON') {
    // Dragon ko bada card milega (Tiger chhota)
    tCard = Math.floor(Math.random() * 12) + 1; // 1 to 12
    dCard = tCard + Math.floor(Math.random() * (13 - tCard)) + 1; // Dragon bada hoga
  } else if (targetWinner === 'TIGER') {
    // Tiger ko bada card milega (Dragon chhota)
    dCard = Math.floor(Math.random() * 12) + 1; // 1 to 12
    tCard = dCard + Math.floor(Math.random() * (13 - dCard)) + 1; // Tiger bada hoga
  } else {
    // TIE: Dono ko bilkul barabar card
    const same = Math.floor(Math.random() * 13) + 1;
    dCard = same;
    tCard = same;
  }
  return { dCard, tCard };
}

// Game Loop: Har second tick hota hai
setInterval(async () => {
  if (gameState === 'BETTING') {
    timeLeft--;

    io.emit('timer_tick', {
      timeLeft,
      state: gameState,
      bets: currentBets,
      manualWinner: manualWinner
    });

    if (timeLeft <= 0) {
      gameState = 'CALCULATING';
      let winner;

      // 1. Agar Admin ne manual button dabaya hai
      if (manualWinner) {
        winner = manualWinner;
      } else {
        // 2. AUTO-PROFIT MODE: Jis par ZYADA bet lagi hai wo HAAREGA (Kam bet wala jeetega)
        if (currentBets.DRAGON > currentBets.TIGER) {
          winner = 'TIGER'; // Dragon par zyada bet thi, isliye Tiger jeeta
        } else if (currentBets.TIGER > currentBets.DRAGON) {
          winner = 'DRAGON'; // Tiger par zyada bet thi, isliye Dragon jeeta
        } else {
          // Dono barabar hain toh Dragon ya Tiger me se koi ek randomly jeetega
          winner = Math.random() > 0.5 ? 'DRAGON' : 'TIGER';
        }
      }

      const { dCard, tCard } = generateWinningCards(winner);

      // Supabase me database record save karein
      try {
        await pool.query(
          'INSERT INTO game_rounds (round_id, dragon_card, tiger_card, winner) VALUES ($1, $2, $3, $4)',
          [roundId, dCard, tCard, winner]
        );
      } catch (err) {
        console.error('Database Error:', err.message);
      }

      // Result sabhi clients ko bhejein
      io.emit('round_result', {
        roundId,
        dCard,
        tCard,
        winner,
        bets: currentBets
      });

      // 5 second baad naya round start hoga
      setTimeout(() => {
        roundId++;
        timeLeft = 15;
        gameState = 'BETTING';
        // Auto-profit default rehta hai, manual sirf ek round ke liye ya jab tak reset na ho
        currentBets = { DRAGON: 0, TIE: 0, TIGER: 0 };

        io.emit('round_start', {
          roundId,
          manualWinner: manualWinner
        });
      }, 5000);
    }
  }
}, 1000);

// Socket events
io.on('connection', (socket) => {
  // Jab naya connection ho, current state bhejein
  socket.emit('admin_status_update', {
    manualWinner: manualWinner,
    bets: currentBets
  });

  // Player Bet lagata hai
  socket.on('place_bet', (data) => {
    const choice = data.bet_on ? data.bet_on.toUpperCase() : null;
    const amount = Number(data.amount) || 0;

    if (gameState === 'BETTING' && currentBets[choice] !== undefined) {
      currentBets[choice] += amount;
      // Sabhi screens par total bet turant update hogi
      io.emit('bets_updated', currentBets);
    }
  });

  // Admin winner set karta hai
  socket.on('admin_set_winner', (data) => {
    if (data.winner === 'AUTO') {
      manualWinner = null;
    } else {
      manualWinner = data.winner;
    }
    // Sabhi ko batao ki admin ne kya decide kiya hai
    io.emit('admin_status_update', {
      manualWinner: manualWinner,
      bets: currentBets
    });
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
