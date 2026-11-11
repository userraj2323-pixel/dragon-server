require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Quotes aur spaces saaf karein
const clean = (val) => (val || '').trim().replace(/^["']|["']$/g, '');

const supabaseUrl = clean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);

console.log('----------------------------------------');
console.log('🌐 Supabase URL:', supabaseUrl);
// Key ka shuru aur aakhiri hissa print karega taaki pata chale asli key hai ya nahi
console.log('🔑 Key Preview :', supabaseKey ? `${supabaseKey.substring(0, 12)}...${supabaseKey.slice(-6)}` : '❌ EMPTY');
console.log('----------------------------------------');

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Error: Supabase URL ya Key gayab hai!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;