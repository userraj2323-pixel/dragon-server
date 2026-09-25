const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Animals aur Multipliers
const ANIMALS = {
  swallow: { id: "swallow", multiplier: 6 },
  rabbit: { id: "rabbit", multiplier: 6 },
  monkey: { id: "monkey", multiplier: 8 },
  panda: { id: "panda", multiplier: 8 },
  peacock: { id: "peacock", multiplier: 8 },
  pigeon: { id: "pigeon", multiplier: 8 },
  eagle: { id: "eagle", multiplier: 12 },
  lion: { id: "lion", multiplier: 12 },
  silver_shark: { id: "silver_shark", multiplier: 24 },
  gold_shark: { id: "gold_shark", multiplier: 24 }
};

let remainingTime = 15;
let gameState = "BETTING"; 
let currentBets = {};      
let manualResult = null;   

// Admin Force Result URL (Jaise: /admin/force/lion)
app.get("/admin/force/:animal", (req, res) => {
  const chosen = req.params.animal;
  if (ANIMALS[chosen]) {
    manualResult = chosen;
    res.json({ status: "success", message: `Agle round ka winner set: ${chosen}` });
  } else {
    res.status(400).json({ status: "error", message: "Invalid animal name" });
  }
});

// Auto-Profit Logic (Sabse kam payout wala animal choose karega)
function calculateWinningAnimal() {
  if (manualResult && ANIMALS[manualResult]) {
    const forced = manualResult;
    manualResult = null;
    return forced;
  }

  const totalBets = {};
  Object.keys(ANIMALS).forEach(id => totalBets[id] = 0);

  Object.values(currentBets).forEach(userBet => {
    for (let id in userBet) {
      if (totalBets[id] !== undefined) totalBets[id] += userBet[id];
    }
  });

  let bestAnimal = "swallow";
  let minPayout = Infinity;

  for (let id in ANIMALS) {
    const payout = totalBets[id] * ANIMALS[id].multiplier;
    if (payout < minPayout) {
      minPayout = payout;
      bestAnimal = id;
    }
  }
  return bestAnimal;
}

// Game Timer Loop
setInterval(() => {
  remainingTime--;

  if (gameState === "BETTING" && remainingTime <= 0) {
    gameState = "SPINNING";
    remainingTime = 8;
    const winner = calculateWinningAnimal();
    io.emit("round_result", { winner: winner, multiplier: ANIMALS[winner].multiplier });
  }

  if (gameState === "SPINNING" && remainingTime <= 0) {
    gameState = "SETTLING";
    remainingTime = 4;
    currentBets = {};
    io.emit("round_reset");
  }

  if (gameState === "SETTLING" && remainingTime <= 0) {
    gameState = "BETTING";
    remainingTime = 15;
    io.emit("timer_start", { time: remainingTime });
  }

  if (gameState === "BETTING") {
    io.emit("timer_update", { time: remainingTime });
  }
}, 1000);

// Socket Connection
io.on("connection", (socket) => {
  socket.emit("timer_update", { time: remainingTime });

  socket.on("place_bet", (data) => {
    if (gameState !== "BETTING") return;
    const { animal, amount } = data;
    if (!ANIMALS[animal]) return;

    if (!currentBets[socket.id]) currentBets[socket.id] = {};
    if (!currentBets[socket.id][animal]) currentBets[socket.id][animal] = 0;

    currentBets[socket.id][animal] += amount;
    io.emit("bet_update", { animal, amount: currentBets[socket.id][animal] });
  });

  socket.on("disconnect", () => {
    delete currentBets[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Zoo Server running on port ${PORT}`);
});
