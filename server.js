// ─────────────────────────────────────────────────────────────────────────────
// Real Deal Fitness — AB Challenge PP
// WhatsApp + SMS Check-in Server (Express + Twilio + Supabase)
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json());

// CORS — allow the hosted frontend to call /leaderboard and /user
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Supabase client (uses service role key so we bypass RLS) ─────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function normalizePhone(raw = '') {
  // WhatsApp numbers arrive as "whatsapp:+12345678900" — strip the prefix first
  const stripped = raw.replace(/^whatsapp:/i, '');
  const digits   = stripped.replace(/\D/g, '');
  if (digits.length === 10)                      return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return `+${digits}`;
}

function isWhatsApp(raw = '') {
  return raw.toLowerCase().startsWith('whatsapp:');
}

// Reply helper — auto-detects WhatsApp vs SMS and formats TwiML accordingly
function twimlReply(res, message, fromNumber) {
  const wa = isWhatsApp(fromNumber);
  res.set('Content-Type', 'text/xml');
  if (wa) {
    // WhatsApp responses need the <Message> to include a To back to whatsapp:
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`);
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`);
  }
}

function getChallengeDay(startDate) {
  const diffMs   = Date.now() - new Date(startDate).getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  return Math.min(Math.max(diffDays + 1, 1), 28);
}

function formatTime(totalSeconds) {
  if (!totalSeconds) return '—';
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}


// ─── SCORING ─────────────────────────────────────────────────────────────────
//  Points per workout:
//    Base 10 pts × streak multiplier
//    Streak pos in week:  1→×1.0  2→×1.1  3→×1.2  4→×1.3  5→×1.4  6→×1.5  7→×2.0
//    Every 7 consecutive days: +5 BONUS pts
//  A missed day resets the streak multiplier back to ×1.0
function calculateScore(checkinDays) {
  // checkinDays: sorted array of challenge day numbers e.g. [1,2,3,5,6]
  let score  = 0;
  let streak = 0;

  for (let i = 0; i < checkinDays.length; i++) {
    const day  = checkinDays[i];
    const prev = i > 0 ? checkinDays[i - 1] : null;

    streak = (prev !== null && day === prev + 1) ? streak + 1 : 1;

    const posInWeek  = ((streak - 1) % 7) + 1;
    const multiplier = posInWeek === 7 ? 2.0 : 1.0 + (posInWeek - 1) * 0.1;
    const bonus      = streak % 7 === 0 ? 5 : 0;

    score += Math.round(10 * multiplier) + bonus;
  }
  return score;
}

// ─── LEADERBOARD CALCULATION ─────────────────────────────────────────────────

async function updateLeaderboard(userId, startDate) {
  const { data: checkins } = await supabase
    .from('checkins')
    .select('challenge_day, completed_at')
    .eq('user_id', userId)
    .order('challenge_day');

  const days  = [...new Set(checkins?.map(c => c.challenge_day) || [])].sort((a,b) => a-b);
  const completedDays = days.length;
  const maxDay        = days.length > 0 ? Math.max(...days) : 0;
  const consistency   = maxDay > 0 ? Math.round((completedDays / maxDay) * 100) : 0;

  let totalTimeSeconds = null;
  let finishedAt       = null;

  if (completedDays === 28) {
    const last       = checkins[checkins.length - 1];
    finishedAt       = last.completed_at;
    totalTimeSeconds = Math.floor((new Date(finishedAt) - new Date(startDate)) / 1000);
  }

  const score = calculateScore(days);

  await supabase.from('leaderboard').upsert(
    { user_id: userId, completed_days: completedDays, consistency_score: consistency,
      total_time_seconds: totalTimeSeconds, finished_at: finishedAt,
      score, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );

  await recalculateRanks();
}

async function recalculateRanks() {
  const { data: rows } = await supabase
    .from('leaderboard')
    .select('user_id, completed_days, total_time_seconds, consistency_score, score');

  if (!rows?.length) return;

  // Primary: highest score wins. Tiebreak: most days, then fastest finish time.
  const sorted = [...rows].sort((a, b) => {
    const sa = a.score || 0, sb = b.score || 0;
    if (sb !== sa) return sb - sa;
    if (b.completed_days !== a.completed_days) return b.completed_days - a.completed_days;
    if (a.total_time_seconds && b.total_time_seconds) return a.total_time_seconds - b.total_time_seconds;
    return 0;
  });

  // Batch-update ranks
  await Promise.all(
    sorted.map((row, i) =>
      supabase.from('leaderboard').update({ rank: i + 1 }).eq('user_id', row.user_id)
    )
  );
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'RDF AB Challenge', ts: new Date().toISOString() })
);

