// ─────────────────────────────────────────────────────────────────────────────
// Real Deal Fitness — AB Challenge PP
// SMS Check-in Server (Express + Twilio + Supabase)
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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10)                      return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return `+${digits}`;
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

function twiml(res, message) {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`);
}

// ─── LEADERBOARD CALCULATION ─────────────────────────────────────────────────

async function updateLeaderboard(userId, startDate) {
  const { data: checkins } = await supabase
    .from('checkins')
    .select('challenge_day, completed_at')
    .eq('user_id', userId)
    .order('challenge_day');

  const completedDays = checkins?.length || 0;
  const maxDay        = checkins?.reduce((m, c) => Math.max(m, c.challenge_day), 0) || 0;
  const consistency   = maxDay > 0 ? Math.round((completedDays / maxDay) * 100) : 0;

  let totalTimeSeconds = null;
  let finishedAt       = null;

  if (completedDays === 28) {
    const last       = checkins[checkins.length - 1];
    finishedAt       = last.completed_at;
    totalTimeSeconds = Math.floor((new Date(finishedAt) - new Date(startDate)) / 1000);
  }

  await supabase.from('leaderboard').upsert(
    { user_id: userId, completed_days: completedDays, consistency_score: consistency,
      total_time_seconds: totalTimeSeconds, finished_at: finishedAt,
      updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );

  await recalculateRanks();
}

async function recalculateRanks() {
  const { data: rows } = await supabase
    .from('leaderboard')
    .select('user_id, completed_days, total_time_seconds, consistency_score');

  if (!rows?.length) return;

  // Ranking: finishers sorted by speed → then by days done + consistency
  const sorted = [...rows].sort((a, b) => {
    if (a.total_time_seconds && b.total_time_seconds)
      return a.total_time_seconds - b.total_time_seconds;
    if (a.total_time_seconds) return -1;
    if (b.total_time_seconds) return  1;
    if (b.completed_days !== a.completed_days)
      return b.completed_days - a.completed_days;
    return b.consistency_score - a.consistency_score;
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

// ── POST /checkin — Twilio inbound SMS webhook ────────────────────────────────
app.post('/checkin', async (req, res) => {
  const phone = normalizePhone(req.body.From || '');
  const body  = (req.body.Body || '').trim().toUpperCase();

  // 1. Look up user
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('phone_number', phone)
    .single();

  if (!user) {
    return twiml(res,
      `Hey! You're not registered for the AB Challenge yet. ` +
      `Visit ${process.env.APP_URL || '[app URL]'} to sign up. 💪`
    );
  }

  if (!user.start_date) {
    return twiml(res, `Your challenge hasn't started yet. Open the app to begin. 🔥`);
  }

  // 2. Only accept "DONE"
  if (body !== 'DONE') {
    return twiml(res,
      `Text DONE after finishing your workout to log today's check-in. Keep grinding, ${user.name}! 💪`
    );
  }

  const challengeDay = getChallengeDay(user.start_date);
  const week         = Math.ceil(challengeDay / 7);
  const dayOfWeek    = ((challengeDay - 1) % 7) + 1;

  // 3. Check for duplicate check-in today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: existing } = await supabase
    .from('checkins')
    .select('id')
    .eq('user_id', user.id)
    .eq('challenge_day', challengeDay)
    .gte('completed_at', todayStart.toISOString())
    .maybeSingle();

  if (existing) {
    return twiml(res,
      `You already checked in for Day ${challengeDay} today, ${user.name}! 🏆 ` +
      `Come back tomorrow for Day ${Math.min(challengeDay + 1, 28)}.`
    );
  }

  // 4. Log the check-in
  const expectedTime = new Date(user.start_date).getTime() + (challengeDay - 1) * 86_400_000;
  const isLate       = Date.now() > expectedTime + 86_400_000;

  const { error: ciErr } = await supabase.from('checkins').insert({
    user_id:       user.id,
    week,
    day_of_week:   dayOfWeek,
    challenge_day: challengeDay,
    is_late:       isLate,
  });

  if (ciErr) {
    console.error('Check-in insert error:', ciErr);
    return twiml(res, `Something went wrong logging your check-in. Try again in a moment.`);
  }

  // 5. Update leaderboard
  await updateLeaderboard(user.id, user.start_date);

  // 6. Get updated rank
  const { data: lb } = await supabase
    .from('leaderboard')
    .select('rank, completed_days')
    .eq('user_id', user.id)
    .single();

  const rank = lb?.rank || '?';
  const days = lb?.completed_days || challengeDay;

  // 7. Respond
  if (challengeDay === 28) {
    return twiml(res,
      `🏆 YOU FINISHED THE AB CHALLENGE, ${user.name}! ` +
      `28 days complete. Final rank: #${rank}. REAL DEAL. 🔥🔥🔥`
    );
  }

  const lateNote = isLate ? ' (logged late)' : '';
  return twiml(res,
    `✅ Day ${challengeDay}/28 logged${lateNote}! ` +
    `You're ranked #${rank}, ${user.name}. Week ${week} — keep grinding. 💪`
  );
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
    { user_id: data.id, completed_days: 0, consistency_score: 0, rank: 9999 },
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
    completedDays: checkins?.map(c => c.challenge_day) || [],
    leaderboard:   { rank: lb?.rank, consistency: lb?.consistency_score, time: formatTime(lb?.total_time_seconds) },
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`🔥 RDF AB Challenge server running on port ${PORT}`)
);
