const express = require('express');
const crypto = require('crypto');
const supabase = require('./supabase');
const db = require('./ledger_db');

const router = express.Router();
const locks = new Map();

const DEFAULT_UUID = '11111111-1111-1111-1111-111111111111';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withLock(key, callback) {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    locks.set(key, current);
    return current.finally(() => {
        if (locks.get(key) === current) locks.delete(key);
    });
}

function adminOnly(req, res, next) {
    const expected = (process.env.WALLET_ADMIN_TOKEN || '').trim().replace(/^["']|["']$/g, '');
    if (!expected) {
        return next(); // Agar token set nahi hai toh allow karein taaki admin dashboard load ho sake
    }

    const rawProvided = req.get('x-admin-token') || req.get('authorization') || '';
    const provided = rawProvided.replace(/^Bearer\s+/i, '').trim().replace(/^["']|["']$/g, '');

    if (provided !== expected) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    next();
}

function parseAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// 🛡️ USER ID RESOLVER: Real UUID ya Registered Phone number se User ID dhoondta hai
async function resolveUserId(body) {
    const raw = body.userId ?? body.user_id;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (UUID_REGEX.test(trimmed) && trimmed !== DEFAULT_UUID) {
            return trimmed;
        }

        const digits = trimmed.replace(/\D/g, '');
        if (digits.length >= 10) {
            const phone = digits.slice(-10);
            try {
                const { data } = await supabase.from('users').select('id').eq('phone', phone).maybeSingle();
                if (data && data.id) return data.id;
            } catch (_) {}
        }

        if (UUID_REGEX.test(trimmed)) {
            return trimmed;
        }
    }
    return DEFAULT_UUID;
}

function respondWithDatabaseError(res, error) {
    console.error('Wallet Supabase request failed:', error);
    return res.status(500).json({ success: false, message: error.message || 'Wallet operation failed' });
}

// 👤 REAL USER FETCH
async function fetchUser(userId) {
    if (!userId || !UUID_REGEX.test(userId)) return null;

    const { data, error } = await supabase
        .from('users')
        .select('id, wallet_balance, locked_balance, turnover_required, turnover_done, name, phone')
        .eq('id', userId)
        .maybeSingle();

    if (error) throw error;

    if (!data && userId === DEFAULT_UUID) {
        const { data: createdUser, error: createError } = await supabase
            .from('users')
            .upsert({
                id: DEFAULT_UUID,
                wallet_balance: 0.00,
                locked_balance: 0.00,
                turnover_required: 0.00,
                turnover_done: 0.00
            })
            .select('id, wallet_balance, locked_balance, turnover_required, turnover_done, name, phone')
            .single();

        if (!createError && createdUser) return createdUser;
    }

    return data;
}

async function changeBalances(userId, walletDelta, lockedDelta, minimumWallet = 0, minimumLocked = 0) {
    const validId = UUID_REGEX.test(userId) ? userId : DEFAULT_UUID;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const user = await fetchUser(validId);
        if (!user) return { missing: true };

        const wallet = Number(user.wallet_balance || 0);
        const locked = Number(user.locked_balance || 0);
        if (wallet < minimumWallet || locked < minimumLocked) return { insufficient: true };

        let query = supabase.from('users').update({
            wallet_balance: wallet + walletDelta,
            locked_balance: locked + lockedDelta
        }).eq('id', validId);

        query = user.wallet_balance === null
            ? query.is('wallet_balance', null)
            : query.eq('wallet_balance', user.wallet_balance);
        query = user.locked_balance === null
            ? query.is('locked_balance', null)
            : query.eq('locked_balance', user.locked_balance);

        const { data, error } = await query.select('id, wallet_balance, locked_balance').maybeSingle();
        if (error) throw error;
        if (data) return { user: data };
    }
    throw new Error('Could not update wallet balance');
}

// 🛡️ TURNOVER TRACKING FUNCTIONS (1X WAGERING RULE)
async function addTurnoverRequirement(userId, amount) {
    const validId = UUID_REGEX.test(userId) ? userId : DEFAULT_UUID;
    const user = await fetchUser(validId);
    if (!user) return;
    const current = Number(user.turnover_required || 0);
    await supabase.from('users').update({
        turnover_required: current + amount
    }).eq('id', validId);
}

async function recordBetTurnover(userId, betAmount) {
    const validId = UUID_REGEX.test(userId) ? userId : DEFAULT_UUID;
    const user = await fetchUser(validId);
    if (!user) return;
    const current = Number(user.turnover_done || 0);
    await supabase.from('users').update({
        turnover_done: current + betAmount
    }).eq('id', validId);
}

// 🔗 ENRICH TRANSACTIONS: Har transaction ke sath real Name aur Phone jodta hai
async function enrichTransactionsWithUserData(transactions) {
    if (!Array.isArray(transactions) || transactions.length === 0) return [];
    const userIds = [...new Set(transactions.map(t => t.user_id).filter(id => id && UUID_REGEX.test(id)))];

    const userMap = new Map();
    if (userIds.length > 0) {
        try {
            const { data: users, error } = await supabase
                .from('users')
                .select('id, name, phone')
                .in('id', userIds);
            if (!error && users) {
                users.forEach(u => userMap.set(u.id, u));
            }
        } catch (e) {
            console.error('Failed to enrich transaction users:', e.message);
        }
    }

    return transactions.map(t => {
        const u = userMap.get(t.user_id);
        const name = (u?.name || '').trim();
        const phone = (u?.phone || '').trim();

        let display = '';
        if (name && phone) {
            display = `${name} (${phone})`;
        } else if (name) {
            display = name;
        } else if (phone) {
            display = `User ${phone}`;
        } else if (t.user_id === DEFAULT_UUID) {
            display = 'Test Account (Demo)';
        } else if (t.user_id) {
            display = `${t.user_id.slice(0, 8)}...`;
        } else {
            display = 'Unknown Player';
        }

        return {
            ...t,
            user_name: name || display,
            user_phone: phone,
            user_display: display,
            userName: name || display,
            userPhone: phone,
            user: display
        };
    });
}

// ==========================================
// ⚙️ MERCHANT UPI CONFIG API
// ==========================================
router.get('/config', (req, res) => {
    return res.json({
        success: true,
        merchantUpiId: typeof db.getMerchantUpiId === 'function' ? db.getMerchantUpiId() : ''
    });
});

router.post('/config', async (req, res) => {
    const { merchantUpiId } = req.body || {};
    if (!merchantUpiId || typeof merchantUpiId !== 'string' || !merchantUpiId.trim()) {
        return res.status(400).json({ success: false, message: 'Valid merchantUpiId string is required' });
    }
    const cleanUpi = merchantUpiId.trim();
    const updated = typeof db.setMerchantUpiId === 'function' ? db.setMerchantUpiId(cleanUpi) : cleanUpi;

    try {
        await supabase.from('admin_upi_accounts').update({ is_active: false }).neq('id', -1);
        await supabase.from('admin_upi_accounts').upsert([{
            upi_id: cleanUpi,
            account_name: 'Merchant Official Payee',
            is_active: true
        }], { onConflict: 'upi_id' });
    } catch (err) {
        console.error('Supabase UPI sync warning:', err.message);
    }

    return res.json({ success: true, message: 'Merchant UPI ID updated successfully', merchantUpiId: updated });
});

// ==========================================
// 💰 USER REAL-TIME BALANCE API
// ==========================================
router.get('/balance/:userId', async (req, res) => {
    try {
        let { userId } = req.params;
        if (!userId || !UUID_REGEX.test(userId.trim())) {
            const digits = (userId || '').replace(/\D/g, '');
            if (digits.length >= 10) {
                const phone = digits.slice(-10);
                const { data } = await supabase.from('users').select('id').eq('phone', phone).maybeSingle();
                userId = data?.id || DEFAULT_UUID;
            } else {
                userId = DEFAULT_UUID;
            }
        } else {
            userId = userId.trim();
        }

        const user = await fetchUser(userId);
        if (!user) {
            return res.json({ 
                success: true, 
                balance: 0.00,
                locked_balance: 0.00,
                turnover_required: 0.00,
                turnover_done: 0.00
            });
        }

        return res.json({ 
            success: true, 
            balance: Number(user.wallet_balance || 0),
            locked_balance: Number(user.locked_balance || 0),
            turnover_required: Number(user.turnover_required || 0),
            turnover_done: Number(user.turnover_done || 0)
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 💳 USER TRANSACTIONS (REAL DEPOSIT & WITHDRAW)
// ==========================================

router.post('/deposit', async (req, res) => {
    const userId = await resolveUserId(req.body || {});
    const amount = parseAmount(req.body?.amount);
    let utrNumber = typeof req.body?.utr_number === 'string'
        ? req.body.utr_number.trim()
        : typeof req.body?.utrNumber === 'string' ? req.body.utrNumber.trim() : '';

    if (!utrNumber || utrNumber.toLowerCase().includes('phonepe') || utrNumber.toLowerCase().includes('gpay') || utrNumber.toLowerCase().includes('paytm')) {
        utrNumber = `UTR${Date.now()}`;
    }

    if (!amount) {
        return res.status(400).json({ success: false, message: 'Valid amount is required' });
    }

    try {
        const result = await withLock(`utr:${utrNumber}`, async () => {
            const user = await fetchUser(userId);
            if (!user) return { notFound: true };

            const { data: duplicate, error: lookupError } = await supabase
                .from('transactions')
                .select('id')
                .eq('utr_number', utrNumber)
                .limit(1);
            if (lookupError) throw lookupError;
            if (duplicate && duplicate.length > 0) return { duplicate: true };

            const { data: transaction, error } = await supabase.from('transactions').insert({
                user_id: userId,
                type: 'DEPOSIT',
                amount,
                utr_number: utrNumber,
                status: 'PENDING'
            }).select('*').single();

            if (error) {
                if (error.code === '23505') return { duplicate: true };
                throw error;
            }
            return { transaction };
        });

        if (result.notFound) return res.status(404).json({ success: false, message: 'User not found' });
        if (result.duplicate) return res.status(409).json({ success: false, message: 'UTR number has already been used' });
        return res.status(201).json({ success: true, transaction: result.transaction });
    } catch (error) {
        return respondWithDatabaseError(res, error);
    }
});

router.post('/withdraw', async (req, res) => {
    const userId = await resolveUserId(req.body || {});
    const amount = parseAmount(req.body?.amount);
    const upiId = req.body?.upi_id ?? req.body?.upiId ?? null;

    if (!amount) {
        return res.status(400).json({ success: false, message: 'Valid positive amount is required' });
    }

    try {
        const user = await fetchUser(userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const reqTurnover = Number(user.turnover_required || 0);
        const doneTurnover = Number(user.turnover_done || 0);
        if (doneTurnover < reqTurnover) {
            const remaining = Math.round(reqTurnover - doneTurnover);
            return res.status(400).json({
                success: false,
                turnover_required: true,
                message: `Wagering requirement incomplete! Bet ₹${remaining} more before withdrawing.`
            });
        }

        const result = await withLock(`user:${userId}`, async () => {
            const moved = await changeBalances(userId, -amount, amount, amount, 0);
            if (moved.missing || moved.insufficient) return moved;

            const { data: transaction, error } = await supabase.from('transactions').insert({
                user_id: userId,
                type: 'WITHDRAWAL',
                amount,
                upi_id: typeof upiId === 'string' ? upiId.trim() : null,
                status: 'PENDING'
            }).select('*').single();

            if (error) {
                await changeBalances(userId, amount, -amount, 0, amount);
                throw error;
            }
            return { transaction };
        });

        if (result.missing) return res.status(404).json({ success: false, message: 'User not found' });
        if (result.insufficient) return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
        return res.status(201).json({ success: true, transaction: result.transaction });
    } catch (error) {
        return respondWithDatabaseError(res, error);
    }
});

// ==========================================
// ⚡ AI / SMS DEPOSIT AUTO-VERIFICATION WEBHOOK
// ==========================================

function parseBankSMS(message) {
    if (!message || typeof message !== 'string') return null;

    let amount = null;
    const amountRegex = /(?:Rs\.?|INR)\s*([0-9]+(?:\.[0-9]{1,2})?)/i;
    const fallbackAmountRegex = /(?:credited\s*(?:by|with)?)\s*(?:Rs\.?|INR)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i;

    const amountMatch = message.match(amountRegex) || message.match(fallbackAmountRegex);
    if (amountMatch && amountMatch[1]) {
        amount = parseFloat(amountMatch[1]);
    }

    let utr = null;
    const utrWithPrefix = message.match(/(?:UPI|Ref|UTR|rrn|txn|id)[\s\/\-\.:]*(?:no\.?[\s:]*)?([0-9]{12})/i);
    if (utrWithPrefix && utrWithPrefix[1]) {
        utr = utrWithPrefix[1];
    } else {
        const standalone12Digit = message.match(/\b([0-9]{12})\b/);
        if (standalone12Digit && standalone12Digit[1]) {
            utr = standalone12Digit[1];
        }
    }

    return { amount, utr };
}

router.post('/webhook/sms-verify', async (req, res) => {
    const rawMessage = req.body?.message || req.body?.sms || req.body?.text || '';
    const secret = req.body?.secret || req.headers['x-webhook-secret'];

    if (secret !== 'alfaone_sms_secure_2026') {
        return res.status(401).json({ success: false, message: 'Unauthorized webhook request' });
    }

    const parsed = parseBankSMS(rawMessage);
    if (!parsed || !parsed.utr || !parsed.amount) {
        return res.status(400).json({ 
            success: false, 
            message: 'Could not extract valid 12-digit UTR or Amount from SMS',
            parsed 
        });
    }

    const { utr, amount } = parsed;

    try {
        const result = await withLock(`transaction:auto:${utr}`, async () => {
            const { data: transaction, error } = await supabase
                .from('transactions')
                .select('*')
                .eq('utr_number', utr)
                .eq('type', 'DEPOSIT')
                .eq('status', 'PENDING')
                .maybeSingle();

            if (error) throw error;
            if (!transaction) {
                return { status: 'NOT_FOUND', message: `No pending deposit found matching UTR: ${utr}` };
            }

            if (Number(transaction.amount) !== Number(amount)) {
                return { 
                    status: 'AMOUNT_MISMATCH', 
                    message: `Submitted ₹${transaction.amount} but bank received ₹${amount}` 
                };
            }

            const { error: updateError } = await supabase
                .from('transactions')
                .update({ status: 'APPROVED', admin_notes: 'Auto-Approved via Bank SMS Webhook' })
                .eq('id', transaction.id);

            if (updateError) throw updateError;

            await changeBalances(transaction.user_id, amount, 0);
            await addTurnoverRequirement(transaction.user_id, amount);

            return { status: 'SUCCESS', transactionId: transaction.id, credited: amount };
        });

        if (result.status === 'NOT_FOUND') {
            return res.status(404).json({ success: false, message: result.message });
        }
        if (result.status === 'AMOUNT_MISMATCH') {
            return res.status(400).json({ success: false, message: result.message });
        }

        return res.json({ 
            success: true, 
            message: `Deposit #${result.transactionId} auto-approved for ₹${result.credited}!` 
        });
    } catch (err) {
        console.error('❌ Auto SMS Verification Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 🛡️ ADMIN TRANSACTION AUDIT & CONTROLS
// ==========================================

router.get('/admin/pending', adminOnly, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('transactions')
            .select('*')
            .eq('status', 'PENDING')
            .order('created_at', { ascending: false });
        if (error) throw error;

        const enriched = await enrichTransactionsWithUserData(data || []);
        return res.json({ success: true, transactions: enriched });
    } catch (error) {
        return respondWithDatabaseError(res, error);
    }
});

router.get('/admin/users', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .order('created_at', { ascending: false });
        if (!error && data && data.length > 0) return res.json({ success: true, users: data });
    } catch (_) {}
    return res.json({ success: true, users: typeof db.getAllUsers === 'function' ? db.getAllUsers() : [] });
});

router.get('/admin/all-transactions', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('transactions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);
        if (!error && data && data.length > 0) {
            const enriched = await enrichTransactionsWithUserData(data);
            return res.json({ success: true, transactions: enriched });
        }
    } catch (_) {}
    return res.json({ success: true, transactions: typeof db.getAllTransactionsList === 'function' ? db.getAllTransactionsList() : [] });
});

router.post('/admin/adjust-balance', async (req, res) => {
    const { userId, amount } = req.body || {};
    if (!userId || isNaN(amount)) return res.status(400).json({ success: false, message: 'userId and numeric amount required' });
    const newBal = typeof db.updateBalance === 'function' ? db.updateBalance(userId, Number(amount)) : 0;
    return res.json({ success: true, message: `Balance updated for ${userId}`, balance: newBal });
});

router.post('/admin/toggle-ban', async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    const user = typeof db.toggleUserBan === 'function' ? db.toggleUserBan(userId) : null;
    return res.json({ success: true, user });
});

async function findPendingTransaction(transactionId) {
    const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('id', transactionId)
        .eq('status', 'PENDING')
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function setTransactionStatus(transactionId, status, adminNotes) {
    const updates = { status };
    if (adminNotes !== undefined) updates.admin_notes = adminNotes;
    const { data, error } = await supabase
        .from('transactions')
        .update(updates)
        .eq('id', transactionId)
        .eq('status', 'PENDING')
        .select('*')
        .maybeSingle();
    if (error) throw error;
    return data;
}

function getAdminRequest(req) {
    const transactionId = req.body?.transactionId ?? req.body?.transaction_id ?? req.body?.id;
    const adminNotes = req.body?.admin_notes ?? req.body?.adminNotes;
    if (typeof transactionId !== 'string' && typeof transactionId !== 'number') return null;
    if (adminNotes !== undefined && typeof adminNotes !== 'string') return null;
    return { transactionId, adminNotes };
}

// 🟢 REAL DEPOSIT APPROVAL
router.post('/admin/approve', adminOnly, async (req, res) => {
    const request = getAdminRequest(req);
    if (!request) return res.status(400).json({ success: false, message: 'Transaction ID is required' });

    try {
        const result = await withLock(`transaction:${request.transactionId}`, async () => {
            const transaction = await findPendingTransaction(request.transactionId);
            if (!transaction) return { notPending: true };
            const amount = parseAmount(transaction.amount);
            if (!amount || !['DEPOSIT', 'WITHDRAWAL'].includes(transaction.type)) return { invalid: true };

            const claimed = await setTransactionStatus(request.transactionId, 'APPROVED', request.adminNotes);
            if (!claimed) return { notPending: true };

            try {
                if (transaction.type === 'DEPOSIT') {
                    await changeBalances(transaction.user_id, amount, 0);
                    await addTurnoverRequirement(transaction.user_id, amount);
                } else {
                    await changeBalances(transaction.user_id, 0, -amount, 0, amount);
                }
            } catch (error) {
                await supabase.from('transactions').update({ status: 'PENDING' })
                    .eq('id', request.transactionId).eq('status', 'APPROVED');
                throw error;
            }
            return { transaction: claimed };
        });

        if (result.notPending) return res.status(409).json({ success: false, message: 'Transaction not found or already processed' });
        if (result.invalid) return res.status(400).json({ success: false, message: 'Invalid type or amount' });
        return res.json({ success: true, transaction: result.transaction });
    } catch (error) {
        return respondWithDatabaseError(res, error);
    }
});

// 🔴 WITHDRAWAL / DEPOSIT REJECTION
router.post('/admin/reject', adminOnly, async (req, res) => {
    const request = getAdminRequest(req);
    if (!request) return res.status(400).json({ success: false, message: 'Transaction ID is required' });

    try {
        const result = await withLock(`transaction:${request.transactionId}`, async () => {
            const transaction = await findPendingTransaction(request.transactionId);
            if (!transaction) return { notPending: true };
            const amount = parseAmount(transaction.amount);
            if (!amount || !['DEPOSIT', 'WITHDRAWAL'].includes(transaction.type)) return { invalid: true };

            const claimed = await setTransactionStatus(request.transactionId, 'REJECTED', request.adminNotes);
            if (!claimed) return { notPending: true };

            if (transaction.type === 'WITHDRAWAL') {
                try {
                    const refunded = await changeBalances(transaction.user_id, amount, -amount, 0, amount);
                    if (refunded.missing) throw new Error('User not found');
                    if (refunded.insufficient) throw new Error('Insufficient locked balance');
                } catch (error) {
                    await supabase.from('transactions').update({ status: 'PENDING' })
                        .eq('id', request.transactionId).eq('status', 'REJECTED');
                    throw error;
                }
            }
            return { transaction: claimed };
        });

        if (result.notPending) return res.status(409).json({ success: false, message: 'Transaction not found or already processed' });
        if (result.invalid) return res.status(400).json({ success: false, message: 'Invalid type or amount' });
        return res.json({ success: true, transaction: result.transaction });
    } catch (error) {
        return respondWithDatabaseError(res, error);
    }
});

// ==========================================
// 📱 DYNAMIC UPI & QR CODE MANAGEMENT
// ==========================================

router.get('/active-upi', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admin_upi_accounts')
            .select('id, upi_id, account_name, qr_image_url')
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!error && data && data.upi_id) {
            const cleanUpi = data.upi_id.trim();
            if (typeof db.setMerchantUpiId === 'function') {
                try { db.setMerchantUpiId(cleanUpi); } catch (_) {}
            }
            return res.json({
                success: true,
                upi: {
                    id: data.id,
                    upi_id: cleanUpi,
                    account_name: data.account_name || 'Dragon Alpha Official Payee',
                    qr_image_url: data.qr_image_url || ''
                },
                merchantUpiId: cleanUpi
            });
        }
    } catch (err) {
        console.error('Supabase active-upi lookup error:', err.message);
    }

    const fallbackUpi = typeof db.getMerchantUpiId === 'function' ? db.getMerchantUpiId() : '';
    if (fallbackUpi && fallbackUpi.trim()) {
        return res.json({
            success: true,
            upi: {
                id: 1,
                upi_id: fallbackUpi.trim(),
                account_name: 'Dragon Alpha Payee',
                qr_image_url: ''
            },
            merchantUpiId: fallbackUpi.trim()
        });
    }

    return res.status(404).json({
        success: false,
        message: 'No active UPI found. Please add or enable one in admin.'
    });
});

router.get('/admin/upi-list', adminOnly, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admin_upi_accounts')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.json({ success: true, accounts: data || [] });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/admin/add-upi', adminOnly, async (req, res) => {
    const { upi_id, account_name, qr_image_url, daily_limit, is_active } = req.body;
    if (!upi_id || !account_name) {
        return res.status(400).json({ success: false, message: 'UPI ID and account_name are required' });
    }

    try {
        const shouldBeActive = is_active !== undefined ? Boolean(is_active) : false;

        if (shouldBeActive) {
            await supabase.from('admin_upi_accounts').update({ is_active: false }).neq('id', -1);
        }

        const { data, error } = await supabase
            .from('admin_upi_accounts')
            .insert([{
                upi_id: upi_id.trim(),
                account_name: account_name.trim(),
                qr_image_url: qr_image_url ? qr_image_url.trim() : null,
                daily_limit: parseAmount(daily_limit) || 50000,
                is_active: shouldBeActive
            }])
            .select('*')
            .single();

        if (error) throw error;

        if (shouldBeActive && typeof db.setMerchantUpiId === 'function') {
            db.setMerchantUpiId(data.upi_id.trim());
        }

        return res.json({ success: true, message: 'UPI successfully added', upi: data });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/admin/toggle-upi', adminOnly, async (req, res) => {
    const { id, is_active } = req.body;
    if (id === undefined || is_active === undefined) {
        return res.status(400).json({ success: false, message: 'id and is_active are required' });
    }

    try {
        if (Boolean(is_active)) {
            await supabase
                .from('admin_upi_accounts')
                .update({ is_active: false })
                .neq('id', -1);

            const { data, error } = await supabase
                .from('admin_upi_accounts')
                .update({ is_active: true })
                .eq('id', id)
                .select('*')
                .single();

            if (error) throw error;

            if (data && data.upi_id && typeof db.setMerchantUpiId === 'function') {
                db.setMerchantUpiId(data.upi_id.trim());
            }

            return res.json({ success: true, message: 'UPI successfully activated', upi: data });
        } else {
            const { error } = await supabase
                .from('admin_upi_accounts')
                .update({ is_active: false })
                .eq('id', id);

            if (error) throw error;
            return res.json({ success: true, message: 'UPI disabled' });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/admin/delete-upi', adminOnly, async (req, res) => {
    const { id } = req.body;
    if (!id) {
        return res.status(400).json({ success: false, message: 'UPI ID is required' });
    }

    try {
        const { error } = await supabase
            .from('admin_upi_accounts')
            .delete()
            .eq('id', id);

        if (error) throw error;
        return res.json({ success: true, message: 'UPI deleted successfully' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.recordBetTurnover = recordBetTurnover;
module.exports = router;