// ── POST /checkin — handles BOTH Twilio WhatsApp/SMS AND in-app JSON check-ins
app.post('/checkin', async (req, res) => {
  const isApp   = !req.body.From;                         // app sends JSON; Twilio sends From
  const rawFrom = req.body.From || '';
  const phone   = isApp ? normalizePhone(req.body.phone || '') : normalizePhone(rawFrom);
  const reply   = (msg) => isApp ? res.json({ message: msg }) : twimlReply(res, msg, rawFrom);

  // 1. Validate "DONE" for WhatsApp (app skips this check)
  if (!isApp) {
    const body = (req.body.Body || '').trim().toUpperCase();
    if (body !== 'DONE') {
      return reply(`Text DONE after finishing your workout to log today's check-in. Keep grinding! 💪`);
    }
  }

  // 2. Look up user
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('phone_number', phone)
    .single();

  if (!user) {
    if (isApp) return res.status(404).json({ error: 'User not found. Please register first.' });
    return reply(`Hey! You're not registered yet. Visit ${process.env.APP_URL || '[app URL]'} to sign up. 💪`);
  }

  if (!user.start_date) {
    return reply(`Your challenge hasn't started yet. Open the app to begin. 🔥`);
  }

  const challengeDay = isApp ? (parseInt(req.body.day) || getChallengeDay(user.start_date))
                              : getChallengeDay(user.start_date);
  const week         = Math.ceil(challengeDay / 7);
  const dayOfWeek    = ((challengeDay - 1) % 7) + 1;

  // 3a. Per-day duplicate guard — never allow 2 check-ins for the same challenge day
  const { data: dayExists } = await supabase
    .from('checkins')
    .select('id')
    .eq('user_id', user.id)
    .eq('challenge_day', challengeDay)
    .limit(1);

  if (dayExists && dayExists.length > 0) {
    if (isApp) return res.status(429).json({ error: `Day ${challengeDay} already logged! Complete tomorrow's workout to advance. 🔥`, hoursLeft: 24 });
    return reply(`Day ${challengeDay} already logged, ${user.name}! Come back tomorrow. 🏆`);
  }

  // 3b. 12-hour rolling guard — extra protection against rapid re-submissions
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from('checkins')
    .select('id, challenge_day, completed_at')
    .eq('user_id', user.id)
    .gte('completed_at', twelveHoursAgo)
    .order('completed_at', { ascending: false })
    .limit(1);

  if (recent && recent.length > 0) {
    const lastCheckin = new Date(recent[0].completed_at);
    const hoursLeft   = Math.ceil((lastCheckin.getTime() + 12*3600000 - Date.now()) / 3600000);
    if (isApp) return res.status(429).json({
      error: `Already logged! Come back in ${hoursLeft}h to log your next workout. 🔥`,
      hoursLeft
    });
    return reply(`You already checked in recently, ${user.name}! Come back in ${hoursLeft}h. 🏆`);
  }

  // 4. Log the check-in
  const { error: ciErr } = await supabase.from('checkins').insert({
    user_id:       user.id,
    week,
    day_of_week:   dayOfWeek,
    challenge_day: challengeDay,
    is_late:       false,
  });

  if (ciErr) {
    console.error('Check-in insert error:', ciErr);
    if (isApp) return res.status(500).json({ error: 'Check-in failed. Try again.' });
    return reply(`Something went wrong logging your check-in. Try again in a moment.`);
  }

  // 5. Update leaderboard
  await updateLeaderboard(user.id, user.start_date);

  // 6. Get updated rank + score
  const { data: lb } = await supabase
    .from('leaderboard')
    .select('rank, completed_days, score')
    .eq('user_id', user.id)
    .single();

  const rank  = lb?.rank  || '?';
  const score = lb?.score || 0;

  // 7. Respond
  if (isApp) {
    return res.json({ success: true, day: challengeDay, rank, score,
      message: challengeDay === 28
        ? `🏆 YOU FINISHED! 28 days complete. Final rank: #${rank}. REAL DEAL!`
        : `Day ${challengeDay}/28 logged! Rank #${rank} · ${score} pts 🔥` });
  }

  if (challengeDay === 28) {
    return reply(`🏆 YOU FINISHED THE AB CHALLENGE, ${user.name}! 28 days complete. Final rank: #${rank}. REAL DEAL. 🔥🔥🔥`);
  }
  return reply(`✅ Day ${challengeDay}/28 logged! Rank #${rank} · ${score} pts. Keep grinding, ${user.name}. 💪`);
});

