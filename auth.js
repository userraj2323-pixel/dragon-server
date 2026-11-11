const express = require('express');
const crypto = require('crypto');
const supabase = require('./supabase');

const router = express.Router();

// 🔒 SHA-256 Password Encryption
function hashPassword(password) {
    return crypto.createHash('sha256').update(String(password).trim()).digest('hex');
}

// ==========================================
// 📱 1. REAL USER REGISTRATION API
// ==========================================
// Naya real player register hoga strictly ₹0.00 balance ke saath
router.post('/register', async (req, res) => {
    const { phone, password } = req.body || {};

    // 10-Digit Indian Mobile Number validation
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Kripya 10-digit ka valid mobile number dalein' 
        });
    }

    // Password validation (kam se kam 6 characters)
    const cleanPass = String(password || '').trim();
    if (!cleanPass || cleanPass.length < 6) {
        return res.status(400).json({ 
            success: false, 
            message: 'Password kam se kam 6 akshar ka hona chahiye' 
        });
    }

    try {
        // Pehle check karein ki ye number pehle se toh nahi bana hua
        const { data: existingUser, error: checkError } = await supabase
            .from('users')
            .select('id, phone')
            .eq('phone', cleanPhone)
            .maybeSingle();

        if (checkError) throw checkError;

        if (existingUser) {
            return res.status(409).json({ 
                success: false, 
                message: 'Yeh mobile number pehle se registered hai. Kripya login karein.' 
            });
        }

        const newUserId = crypto.randomUUID();
        const hashedPassword = hashPassword(cleanPass);

        // Naye real user ka account ₹0.00 balance ke saath create karein
        const { data: newUser, error: insertError } = await supabase
            .from('users')
            .insert([{
                id: newUserId,
                phone: cleanPhone,
                password_hash: hashedPassword,
                wallet_balance: 0.00,
                locked_balance: 0.00,
                turnover_required: 0.00,
                turnover_done: 0.00,
                is_verified: true
            }])
            .select('id, phone, wallet_balance')
            .single();

        if (insertError) throw insertError;

        return res.status(201).json({
            success: true,
            message: 'Registration safal raha!',
            user: {
                userId: newUser.id,
                phone: newUser.phone,
                walletBalance: Number(newUser.wallet_balance || 0)
            }
        });
    } catch (err) {
        console.error('Registration API Error:', err.message);
        return res.status(500).json({ 
            success: false, 
            message: 'Registration fail ho gaya: ' + err.message 
        });
    }
});

// ==========================================
// 🔐 2. REAL USER LOGIN API
// ==========================================
router.post('/login', async (req, res) => {
    const { phone, password } = req.body || {};

    const cleanPhone = String(phone || '').trim();
    const cleanPass = String(password || '').trim();

    if (!cleanPhone || !cleanPass) {
        return res.status(400).json({ 
            success: false, 
            message: 'Mobile number aur password dono zaroori hain' 
        });
    }

    try {
        const hashedPassword = hashPassword(cleanPass);

        const { data: user, error } = await supabase
            .from('users')
            .select('id, phone, password_hash, wallet_balance, is_verified')
            .eq('phone', cleanPhone)
            .maybeSingle();

        if (error) throw error;

        // Mobile number ya password galat hone par
        if (!user || user.password_hash !== hashedPassword) {
            return res.status(401).json({ 
                success: false, 
                message: 'Galat mobile number ya password!' 
            });
        }

        // Agar account block ya unverified ho
        if (user.is_verified === false) {
            return res.status(403).json({ 
                success: false, 
                message: 'Aapka account block hai. Admin se sampark karein.' 
            });
        }

        return res.json({
            success: true,
            message: 'Login safal raha!',
            user: {
                userId: user.id,
                phone: user.phone,
                walletBalance: Number(user.wallet_balance || 0)
            }
        });
    } catch (err) {
        console.error('Login API Error:', err.message);
        return res.status(500).json({ 
            success: false, 
            message: 'Login fail ho gaya: ' + err.message 
        });
    }
});

module.exports = router;