require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const nodemailer = require('nodemailer');

const SLEEPER_BASE = 'https://api.sleeper.app/v1';
const GITHUB_MODELS_URL = 'https://models.github.ai/inference/chat/completions';
const SLEEPER_USERNAME = 'jaredhagadorn';
const EMAIL_TO = 'jaredahagadorn@gmail.com';
const MODEL = 'openai/gpt-4o';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getCurrentSeason() {
  const now = new Date();
  return now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear();
}

// ─── Sleeper API ──────────────────────────────────────────────────────────────

async function sleeperGet(path) {
  const { data } = await axios.get(`${SLEEPER_BASE}${path}`);
  return data;
}

function extractPlayerInfo(playerId, playerMap) {
  const p = playerMap[playerId];
  if (!p) return { id: playerId, name: `Player ${playerId}`, position: 'UNK', team: null, age: null, status: 'Unknown' };
  return {
    id: playerId,
    name: [p.first_name, p.last_name].filter(Boolean).join(' ') || playerId,
    position: p.position || 'UNK',
    team: p.team || 'FA',
    age: p.age || null,
    status: p.injury_status || p.status || 'Active',
  };
}

function computeMyPicks(myRosterId, tradedPicks, league, season) {
  const futureSeasons = [season, season + 1, season + 2].map(String);
  const rounds = league.settings?.draft_rounds || 4;
  const picks = [];

  // Own picks not traded away
  for (const yr of futureSeasons) {
    for (let round = 1; round <= rounds; round++) {
      const tradedAway = tradedPicks.find(
        (p) => p.roster_id === myRosterId && String(p.season) === yr && p.round === round && p.owner_id !== myRosterId
      );
      if (!tradedAway) picks.push({ season: yr, round, type: 'own' });
    }
  }

  // Other teams' picks acquired via trade
  tradedPicks
    .filter((p) => p.owner_id === myRosterId && p.roster_id !== myRosterId && futureSeasons.includes(String(p.season)))
    .forEach((p) => picks.push({ season: String(p.season), round: p.round, type: 'acquired' }));

  return picks.sort((a, b) => a.season !== b.season ? a.season.localeCompare(b.season) : a.round - b.round);
}

async function fetchSleeperData() {
  console.log('Fetching Sleeper user data...');
  const user = await sleeperGet(`/user/${SLEEPER_USERNAME}`);
  const season = getCurrentSeason();

  console.log(`Fetching leagues for season ${season}...`);
  const leagues = await sleeperGet(`/user/${user.user_id}/leagues/nfl/${season}`);

  console.log('Fetching NFL player map (this is large)...');
  const playerMap = await sleeperGet('/players/nfl');

  console.log(`Found ${leagues.length} league(s). Fetching details...`);
  const leagueDetails = await Promise.all(
    leagues.map(async (league) => {
      const [rosters, users, tradedPicks] = await Promise.all([
        sleeperGet(`/league/${league.league_id}/rosters`),
        sleeperGet(`/league/${league.league_id}/users`),
        sleeperGet(`/league/${league.league_id}/traded_picks`),
      ]);

      const userMap = Object.fromEntries(users.map((u) => [u.user_id, u]));
      const myRoster = rosters.find((r) => r.owner_id === user.user_id);

      const standings = rosters
        .map((r) => ({
          rosterId: r.roster_id,
          userId: r.owner_id,
          username: userMap[r.owner_id]?.display_name || 'Unknown',
          isMe: r.owner_id === user.user_id,
          wins: r.settings?.wins ?? 0,
          losses: r.settings?.losses ?? 0,
          ties: r.settings?.ties ?? 0,
          pointsFor: r.settings?.fpts ?? 0,
          pointsAgainst: r.settings?.fpts_against ?? 0,
        }))
        .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);

      const myRosterPlayers = myRoster
        ? (myRoster.players || []).map((pid) => extractPlayerInfo(pid, playerMap))
        : [];

      // Compute full pick portfolio using roster_id (not user_id)
      const myPicks = myRoster
        ? computeMyPicks(myRoster.roster_id, tradedPicks || [], league, season)
        : [];

      return { league, myRoster, myRosterPlayers, myPicks, standings, userMap };
    })
  );

  return { user, season, leagueDetails, playerMap };
}