// ── POST /register — called from the app's signup screen ─────────────────────
app.post('/register', async (req, res) => {
  const { name, phone, level } = req.body;

  if (!name || !phone || !level) {
    return res.status(400).json({ error: 'name, phone, and level are required' });
  }

  const validLevels = ['Beginner', 'Intermediate', 'Advanced'];
  if (!validLevels.includes(level)) {
    return res.status(400).json({ error: `level must be one of: ${validLevels.join(', ')}` });
  }

  const normalizedPhone = normalizePhone(phone);

  const { data, error } = await supabase
    .from('users')
    .upsert(
      { phone_number: normalizedPhone, name, level, start_date: new Date().toISOString() },
      { onConflict: 'phone_number' }
    )
    .select()
    .single();

  if (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Registration failed. Try again.' });
  }

  // Seed leaderboard row
  await supabase.from('leaderboard').upsert(
    { user_id: data.id, completed_days: 0, consistency_score: 0, score: 0, rank: 9999 },
    { onConflict: 'user_id' }
  );

  res.json({ success: true, userId: data.id });
});

// ── GET /leaderboard — public leaderboard for the frontend ───────────────────
app.get('/leaderboard', async (_req, res) => {
  const { data, error } = await supabase
    .from('leaderboard')
    .select(`
      rank,
      completed_days,
      total_time_seconds,
      consistency_score,
      score,
      finished_at,
      users ( name, level )
    `)
    .order('rank')
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });

  res.json(
    data.map(row => ({
      rank:         row.rank,
      name:         row.users?.name  || 'Unknown',
      level:        row.users?.level || 'Beginner',
      daysComplete: row.completed_days,
      score:        row.score || 0,
      time:         formatTime(row.total_time_seconds),
      consistency:  row.consistency_score,
      finished:     !!row.finished_at,
    }))
  );
});

// ── GET /user/:phone — user progress (called by the app after login) ──────────
app.get('/user/:phone', async (req, res) => {
  const phone = normalizePhone(req.params.phone);

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('phone_number', phone)
    .single();

  if (!user) return res.status(404).json({ error: 'User not found' });

  const { data: checkins } = await supabase
    .from('checkins')
    .select('challenge_day, completed_at, is_late')
    .eq('user_id', user.id)
    .order('challenge_day');

  const { data: lb } = await supabase
    .from('leaderboard')
    .select('rank, consistency_score, total_time_seconds, completed_days')
    .eq('user_id', user.id)
    .single();

  res.json({
    user:          { name: user.name, level: user.level, startDate: user.start_date },
    challengeDay:  getChallengeDay(user.start_date),
    completedDays: [...new Set(checkins?.map(c => c.challenge_day) || [])].sort((a,b)=>a-b),
    leaderboard:   { rank: lb?.rank, consistency: lb?.consistency_score, time: formatTime(lb?.total_time_seconds) },
  });
});

// ── GET /admin/users — full roster for admin panel ───────────────────────────
app.get('/admin/users', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { data, error } = await supabase
    .from('leaderboard')
    .select(`rank, completed_days, consistency_score, total_time_seconds,
             users ( name, phone_number, level, start_date, created_at )`)
    .order('rank');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── DELETE /user/:phone — admin: remove a user ────────────────────────────────
app.delete('/user/:phone', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const phone = normalizePhone(req.params.phone);
  const { error } = await supabase.from('users').delete().eq('phone_number', phone);
  if (error) return res.status(500).json({ error: error.message });
  await recalculateRanks();
  res.json({ success: true });
});

// ── GET /admin/recalculate?key=ADMINKEY — open in browser to recompute all scores
app.get('/admin/recalculate', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { data: users, error } = await supabase.from('users').select('id, name');
  if (error || !users) return res.status(500).json({ error: 'Failed to fetch users' });

  const results = [];
  for (const user of users) {
    try {
      await updateLeaderboard(user.id);
      results.push({ name: user.name, status: 'ok' });
    } catch (e) {
      results.push({ name: user.name, status: 'error', message: e.message });
    }
  }
  await recalculateRanks();
  res.json({ recalculated: results.length, results });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`🔥 RDF AB Challenge server running on port ${PORT}`)
);
