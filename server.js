const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Anuj1999@2026@db.olmvohfxwzrmktdkxpms.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let roundId = 1;
let timeLeft = 15;
let state = 'BETTING';
let currentBets = [];

setInterval(async () => {
  if (state === 'BETTING') {
    timeLeft--;
    io.emit('timer_tick', { timeLeft, state });

    if (timeLeft <= 0) {
      state = 'CALCULATING';
      io.emit('round_state', { state });

      const dCard = Math.floor(Math.random() * 13) + 1;
      const tCard = Math.floor(Math.random() * 13) + 1;
      
      let winner = 'TIE';
      if (dCard > tCard) winner = 'DRAGON';
      else if (tCard > dCard) winner = 'TIGER';

      try {
        await pool.query(
          'INSERT INTO game_rounds (dragon_card, tiger_card, winner) VALUES ($1, $2, $3)',
          [dCard, tCard, winner]
        );

        for (const bet of currentBets) {
          if (bet.bet_on === winner) {
            const winMultiplier = (winner === 'TIE') ? 8 : 2;
            const winAmount = bet.amount * winMultiplier;
            await pool.query(
              'UPDATE wallets SET winning = winning + $1 WHERE user_id = $2',
              [winAmount, bet.user_id]
            );
            await pool.query('UPDATE bets SET status = $1 WHERE id = $2', ['WON', bet.id]);
          } else {
            await pool.query('UPDATE bets SET status = $1 WHERE id = $2', ['LOST', bet.id]);
          }
        }
      } catch (err) {
        console.error('DB Error:', err);
      }

      state = 'RESULT';
      io.emit('round_result', { roundId, dCard, tCard, winner });

      setTimeout(() => {
        roundId++;
        timeLeft = 15;
        state = 'BETTING';
        currentBets = [];
        io.emit('round_start', { roundId });
      }, 5000);
    }
  }
}, 1000);

io.on('connection', (socket) => {
  socket.on('join_game', async ({ userId }) => {
    socket.userId = userId;
    try {
      let res = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
      if (res.rows.length === 0) {
        res = await pool.query(
          'INSERT INTO wallets (user_id) VALUES ($1) RETURNING *',
          [userId]
        );
      }
      socket.emit('wallet_update', res.rows[0]);
    } catch (e) {
      console.error(e);
    }
  });

  socket.on('place_bet', async ({ userId, betOn, amount }) => {
    if (state !== 'BETTING') {
      return socket.emit('error_msg', 'Betting closed!');
    }

    try {
      const walletRes = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
      const wallet = walletRes.rows[0];
      const total = Number(wallet.deposit) + Number(wallet.winning) + Number(wallet.bonus);

      if (total < amount) {
        return socket.emit('error_msg', 'Insufficient Balance!');
      }

      let rem = amount;
      let dep = Number(wallet.deposit);
      let win = Number(wallet.winning);

      if (dep >= rem) {
        dep -= rem;
      } else {
        rem -= dep;
        dep = 0;
        win -= rem;
      }

      await pool.query('UPDATE wallets SET deposit = $1, winning = $2 WHERE user_id = $3', [dep, win, userId]);

      const betRes = await pool.query(
        'INSERT INTO bets (round_id, user_id, bet_on, amount) VALUES ($1, $2, $3, $4) RETURNING id',
        [roundId, userId, betOn, amount]
      );

      currentBets.push({ id: betRes.rows[0].id, user_id: userId, bet_on: betOn, amount });
      socket.emit('wallet_update', { deposit: dep, winning: win, bonus: wallet.bonus });
      socket.emit('bet_success', { betOn, amount });
    } catch (e) {
      console.error(e);
    }
  });
});

app.get('/', (req, res) => res.send('Dragon Alpha Server Running'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