// ─── GitHub Models (GPT-4o via personal PAT) ─────────────────────────────────

async function callAI(prompt, system, retries = 3) {
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        GITHUB_MODELS_URL,
        { model: MODEL, messages, max_tokens: 1500 },
        { headers: { Authorization: `Bearer ${process.env.GH_MODELS_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      return response.data.choices[0].message.content;
    } catch (e) {
      const status = e.response?.status;
      const body = JSON.stringify(e.response?.data) || e.message;
      console.log(`  AI attempt ${attempt}/${retries} failed: HTTP ${status} — ${body}`);
      if (attempt < retries) { await sleep(attempt * 5000); }
    }
  }
  return 'Analysis unavailable — AI call failed (see logs)';
}

async function analyzeRoster(leagueDetail) {
  const { league, myRosterPlayers, myPicks, standings } = leagueDetail;
  const me = standings.find((s) => s.isMe);
  const record = me ? `${me.wins}-${me.losses}-${me.ties}` : 'N/A';

  const rosterText = myRosterPlayers
    .map((p) => `${p.name} | ${p.position} | ${p.team} | Age: ${p.age ?? '?'} | Status: ${p.status}`)
    .join('\n');

  const picksText = myPicks.length
    ? myPicks.map((p) => `${p.season} Round ${p.round}${p.type === 'acquired' ? ' (acquired)' : ''}`).join(', ')
    : 'None';

  return callAI(
    `League: "${league.name}" | Current record: ${record}\n\nRoster:\n${rosterText}\n\nFuture draft picks: ${picksText}\n\nProvide:\n1. Overall roster grade (A–F) with 2-sentence justification\n2. Top 3 strengths (including pick capital if relevant)\n3. Top 3 weaknesses or injury concerns\n4. One trade recommendation`,
    'You are an expert dynasty fantasy football analyst. Give concise, actionable roster evaluations that account for both current players and future draft capital. Use letter grades (A–F). Be direct and specific.'
  );
}

async function analyzeLeague(leagueDetail) {
  const { league, standings } = leagueDetail;

  const standingsText = standings
    .map((s, i) => `${i + 1}. ${s.username}${s.isMe ? ' (YOU)' : ''} — ${s.wins}-${s.losses}-${s.ties} | PF: ${s.pointsFor} | PA: ${s.pointsAgainst}`)
    .join('\n');

  const myRank = standings.findIndex((s) => s.isMe) + 1;

  return callAI(
    `League: "${league.name}"\n\nStandings:\n${standingsText}\n\nI am ranked ${myRank} of ${standings.length}.\n\nProvide:\n1. My competitive position (2–3 sentences)\n2. Who the biggest threats are and why\n3. Playoff odds assessment\n4. One strategic priority for the next week`,
    'You are an expert fantasy football analyst. Give sharp, insightful competitive analysis. Be honest about position in the standings.'
  );
}

async function fetchPlayerNews(myRosterPlayers) {
  // All skill position players — no artificial cap
  const players = myRosterPlayers
    .filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(p.position))
    .map((p) => `${p.name} (${p.position}, ${p.team})`)
    .join(', ');

  return callAI(
    `Provide injury status and fantasy football outlook for each of these players based on the most recent information you have. Give 1–2 sentences per player. Bold each player name.\n\nPlayers: ${players}`,
    'You are a fantasy football analyst with up-to-date knowledge of player injury statuses, depth charts, and weekly outlooks.'
  );
}

// ─── Email HTML builder ───────────────────────────────────────────────────────

function nl2br(text) {
  return text.replace(/\n/g, '<br>');
}

function buildEmailHtml({ season, leagueReports, generatedAt }) {
  const leagueSections = leagueReports
    .map(({ league, myRosterPlayers, myPicks, standings, rosterAnalysis, leagueAnalysis, playerNews }) => {
      const standingsRows = standings
        .map(
          (s, i) => `
          <tr style="${s.isMe ? 'background:#e8f4fd;font-weight:bold;' : ''}">
            <td style="padding:6px 10px;">${i + 1}</td>
            <td style="padding:6px 10px;">${s.username}${s.isMe ? ' ★' : ''}</td>
            <td style="padding:6px 10px;">${s.wins}-${s.losses}-${s.ties}</td>
            <td style="padding:6px 10px;">${Number(s.pointsFor).toFixed(1)}</td>
            <td style="padding:6px 10px;">${Number(s.pointsAgainst).toFixed(1)}</td>
          </tr>`
        )
        .join('');

      const rosterRows = myRosterPlayers
        .map(
          (p) => `
          <tr>
            <td style="padding:5px 10px;">${p.name}</td>
            <td style="padding:5px 10px;">${p.position}</td>
            <td style="padding:5px 10px;">${p.team}</td>
            <td style="padding:5px 10px;">${p.age ?? '—'}</td>
            <td style="padding:5px 10px;color:${p.status === 'Active' ? '#27ae60' : '#e74c3c'};">${p.status}</td>
          </tr>`
        )
        .join('');

      const picksHtml = myPicks.length
        ? myPicks
            .map(
              (p) =>
                `<span style="display:inline-block;margin:2px 4px;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;background:${p.type === 'acquired' ? '#faeeda' : '#eaf3de'};color:${p.type === 'acquired' ? '#854f0b' : '#3b6d11'};">${p.season} R${p.round}${p.type === 'acquired' ? ' ★' : ''}</span>`
            )
            .join('')
        : '<em style="color:#888;font-size:13px;">No future picks</em>';

      return `
      <div style="margin-bottom:48px;">
        <h2 style="background:#1a1a2e;color:#e94560;padding:14px 20px;border-radius:8px;margin:0 0 20px;">
          ${league.name} — ${season} Season
        </h2>

        <!-- Roster -->
        <h3 style="color:#1a1a2e;border-bottom:2px solid #e94560;padding-bottom:6px;">My Roster</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
          <thead>
            <tr style="background:#f0f0f0;">
              <th style="padding:8px 10px;text-align:left;">Player</th>
              <th style="padding:8px 10px;text-align:left;">Pos</th>
              <th style="padding:8px 10px;text-align:left;">Team</th>
              <th style="padding:8px 10px;text-align:left;">Age</th>
              <th style="padding:8px 10px;text-align:left;">Status</th>
            </tr>
          </thead>
          <tbody>${rosterRows}</tbody>
        </table>

        <!-- Future Picks -->
        <h3 style="color:#1a1a2e;border-bottom:2px solid #e94560;padding-bottom:6px;">Future Draft Picks</h3>
        <div style="margin-bottom:24px;padding:12px;background:#f9f9f9;border-radius:6px;">
          ${picksHtml}
          ${myPicks.some((p) => p.type === 'acquired') ? '<div style="font-size:11px;color:#888;margin-top:8px;">★ = acquired via trade</div>' : ''}
        </div>

        <!-- AI Roster Analysis -->
        <h3 style="color:#1a1a2e;border-bottom:2px solid #e94560;padding-bottom:6px;">AI Roster Analysis</h3>
        <div style="background:#f9f9f9;border-left:4px solid #e94560;padding:16px;border-radius:4px;margin-bottom:24px;font-size:14px;line-height:1.7;">
          ${nl2br(rosterAnalysis)}
        </div>

        <!-- League Standings -->
        <h3 style="color:#1a1a2e;border-bottom:2px solid #e94560;padding-bottom:6px;">League Standings</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
          <thead>
            <tr style="background:#f0f0f0;">
              <th style="padding:8px 10px;text-align:left;">#</th>
              <th style="padding:8px 10px;text-align:left;">Team</th>
              <th style="padding:8px 10px;text-align:left;">Record</th>
              <th style="padding:8px 10px;text-align:left;">PF</th>
              <th style="padding:8px 10px;text-align:left;">PA</th>
            </tr>
          </thead>
          <tbody>${standingsRows}</tbody>
        </table>

        <!-- League Comparison -->
        <h3 style="color:#1a1a2e;border-bottom:2px solid #e94560;padding-bottom:6px;">League Comparison & Strategy</h3>
        <div style="background:#f9f9f9;border-left:4px solid #e94560;padding:16px;border-radius:4px;margin-bottom:24px;font-size:14px;line-height:1.7;">
          ${nl2br(leagueAnalysis)}
        </div>

        <!-- Player News -->
        <h3 style="color:#1a1a2e;border-bottom:2px solid #e94560;padding-bottom:6px;">Player News & Injury Updates</h3>
        <div style="background:#f9f9f9;border-left:4px solid #27ae60;padding:16px;border-radius:4px;font-size:14px;line-height:1.7;">
          ${nl2br(playerNews)}
        </div>
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Fantasy Football Weekly Report</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <div style="max-width:760px;margin:20px auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
    <div style="background:#1a1a2e;padding:30px 30px 20px;text-align:center;">
      <h1 style="color:#e94560;margin:0;font-size:28px;">Fantasy Football Weekly Report</h1>
      <p style="color:#aaa;margin:8px 0 0;font-size:14px;">Generated ${generatedAt} | Powered by Claude AI</p>
    </div>
    <div style="padding:30px;">${leagueSections}</div>
    <div style="background:#1a1a2e;padding:16px;text-align:center;">
      <p style="color:#666;font-size:12px;margin:0;">Fantasy Football Report — jaredhagadorn on Sleeper</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Email sender ─────────────────────────────────────────────────────────────

async function sendEmail(html, subject) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: `"Fantasy Football Report" <${process.env.GMAIL_USER}>`,
    to: EMAIL_TO,
    subject,
    html,
  });
  console.log(`Email sent to ${EMAIL_TO}`);
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

async function runReport() {
  const startTime = Date.now();
  console.log('\n=== Fantasy Football Report Starting ===');
  console.log(new Date().toISOString());

  try {
    const { user, season, leagueDetails } = await fetchSleeperData();
    console.log(`User: ${user.display_name} | Leagues: ${leagueDetails.length}`);

    const leagueReports = await Promise.all(
      leagueDetails.map(async (detail) => {
        console.log(`\nAnalyzing league: ${detail.league.name}`);

        const [rosterAnalysis, leagueAnalysis, playerNews] = await Promise.all([
          analyzeRoster(detail).then((r) => { console.log('  ✓ Roster analysis done'); return r; }),
          analyzeLeague(detail).then((r) => { console.log('  ✓ League analysis done'); return r; }),
          fetchPlayerNews(detail.myRosterPlayers).then((r) => { console.log('  ✓ Player news done'); return r; }),
        ]);

        return { ...detail, rosterAnalysis, leagueAnalysis, playerNews };
      })
    );

    const generatedAt = new Date().toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const html = buildEmailHtml({ season, leagueReports, generatedAt });
    const subject = `Fantasy Football Report — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    await sendEmail(html, subject);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Report complete in ${elapsed}s ===\n`);
  } catch (err) {
    console.error('Report failed:', err.message);
    if (err.response?.data) console.error('API error:', JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  }
}

// ─── Schedule & entry point ───────────────────────────────────────────────────

const isDirectRun = require.main === module;

if (isDirectRun) {
  cron.schedule('0 8 * * 6', () => {
    console.log('Cron trigger: Saturday 8am');
    runReport();
  });
  console.log('Scheduler active — report runs every Saturday at 8:00 AM.');
  runReport();
}

module.exports = { runReport, sendWeeklyReport: runReport };
