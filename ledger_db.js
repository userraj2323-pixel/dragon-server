const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'ledger_database.json');
const SECRET_KEY = 'dragon_alpha_encrypted_ledger_secret_key';

let db = {
    merchantUpiId: "dragonalpha@ybl",
    users: {
        "11111111-1111-1111-1111-111111111111": { id: "11111111-1111-1111-1111-111111111111", name: "Dragon Champion", email: "player@dragonalpha.app", mobile: "9876543210", balance: 1000, isBanned: false, registeredAt: "09 Nov 2026, 11:30 PM" }
    },
    transactions: [],
    depositRequests: [],
    withdrawalRequests: []
};

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            db = JSON.parse(data);
            if (!db.merchantUpiId) {
                db.merchantUpiId = "dragonalpha@ybl";
            }
            console.log('📦 Encrypted Database Ledger Loaded. Merchant UPI:', db.merchantUpiId);
        } else {
            saveDatabase();
        }
    } catch (err) {
        console.error('⚠️ DB Load error, creating fresh ledger:', err);
    }
}

function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (err) {
        console.error('⚠️ DB Save Error:', err);
    }
}

function generateSignature(record) {
    const payload = JSON.stringify(record) + SECRET_KEY;
    return crypto.createHash('sha256').update(payload).digest('hex');
}

loadDatabase();

module.exports = {
    getUser: (userId) => {
        if (!db.users[userId]) {
            db.users[userId] = {
                id: userId,
                name: "Player_" + userId.takeLast ? userId.takeLast(4) : userId.slice(-4),
                email: `${userId.toLowerCase()}@dragon.app`,
                mobile: "9" + Math.floor(100000009 + Math.random() * 899999990),
                balance: 1000,
                isBanned: false,
                registeredAt: new Date().toLocaleString()
            };
            saveDatabase();
        }
        return db.users[userId];
    },

    getAllUsers: () => Object.values(db.users),

    updateBalance: (userId, delta) => {
        const user = module.exports.getUser(userId);
        user.balance = Math.max(0, user.balance + delta);
        saveDatabase();
        return user.balance;
    },

    recordTransaction: (userId, amount, type, referenceId = "") => {
        const tx = {
            id: "TXN_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
            userId,
            amount,
            type,
            referenceId,
            timestamp: Date.now(),
            utrNumber: type === 'DEPOSIT' ? "UTR" + Date.now().toString().slice(-10) : null
        };
        tx.signature = generateSignature(tx);
        db.transactions.push(tx);

        if (type === 'WIN' || type === 'INITIAL_BONUS' || type === 'DAILY_REWARD') {
            module.exports.updateBalance(userId, amount);
        } else if (type === 'BET') {
            module.exports.updateBalance(userId, -amount);
        }

        saveDatabase();
        return tx;
    },

    getTransactions: (userId) => {
        return db.transactions.filter(t => t.userId === userId);
    },

    addDepositRequest: (userId, userName, amount, paymentMethod, utrNumber) => {
        const req = {
            id: "DEP_" + Date.now(),
            userId,
            userName,
            amount,
            paymentMethod,
            utrNumber: utrNumber || "UTR" + Date.now().toString().slice(-10),
            status: "PENDING",
            timestamp: Date.now()
        };
        db.depositRequests.unshift(req);
        saveDatabase();
        return req;
    },

    getDepositRequests: () => db.depositRequests,

    approveDeposit: (reqId) => {
        const req = db.depositRequests.find(r => r.id === reqId);
        if (req && req.status === 'PENDING') {
            req.status = 'APPROVED';
            module.exports.updateBalance(req.userId, req.amount);
            module.exports.recordTransaction(req.userId, req.amount, 'DEPOSIT', req.paymentMethod);
            saveDatabase();
            return req;
        }
        return null;
    },

    getWithdrawalRequests: () => db.withdrawalRequests,

    addWithdrawalRequest: (userId, userName, amount, method, accountDetails) => {
        const req = {
            id: "WTH_" + Date.now(),
            userId,
            userName,
            amount,
            method,
            accountDetails,
            status: "PENDING",
            timestamp: Date.now()
        };
        db.withdrawalRequests.unshift(req);
        saveDatabase();
        return req;
    },

    approveWithdrawal: (reqId) => {
        const req = db.withdrawalRequests.find(r => r.id === reqId);
        if (req && req.status === 'PENDING') {
            req.status = 'APPROVED';
            module.exports.updateBalance(req.userId, -req.amount);
            module.exports.recordTransaction(req.userId, req.amount, 'WITHDRAWAL', req.method);
            saveDatabase();
            return req;
        }
        return null;
    },

    getMerchantUpiId: () => {
        return db.merchantUpiId || "dragonalpha@ybl";
    },

    setMerchantUpiId: (newUpiId) => {
        db.merchantUpiId = newUpiId.trim();
        saveDatabase();
        return db.merchantUpiId;
    },

    getAllTransactionsList: () => db.transactions,

    rejectDeposit: (reqId) => {
        const req = db.depositRequests.find(r => r.id === reqId);
        if (req && req.status === 'PENDING') {
            req.status = 'REJECTED';
            saveDatabase();
            return req;
        }
        return null;
    },

    rejectWithdrawal: (reqId) => {
        const req = db.withdrawalRequests.find(r => r.id === reqId);
        if (req && req.status === 'PENDING') {
            req.status = 'REJECTED';
            saveDatabase();
            return req;
        }
        return null;
    },

    toggleUserBan: (userId) => {
        const user = module.exports.getUser(userId);
        if (user) {
            user.isBanned = !user.isBanned;
            saveDatabase();
            return user;
        }
        return null;
    }
};
