<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Dragon Tiger Live Game + Admin Control</title>
  <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
  <style>
    body {
      background: #090e1a;
      color: white;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      text-align: center;
      padding: 15px;
      margin: 0;
    }
    .header { margin-bottom: 10px; }
    .status {
      font-size: 14px;
      padding: 5px 12px;
      border-radius: 20px;
      display: inline-block;
      background: #16a34a;
    }
    .round-info { color: #94a3b8; font-size: 15px; margin-top: 5px; }
    .timer-box {
      font-size: 28px;
      font-weight: bold;
      color: #facc15;
      margin: 10px 0;
      min-height: 38px;
    }
    
    /* Admin Control Panel */
    .admin-panel {
      background: #1e1b4b;
      border: 2px dashed #818cf8;
      border-radius: 12px;
      max-width: 650px;
      margin: 15px auto;
      padding: 12px;
    }
    .admin-title { color: #a5b4fc; font-weight: bold; margin-bottom: 8px; font-size: 16px; }
    .admin-btns { display: flex; justify-content: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
    .adm-btn {
      padding: 8px 14px;
      border: none;
      border-radius: 6px;
      font-weight: bold;
      cursor: pointer;
      color: white;
    }
    .adm-dragon { background: #dc2626; }
    .adm-tiger { background: #d97706; }
    .adm-auto { background: #059669; }

    /* Game Table */
    .game-table {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin: 20px auto;
      max-width: 650px;
    }
    .card-box {
      background: #172033;
      border: 3px solid #334155;
      border-radius: 12px;
      flex: 1;
      padding: 15px 10px;
      transition: 0.3s;
    }
    .card-box.winner {
      box-shadow: 0 0 25px #22c55e;
      border-color: #22c55e;
      transform: scale(1.05);
    }
    .dragon { border-color: #ef4444; }
    .tiger { border-color: #f59e0b; }
    .tie { border-color: #10b981; max-width: 130px; }
    .card-title { font-size: 20px; font-weight: bold; margin-bottom: 5px; }
    .card-value {
      font-size: 50px;
      font-weight: bold;
      height: 60px;
      line-height: 60px;
      margin: 10px 0;
    }
    .bet-pool {
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 8px;
    }
    .bet-btn {
      width: 100%;
      padding: 10px;
      font-size: 15px;
      font-weight: bold;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      color: white;
    }
    .winner-banner {
      font-size: 24px;
      font-weight: bold;
      color: #38bdf8;
      min-height: 35px;
      margin: 10px 0;
    }
    .logs-box {
      background: #020617;
      border: 1px solid #1e293b;
      border-radius: 8px;
      margin: 15px auto;
      max-width: 650px;
      padding: 10px;
      font-family: monospace;
      font-size: 12px;
      text-align: left;
      height: 90px;
      overflow-y: auto;
      color: #94a3b8;
    }
  </style>
</head>
<body>

  <div class="header">
    <h1 style="margin: 5px;">🐉 DRAGON vs TIGER 🐅</h1>
    <div id="status" class="status">🟢 Server Connected</div>
    <div id="roundId" class="round-info">Round: --</div>
  </div>

  <!-- ADMIN MASTER CONTROL PANEL -->
  <div class="admin-panel">
    <div class="admin-title">👑 ADMIN CONTROL (House Profit System)</div>
    <div id="adminModeStatus" style="color: #4ade80; font-weight: bold;">Current Engine: Auto-Profit (Kam Bet Jeetegi)</div>
    <div class="admin-btns">
      <button class="adm-btn adm-dragon" onclick="setAdminWinner('DRAGON')">Force Dragon Win 🐉</button>
      <button class="adm-btn adm-tiger" onclick="setAdminWinner('TIGER')">Force Tiger Win 🐅</button>
      <button class="adm-btn adm-auto" onclick="setAdminWinner('AUTO')">Auto-Profit Mode 🛡️</button>
    </div>
  </div>

  <div class="timer-box" id="timer">Waiting for round...</div>

  <!-- TABLE -->
  <div class="game-table">
    <div class="card-box dragon" id="dragonBox">
      <div class="card-title" style="color: #ef4444;">DRAGON</div>
      <div class="bet-pool" id="poolDragon">Total Bet: ₹0</div>
      <div class="card-value" id="dragonCard">?</div>
      <button class="bet-btn" style="background:#dc2626;" onclick="placeBet('DRAGON', 500)">Bet ₹500 Dragon</button>
    </div>

    <div class="card-box tie" id="tieBox">
      <div class="card-title" style="color: #10b981;">TIE</div>
      <div class="bet-pool" id="poolTie">Total: ₹0</div>
      <div class="card-value" style="font-size: 22px; color: #10b981;">8:1</div>
      <button class="bet-btn" style="background:#059669;" onclick="placeBet('TIE', 100)">Bet ₹100 Tie</button>
    </div>

    <div class="card-box tiger" id="tigerBox">
      <div class="card-title" style="color: #f59e0b;">TIGER</div>
      <div class="bet-pool" id="poolTiger">Total Bet: ₹0</div>
      <div class="card-value" id="tigerCard">?</div>
      <button class="bet-btn" style="background:#d97706;" onclick="placeBet('TIGER', 500)">Bet ₹500 Tiger</button>
    </div>
  </div>

  <div class="winner-banner" id="winnerBanner">Place your bets!</div>

  <div class="logs-box" id="logs"></div>

  <script>
    const SERVER_URL = 'https://dragon-server-0y5z.onrender.com';
    const socket = io(SERVER_URL);

    const timerEl = document.getElementById('timer');
    const roundEl = document.getElementById('roundId');
    const dragonCardEl = document.getElementById('dragonCard');
    const tigerCardEl = document.getElementById('tigerCard');
    const winnerEl = document.getElementById('winnerBanner');
    const dragonBox = document.getElementById('dragonBox');
    const tigerBox = document.getElementById('tigerBox');
    const tieBox = document.getElementById('tieBox');
    const poolDragon = document.getElementById('poolDragon');
    const poolTiger = document.getElementById('poolTiger');
    const poolTie = document.getElementById('poolTie');
    const adminModeStatus = document.getElementById('adminModeStatus');
    const logsEl = document.getElementById('logs');

    function log(msg) {
      const p = document.createElement('div');
      p.innerText = '⚡ ' + msg;
      logsEl.prepend(p);
    }

    function cardSymbol(num) {
      if (!num) return '?';
      if (num === 1) return 'A';
      if (num === 11) return 'J';
      if (num === 12) return 'Q';
      if (num === 13) return 'K';
      return num;
    }

    function resetTable() {
      dragonCardEl.innerText = '?';
      tigerCardEl.innerText = '?';
      dragonBox.classList.remove('winner');
      tigerBox.classList.remove('winner');
      tieBox.classList.remove('winner');
    }

    socket.on('round_start', (data) => {
      roundEl.innerText = `Round: #${data.roundId}`;
      winnerEl.innerText = '⏳ Bets Open! Auto-profit active';
      resetTable();
      poolDragon.innerText = 'Total Bet: ₹0';
      poolTiger.innerText = 'Total Bet: ₹0';
      poolTie.innerText = 'Total Bet: ₹0';
      log(`Round #${data.roundId} started.`);
    });

    socket.on('timer_tick', (data) => {
      if (data.state === 'BETTING') {
        timerEl.innerText = `⏳ Betting Closes in: ${data.timeLeft}s`;
      } else {
        timerEl.innerText = `Calculating Results (House Securing Profit)...`;
      }
      if (data.bets) {
        poolDragon.innerText = `Total Bet: ₹${data.bets.DRAGON}`;
        poolTiger.innerText = `Total Bet: ₹${data.bets.TIGER}`;
        poolTie.innerText = `Total Bet: ₹${data.bets.TIE}`;
      }
      if (data.controlMode) {
        adminModeStatus.innerText = `Current Engine: ${data.controlMode}`;
      }
    });

    socket.on('bets_updated', (bets) => {
      poolDragon.innerText = `Total Bet: ₹${bets.DRAGON}`;
      poolTiger.innerText = `Total Bet: ₹${bets.TIGER}`;
      poolTie.innerText = `Total Bet: ₹${bets.TIE}`;
    });

    socket.on('round_result', (data) => {
      dragonCardEl.innerText = cardSymbol(data.dCard);
      tigerCardEl.innerText = cardSymbol(data.tCard);

      const winner = data.winner ? data.winner.toUpperCase() : '';
      winnerEl.innerText = `🏆 WINNER: ${winner}!`;

      if (winner === 'DRAGON') dragonBox.classList.add('winner');
      if (winner === 'TIGER') tigerBox.classList.add('winner');
      if (winner === 'TIE') tieBox.classList.add('winner');

      log(`Round Result: Dragon [${cardSymbol(data.dCard)}] vs Tiger [${cardSymbol(data.tCard)}] -> ${winner} Wins!`);
    });

    // Player Place Bet
    function placeBet(choice, amt) {
      socket.emit('place_bet', { bet_on: choice, amount: amt });
      log(`Placed bet: ₹${amt} on ${choice}`);
    }

    // Admin Control Function
    function setAdminWinner(choice) {
      socket.emit('admin_set_winner', { winner: choice });
      if (choice === 'AUTO') {
        adminModeStatus.innerText = 'Current Engine: Auto-Profit (Kam Bet Jeetegi)';
        alert('Mode set to: AUTO PROFIT (Whichever side has lowest bets will win)');
      } else {
        adminModeStatus.innerText = `Current Engine: FORCED ${choice}`;
        alert(`Next round is FORCED to win for: ${choice}`);
      }
    }
  </script>
</body>
</html>
