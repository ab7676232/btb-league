import { fantasyPoints, pairs, allPlay, standings, strengths, simulate, winChance, playerAverage, strengthSd, starterCount, liveWinChance } from './logic.js'

// BeneathTheBoxscore's league page: scores, lineups, standings, odds, awards,
// players, moves, head to head, trades and the draft, read live from Sleeper
// in the browser. Scores are counted the way the Sleeper app counts them: each
// starter's locked game from Sleeper's lineup data, scored from the box score.
// Team names are never shown (managers appear by Sleeper username).

const LEAGUE_ID = '1394804447258869760'
const API_ROOT = 'https://api.sleeper.app'
const API = `${API_ROOT}/v1`
const STATS = 'https://api.sleeper.com'
const GRAPHQL = 'https://sleeper.com/graphql'
const faceUrl = (pid) => `https://sleepercdn.com/content/nba/players/thumb/${pid}.jpg`
const avatarUrl = (id) => `https://sleepercdn.com/avatars/thumbs/${id}`
const REFRESH_MS = 2 * 60 * 1000
const FETCH_POOL = 4
const FIRST_SIMS = 4000
const MORE_SIMS = 10000
const LIST_ROWS = 8
const MOVES_ROWS = 15
const VETERAN_SEASONS = 10
const HURT = new Set(['Out', 'IR', 'Sus'])
const BENCH = new Set(['BN', 'IR', 'TAXI'])
const BACKCOURT = new Set(['PG', 'SG', 'G'])
const FRONTCOURT = new Set(['SF', 'PF', 'F', 'C'])
const UTILITY = new Set(['UTIL'])
const COLORS = ['#d9480f', '#1c7ed6', '#c2255c', '#2b8a3e', '#7048e8', '#e67700', '#0b7285', '#5c3d2e']
const ME_KEY = 'btb-me'

// how much of a hurt player's average his team's season estimate keeps: a rest day costs
// nothing, surgery or IR a big share, any other Out a little
function healthWeight(p) {
  if (!p?.inj || p.inj === 'GTD' || p.inj === 'DTD' || p.inj === 'Questionable') return 1
  if (p.inj === 'IR' || p.inj === 'Sus' || /surgery/i.test(p.notes || '')) return 0.5
  return /rest/i.test(p.part || '') ? 1 : 0.85
}

const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch { /* private window or full */ } },
}
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const f1 = (x) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(1))
const f2 = (x) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(2))
const pct = (x) => (x >= 0.995 ? '>99%' : x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`)
const ord = (n) => `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const round2 = (x) => Math.round(x * 100) / 100
// the Sleeper app rounds a projected total the way toFixed does (259.545 up, 280.695 down)
const fixed2 = (x) => Number(x.toFixed(2))
const maxBy = (xs, fn) => xs.reduce((best, x) => (best == null || fn(x) > fn(best) ? x : best), null)
const minBy = (xs, fn) => maxBy(xs, (x) => -fn(x))
const dateOf = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const isPlayer = (r) => /^\d+$/.test(r.player_id)

async function getJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sleeper answered ${res.status}.`)
  return res.json()
}
async function gql(query) {
  const res = await fetch(GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
  if (!res.ok) throw new Error(`Sleeper answered ${res.status}.`)
  const body = await res.json()
  if (body.errors?.length) throw new Error('Sleeper would not share the lineups right now.')
  return body.data
}
async function pool(items, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(FETCH_POOL, items.length) }, worker))
  return out
}

const S = { ready: false, error: null, weeks: {}, finals: {} }
const V = { week: null, me: Number(store.get(ME_KEY)) || null, forced: {}, pickedCell: null, open: new Set(), tally: null, h2h: [null, null] }

// ---- loading -------------------------------------------------------------

/** One week of lineups, locks and box scores (and projections for a live week). */
async function loadWeek(week, fresh = false) {
  if (S.weeks[week] && !fresh) return S.weeks[week]
  const live = week === S.current && S.inSeason
  const [legs, rows, projRows] = await Promise.all([
    gql(`{ matchup_legs_raw(league_id: "${LEAGUE_ID}", round: ${week}) { roster_id matchup_id starters starters_games players } }`).then((d) => d.matchup_legs_raw || []),
    getJSON(`${STATS}/stats/nba/${S.season}/${week}?season_type=regular`),
    live ? getJSON(`${STATS}/projections/nba/${S.season}/${week}?season_type=regular`).catch(() => []) : Promise.resolve([]),
  ])
  const score = new Map()
  const games = {}
  const team = {}
  for (const r of (rows || []).filter(isPlayer).sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const played = r.stats?.sp > 0 || r.stats?.min > 0
    const fp = played ? fantasyPoints(r.stats, S.scoring) : 0
    score.set(`${r.player_id}:${r.game_id}`, fp)
    team[r.player_id] = r.team
    if (played) (games[r.player_id] ||= []).push({ gid: r.game_id, date: r.date, fp })
  }
  const proj = new Map((projRows || []).filter((r) => isPlayer(r) && r.stats && Object.keys(r.stats).length)
    .map((r) => [`${r.player_id}:${r.game_id}`, fantasyPoints(r.stats, S.scoring)]))
  S.weeks[week] = { legs, score, games, team, proj }
  return S.weeks[week]
}

/** A finished week's totals, from this device's copy once worked out. */
async function loadFinal(week) {
  const key = `btb:${S.season}:${week}`
  const saved = store.get(key)
  if (saved) {
    try { S.finals[week] = JSON.parse(saved); return } catch { /* work it out again */ }
  }
  await loadWeek(week)
  S.finals[week] = sidesOf(week).map(({ roster_id, matchup_id, points }) => ({ roster_id, matchup_id, points }))
  store.set(key, JSON.stringify(S.finals[week]))
}

async function loadAll() {
  const [state, league, rosters, users] = await Promise.all([
    getJSON(`${API}/state/nba`), getJSON(`${API}/league/${LEAGUE_ID}`),
    getJSON(`${API}/league/${LEAGUE_ID}/rosters`), getJSON(`${API}/league/${LEAGUE_ID}/users`),
  ])
  S.season = league.season
  S.league = league
  S.rosters = rosters
  S.users = users
  S.scoring = league.scoring_settings || {}
  S.playoffStart = Number(league.settings?.playoff_week_start) || 22
  S.lastRegular = S.playoffStart - 1
  S.current = Math.max(1, Math.min(Number(state.display_week || state.week) || 1, S.lastRegular))
  S.inSeason = state.season_type === 'regular' && String(state.season) === String(S.season)
  const played = Array.from({ length: S.current }, (_, i) => i + 1)
  const future = Array.from({ length: S.lastRegular - S.current }, (_, i) => S.current + 1 + i)
  const [pairings, transactions, picks, tradedPicks, season, weekly, lastSeason, schedule] = await Promise.all([
    pool(future, (w) => getJSON(`${API}/league/${LEAGUE_ID}/matchups/${w}`)),
    pool(played, (w) => getJSON(`${API}/league/${LEAGUE_ID}/transactions/${w}`)),
    getJSON(`${API}/draft/${league.draft_id}/picks`),
    getJSON(`${API}/league/${LEAGUE_ID}/traded_picks`),
    getJSON(`${STATS}/stats/nba/${S.season}?season_type=regular`),
    pool(played, (w) => getJSON(`${API}/stats/nba/regular/${S.season}/${w}`)),
    getJSON(`${STATS}/stats/nba/${Number(S.season) - 1}?season_type=regular`).catch(() => []),
    getJSON(`${API_ROOT}/schedule/nba/regular/${S.season}`),
  ])
  S.pairings = Object.fromEntries(future.map((w, i) => [w, pairings[i] || []]))
  S.transactions = transactions.flat().filter(Boolean)
  S.picks = picks || []
  S.tradedPicks = tradedPicks || []
  S.weekly = Object.fromEntries(played.map((w, i) => [w, weekly[i] || {}]))
  S.lastAvg = {}
  for (const r of lastSeason || []) {
    const gp = r.stats?.gp || 0
    if (isPlayer(r) && gp) S.lastAvg[r.player_id] = fantasyPoints(r.stats, S.scoring) / gp
  }
  readSchedule(schedule)
  readSeason(season)
  await loadWeek(S.current)
  await pool(played.filter((w) => weekFinal(w)), loadFinal)
  if (V.week == null || V.week > S.current) V.week = S.current
  await loadWeek(V.week)
}

/** Live refresh: this week's lineups and box scores, the season line and the NBA schedule. */
async function refresh() {
  const w = S.current
  const [season, weekly, schedule] = await Promise.all([
    getJSON(`${STATS}/stats/nba/${S.season}?season_type=regular`),
    getJSON(`${API}/stats/nba/regular/${S.season}/${w}`),
    getJSON(`${API_ROOT}/schedule/nba/regular/${S.season}`).catch(() => null),
    loadWeek(w, true),
  ])
  S.weekly[w] = weekly || {}
  if (schedule) readSchedule(schedule)
  readSeason(season)
}

function readSchedule(games) {
  S.teamWeek = {}
  for (const g of games || []) {
    if (g.status === 'postponed' || g.status === 'canceled') continue
    for (const t of [g.home?.team, g.away?.team]) if (t) ((S.teamWeek[t] ||= {})[g.week] ||= []).push(g)
  }
}

function readSeason(rows) {
  S.players = {}
  for (const r of (rows || []).filter(isPlayer)) {
    const p = r.player || {}
    const gp = r.stats?.gp || 0
    const fp = fantasyPoints(r.stats, S.scoring)
    S.players[r.player_id] = {
      n: [p.first_name, p.last_name].filter(Boolean).join(' ') || `Player ${r.player_id}`,
      t: r.team || p.team || 'FA', pos: (p.fantasy_positions || []).join('/'), inj: p.injury_status || null,
      part: p.injury_body_part || null, notes: p.injury_notes || null,
      exp: p.years_exp, gp, fp, avg: gp ? fp / gp : 0, steady: playerAverage(fp, gp, S.lastAvg?.[r.player_id] ?? null),
    }
  }
}

// ---- a week's scores, counted like the app -------------------------------

function sidesOf(week) {
  const W = S.weeks[week]
  if (!W) return []
  const positions = S.league.roster_positions || []
  return W.legs.map((leg) => {
    const startList = leg.starters || []
    const starters = startList.map((pid, i) => {
      const slot = positions[i] || ''
      if (!pid || pid === '0') return { pid: null, slot, state: 'empty', pts: 0, proj: 0, games: [], best: 0 }
      const tg = (S.teamWeek[W.team[pid] || S.players[pid]?.t]?.[week] || [])
        .map((g) => ({ id: g.game_id, date: g.date, done: g.status === 'complete' }))
        .sort((a, b) => a.date.localeCompare(b.date))
      const scoreIn = (id) => W.score.get(`${pid}:${id}`) ?? 0
      const lockedGame = leg.starters_games?.[pid] || null
      const c = starterCount({ lockedGame, teamGames: tg, scoreIn, projIn: (id) => W.proj.get(`${pid}:${id}`) ?? 0 })
      const games = W.games[pid] || []
      const lockedOn = lockedGame ? tg.find((g) => g.id === lockedGame)?.date : null
      const after = lockedOn ? games.filter((g) => g.date > lockedOn) : []
      const teamDone = tg.length && tg.every((g) => g.done)
      return {
        pid, slot, ...c, games, best: games.length ? Math.max(...games.map((g) => g.fp)) : 0,
        // a lock's alternatives: his best game after it, and what would have counted without it
        bestAfter: after.length ? Math.max(...after.map((g) => g.fp)) : null,
        instead: c.state === 'locked' && teamDone && tg[tg.length - 1].id !== lockedGame ? scoreIn(tg[tg.length - 1].id) : null,
      }
    })
    const points = round2(sum(starters.map((s) => s.pts)))
    const bench = (leg.players || []).filter((p) => !startList.includes(p)).map((pid) => {
      const games = W.games[pid] || []
      return { pid, best: games.length ? Math.max(...games.map((g) => g.fp)) : 0 }
    })
    return { roster_id: leg.roster_id, matchup_id: leg.matchup_id, points, proj: fixed2(points + sum(starters.map((s) => s.proj))), starters, bench }
  })
}

const pendingOf = (side) => side.starters.filter((s) => s.state === 'pending')
const liveChance = (a, b) => liveWinChance(a.proj, b.proj, [...pendingOf(a), ...pendingOf(b)].map((s) => s.proj))

// ---- derived -------------------------------------------------------------

function managers() {
  const byUser = new Map(S.users.map((u) => [u.user_id, u]))
  return new Map([...S.rosters].sort((a, b) => a.roster_id - b.roster_id).map((r, i) => {
    const u = byUser.get(r.owner_id) || {}
    return [r.roster_id, { rid: r.roster_id, name: u.display_name || `Team ${r.roster_id}`, avatar: u.avatar, color: COLORS[i % COLORS.length], roster: r }]
  }))
}

const slotsOf = () => (S.league.roster_positions || []).filter((p) => !BENCH.has(p))
const weekFinal = (w) => w < S.current || !S.inSeason

function derive() {
  const M = managers()
  const rids = [...M.keys()]
  const owner = new Map(S.rosters.flatMap((r) => (r.players || []).map((pid) => [pid, r.roster_id])))
  const finished = Object.keys(S.finals).map(Number).sort((a, b) => a - b)
  const table = standings(rids, finished.map((w) => S.finals[w]))
  const scores = Object.fromEntries(table.map((row) => [row.rid, row.scores]))
  const rosterAvg = Object.fromEntries(rids.map((r) => [r, (M.get(r).roster.players || [])
    .map((pid) => (S.players[pid]?.steady || 0) * healthWeight(S.players[pid]))]))
  const strength = strengths(rosterAvg, scores, slotsOf().length)
  const doubt = strengthSd(finished.length)
  const currentSides = sidesOf(S.current)
  const live = weekFinal(S.current) ? [] : pairs(currentSides).map((p) => p.map((s) => ({ roster_id: s.roster_id, points: s.proj })))
  // 0-0 ties before any week is final go to this week's score so far
  const liveNow = Object.fromEntries(currentSides.map((s) => [s.roster_id, s.points]))
  table.sort((a, b) => b.w - a.w || a.l - b.l || b.pf - a.pf || (liveNow[b.rid] || 0) - (liveNow[a.rid] || 0))
  const futureWeeks = Object.keys(S.pairings).map(Number).sort((a, b) => a - b)
  const schedule = futureWeeks.map((w) => pairs(S.pairings[w]).map(([a, b]) => [a.roster_id, b.roster_id]))
  const weekSides = V.week === S.current ? currentSides : sidesOf(V.week)
  return { M, rids, owner, finished, table, strength, doubt, live, futureWeeks, schedule, currentSides, weekSides }
}

function runSims(n) {
  const d = derive()
  V.tally = simulate({ rids: d.rids, strength: d.strength, table: d.table, live: d.live, schedule: d.schedule,
    forced: V.forced, playoffTeams: Number(S.league.settings?.playoff_teams) || 6, n, doubt: d.doubt })
}

// ---- pieces --------------------------------------------------------------

let D = null
const mc = (rid) => `--mc:${D.M.get(rid).color}`
const nameOf = (rid) => esc(D.M.get(rid)?.name || '')
function av(rid) {
  const m = D.M.get(rid)
  return `<span class="av" style="${mc(rid)}">${m.avatar ? `<img src="${avatarUrl(m.avatar)}" alt="" loading="lazy">` : ''}</span>`
}
const mgr = (rid) => `<span class="mgr" style="${mc(rid)}">${av(rid)}<b>${nameOf(rid)}</b>${rid === V.me ? '<span class="me-tag">You</span>' : ''}</span>`
function face(pid) {
  const initials = (S.players[pid]?.n || '?').split(' ').map((w) => w[0]).slice(0, 2).join('')
  return `<span class="face" aria-hidden="true"><span>${esc(initials)}</span><img src="${faceUrl(pid)}" alt="" loading="lazy" onerror="this.remove()"></span>`
}
const pname = (pid) => esc(S.players[pid]?.n || S.picks.find((p) => p.player_id === pid)?.metadata?.last_name || `Player ${pid}`)

// ---- sections ------------------------------------------------------------

function renderRafters() {
  $('#rafters').classList.toggle('has-me', V.me != null)
  $('#rafters').innerHTML = D.table.map((row, i) => `<button type="button" class="banner${row.rid === V.me ? ' is-me' : ''}" style="${mc(row.rid)}"
      data-me="${row.rid}" aria-pressed="${row.rid === V.me}" aria-label="${nameOf(row.rid)}, ${ord(i + 1)}">
      <span class="rank">${i + 1}</span>${av(row.rid)}<b>${nameOf(row.rid)}</b><small class="num">${row.w}-${row.l}${row.t ? `-${row.t}` : ''}</small></button>`).join('')
  $('#pickme').textContent = V.me ? `Following ${D.M.get(V.me).name}. Tap another banner to switch.` : 'Tap your banner and the page follows your team.'
}

function recap(week, a, b) {
  const final = weekFinal(week)
  if (a.points === b.points) return `${nameOf(a.roster_id)} and ${nameOf(b.roster_id)} are dead even at ${f2(a.points)}.`
  const [win, lose] = a.points > b.points ? [a, b] : [b, a]
  const star = maxBy(win.starters.filter((s) => s.pid), (s) => s.pts)
  let line = `${nameOf(win.roster_id)} ${final ? 'beat' : 'leads'} ${nameOf(lose.roster_id)} by ${f2(win.points - lose.points)}`
  if (star?.pts) line += `, ${pname(star.pid)}'s ${f1(star.pts)} leading the way`
  line += '.'
  if (!final) {
    const toPlay = pendingOf(a).length + pendingOf(b).length
    if (toPlay) line += ` ${toPlay} starter${toPlay === 1 ? '' : 's'} still to play: ${nameOf(win.roster_id)} ${pendingOf(win).length}, ${nameOf(lose.roster_id)} ${pendingOf(lose).length}.`
  }
  return line
}

function lineup(side) {
  const rows = side.starters.map((s) => {
    if (!s.pid) return `<li><span class="slot">${esc(s.slot)}</span><span class="muted">Empty slot</span><b class="num">0.0</b></li>`
    const tags = []
    if (s.state === 'locked') tags.push('<span class="tag lock">locked</span>')
    if (s.state === 'pending') tags.push(`<span class="tag">to play · proj ${f1(s.proj)}</span>`)
    if (s.state !== 'pending' && s.best > s.pts + 0.01) tags.push(`<span class="best">best ${f1(s.best)}</span>`)
    return `<li><span class="slot">${esc(s.slot)}</span><span class="pl">${pname(s.pid)}${tags.join('')}</span><b class="num">${s.state === 'pending' ? '–' : f1(s.pts)}</b></li>`
  }).join('')
  const benchRows = side.bench.map((b) => `<li class="bn"><span class="slot">BN</span><span class="pl">${pname(b.pid)}</span><span class="num">${f1(b.best)}</span></li>`).join('')
  return `<ul class="lineup">${rows}<li class="total"><span></span><span>Total</span><b class="num">${f2(side.points)}</b></li>${benchRows}</ul>`
}

function renderWeek() {
  const w = V.week
  const ps = pairs(D.weekSides)
  const final = weekFinal(w)
  const games = ps.map(([a, b]) => {
    const id = `${w}-${a.matchup_id}`
    const lead = a.points >= b.points ? a.roster_id : b.roster_id
    const open = V.open.has(id)
    const chance = final ? null : liveChance(a, b)
    const sideRow = (s, p) => `<div class="side-row${s.roster_id === lead && a.points !== b.points ? ' lead' : ''}">${mgr(s.roster_id)}
      <span class="pts num">${f2(s.points)}${final ? '' : `<small>proj ${f2(s.proj)} · ${pct(p)} win</small>`}</span></div>`
    return `<article class="panel game" style="${mc(lead)}">
      <button type="button" aria-expanded="${open}" aria-controls="lu-${id}" data-expand="${id}">
        ${sideRow(a, chance)}${sideRow(b, chance == null ? null : 1 - chance)}
        <span class="recap">${recap(w, a, b)}</span>
        <span class="margin">${open ? 'Hide lineups' : 'Show lineups'}</span>
      </button>
      <div class="lineups" id="lu-${id}"${open ? '' : ' hidden'}>${lineup(a)}${lineup(b)}</div>
    </article>`
  }).join('')
  const weeks = Array.from({ length: S.current }, (_, i) => i + 1)
  $('#week').innerHTML = `<div class="head"><h2 id="h-week">Week ${w}</h2>
      <div class="controls"><span class="chip ${final ? '' : 'live'}">${final ? 'Final' : 'Live'}</span>
        <label class="sr" for="week-pick">Week</label><select id="week-pick">${weeks.map((x) => `<option value="${x}"${x === w ? ' selected' : ''}>Week ${x}</option>`).join('')}</select></div></div>
    <div class="games">${games || '<p class="muted">No matchups this week.</p>'}</div>
    <p class="muted small">Counted like the Sleeper app: a locked starter counts his locked game, an unlocked one counts his team's last game once it is played and nothing until then. Projections add Sleeper's projection for each starter still to play.</p>`
}

function renderTable() {
  const t = V.tally
  const bar = (x, rid) => `<div class="bar${x < 0.3 ? ' light' : ''}" style="${mc(rid)}"><i style="width:${(x * 100).toFixed(1)}%"></i><span>${pct(x)}</span></div>`
  const nextWeek = D.futureWeeks[0]
  const next = nextWeek ? pairs(S.pairings[nextWeek]) : []
  const rows = D.table.map((row, i) => `<tr class="${row.rid === V.me ? 'me' : ''}" style="${mc(row.rid)}">
      <td class="num">${i + 1}</td><th scope="row">${mgr(row.rid)}</th>
      <td class="num">${row.w}-${row.l}${row.t ? `-${row.t}` : ''}</td><td class="num wide">${f1(row.pf)}</td><td class="num wide">${f1(row.pa)}</td>
      <td class="num wide">${row.apW}-${row.apL}</td><td class="num wide">${row.streak || '–'}</td>
      <td>${bar(t[row.rid].po, row.rid)}</td><td>${bar(t[row.rid].title, row.rid)}</td></tr>`).join('')
  $('#table').innerHTML = `<div class="head"><h2 id="h-table">Standings and odds</h2>
      <button type="button" class="btn" data-action="sim">Simulate ${MORE_SIMS.toLocaleString()} seasons</button></div>
    <div class="panel odds"><table><thead><tr><th scope="col">#</th><th scope="col">Manager</th><th scope="col">W-L</th>
      <th scope="col" class="wide">PF</th><th scope="col" class="wide">PA</th><th scope="col" class="wide">All-play</th><th scope="col" class="wide">Streak</th>
      <th scope="col">Playoffs</th><th scope="col">Title</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${next.length ? `<h3>What if: pick week ${nextWeek}'s winners</h3><div class="whatif">${next.map(([a, b], gi) => {
      const key = `0:${gi}`
      return `<div class="panel wi">${[a, b].map((s) => {
        const o = s === a ? b : a
        return `<button type="button" style="${mc(s.roster_id)}" data-force="${key}|${s.roster_id}" aria-pressed="${V.forced[key] === s.roster_id}">${nameOf(s.roster_id)}<small>${pct(winChance(D.strength[s.roster_id], D.strength[o.roster_id], D.doubt))} to win</small></button>`
      }).join('')}<span class="vs">${V.forced[key] ? 'Tap again to undo' : 'Tap who wins'}</span></div>`
    }).join('')}</div>` : ''}`
}

// ---- awards --------------------------------------------------------------

function weekAwards() {
  const w = V.week
  const sides = D.weekSides
  const ps = pairs(sides)
  if (!sides.length) return []
  const live = !weekFinal(w)
  const so = live ? ' so far' : ''
  const out = []
  const add = (title, rid, big, text) => rid != null && out.push({ title, rid, big, text })
  const played = (s) => s.starters.filter((x) => x.pid && x.state !== 'pending')

  const top = maxBy(sides, (s) => s.points)
  add(`Top score${so}`, top.roster_id, f2(top.points), `Week ${w}'s best total.`)
  const game = maxBy(sides.flatMap((s) => played(s).map((x) => ({ ...x, rid: s.roster_id }))), (x) => x.pts)
  if (game?.pts) add('Game of the week', game.rid, f1(game.pts), `${pname(game.pid)}, the best game anyone has counting.`)
  if (live) {
    const cooking = (s) => sum(pendingOf(s).map((x) => x.proj))
    const cook = maxBy(sides, cooking)
    if (cooking(cook) > 0) add('Still cooking', cook.roster_id, f1(cooking(cook)), 'Projected points from starters who have not played their game yet.')
  }

  const locked = (s) => s.starters.filter((x) => x.state === 'locked')
  const saved = (s) => sum(locked(s).filter((x) => x.instead != null).map((x) => Math.max(0, x.pts - x.instead)))
  const master = maxBy(sides, saved)
  if (saved(master) > 0) add('Lock master', master.roster_id, `+${f1(saved(master))}`, 'Points his locks saved over the games that would have counted instead.')
  const jumped = (s) => sum(locked(s).filter((x) => x.bestAfter != null).map((x) => Math.max(0, x.bestAfter - x.pts)))
  const gun = maxBy(sides, jumped)
  if (jumped(gun) > 0) add('Jumped the gun', gun.roster_id, f1(jumped(gun)), 'Points his players scored after being locked, in games that no longer count.')
  const waited = (s) => sum(s.starters.filter((x) => x.state === 'final').map((x) => Math.max(0, x.best - x.pts)))
  const slow = maxBy(sides, waited)
  if (waited(slow) > 0) add('Waited too long', slow.roster_id, f1(waited(slow)), 'Points his unlocked starters had in earlier, better games.')

  const benchOf = (s) => sum(s.bench.map((b) => b.best))
  const bench = maxBy(sides, benchOf)
  if (benchOf(bench) > 0) add('Bench mob', bench.roster_id, f1(benchOf(bench)), "His bench's best games of the week, none of them counting.")

  const share = (s) => (s.points > 0 ? Math.max(0, ...played(s).map((x) => x.pts)) / s.points : 0)
  const band = maxBy(sides, share)
  const bandStar = maxBy(played(band), (x) => x.pts)
  if (bandStar?.pts) add('One-man band', band.roster_id, pct(share(band)), `${pname(bandStar.pid)} carried that share of his total.`)
  const spread = (s) => {
    const xs = played(s).map((x) => x.pts).filter((x) => x > 0)
    return xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : Infinity
  }
  const balanced = minBy(sides, spread)
  if (Number.isFinite(spread(balanced))) add('Balanced attack', balanced.roster_id, f1(spread(balanced)), 'Smallest gap between his best and worst scoring starters.')

  const slotSum = (s, set) => sum(played(s).filter((x) => set.has(x.slot)).map((x) => x.pts))
  const back = maxBy(sides, (s) => slotSum(s, BACKCOURT))
  add('Backcourt kings', back.roster_id, f1(slotSum(back, BACKCOURT)), 'Most points from the PG, SG and G slots.')
  const front = maxBy(sides, (s) => slotSum(s, FRONTCOURT))
  add('Frontcourt bullies', front.roster_id, f1(slotSum(front, FRONTCOURT)), 'Most points from the SF, PF, F and C slots.')
  const util = maxBy(sides, (s) => slotSum(s, UTILITY))
  add('Utility belt', util.roster_id, f1(slotSum(util, UTILITY)), 'Most points from the three UTIL slots.')

  const byExp = (s, test) => sum(played(s).filter((x) => test(S.players[x.pid]?.exp)).map((x) => x.pts))
  const isRookie = (e) => e === 0
  const isVet = (e) => e >= VETERAN_SEASONS
  const rook = maxBy(sides, (s) => byExp(s, isRookie))
  if (byExp(rook, isRookie) > 0) add('Rookie watch', rook.roster_id, f1(byExp(rook, isRookie)), 'Most points from rookies in his lineup.')
  const old = maxBy(sides, (s) => byExp(s, isVet))
  if (byExp(old, isVet) > 0) add('Old heads', old.roster_id, f1(byExp(old, isVet)), `Most points from players in their ${ord(VETERAN_SEASONS + 1)} season or later.`)
  const zeros = (s) => s.starters.filter((x) => x.state === 'empty' || (x.state !== 'pending' && x.pts === 0)).length
  const empty = maxBy(sides, zeros)
  if (zeros(empty)) add('Empty seats', empty.roster_id, String(zeros(empty)), 'Starters counting a zero.')

  const ap = allPlay(sides)
  const losers = ps.map(([a, b]) => (a.points < b.points ? a : b.points < a.points ? b : null)).filter(Boolean)
  const unlucky = maxBy(losers, (s) => ap[s.roster_id].w)
  if (unlucky && ap[unlucky.roster_id].w) add('Wrong opponent', unlucky.roster_id, `${ap[unlucky.roster_id].w}-${ap[unlucky.roster_id].l}`,
    `${live ? 'Trailing' : 'Lost'}, but his ${f2(unlucky.points)} beats ${ap[unlucky.roster_id].w} other teams.`)
  const margin = ([a, b]) => Math.abs(a.points - b.points)
  const close = minBy(ps, margin)
  if (close && margin(close) > 0) {
    const loser = close[0].points < close[1].points ? close[0] : close[1]
    add(`Heartbreaker${so}`, loser.roster_id, f2(margin(close)), `${live ? 'Trailing' : 'Lost'} by the week's smallest margin.`)
  }
  const blow = maxBy(ps, margin)
  if (blow) add(`Bully${so}`, (blow[0].points > blow[1].points ? blow[0] : blow[1]).roster_id, `+${f2(margin(blow))}`, "The week's biggest margin.")
  const winners = ps.map(([a, b]) => (a.points > b.points ? a : b.points > a.points ? b : null)).filter(Boolean)
  const lucky = minBy(winners, (s) => s.points)
  const rank = lucky ? sides.filter((o) => o.points > lucky.points).length + 1 : 0
  if (lucky && rank > sides.length / 2) add(`Lucky dog${so}`, lucky.roster_id, ord(rank), `${live ? 'Ahead' : 'Won'} with only the week's ${ord(rank)}-best score.`)
  return out
}

function seasonAwards() {
  const out = []
  const add = (title, rid, big, text) => rid != null && out.push({ title, rid, big, text })
  const mgrs = [...D.M.values()]
  const trades = tradeList()
  const tradeCount = (rid) => trades.filter((t) => t.sides.some((s) => s.rid === rid)).length
  const trader = maxBy(mgrs, (m) => tradeCount(m.rid))
  if (tradeCount(trader.rid)) {
    const gave = S.tradedPicks.filter((p) => p.roster_id === trader.rid && p.owner_id !== trader.rid).length
    add('Trade machine', trader.rid, String(tradeCount(trader.rid)), `Trades so far${gave ? `, with ${gave} of his future picks sent away` : ''}.`)
  }
  const pickups = S.transactions.filter((t) => t.status === 'complete' && (t.type === 'free_agent' || t.type === 'waiver'))
  const adds = (rid) => pickups.filter((t) => Object.values(t.adds || {}).includes(rid)).length
  const adder = maxBy(mgrs, (m) => adds(m.rid))
  if (adds(adder.rid)) add('Lives on the wire', adder.rid, String(adds(adder.rid)), 'Free-agent and waiver pickups so far.')
  const gems = pickups.flatMap((t) => Object.entries(t.adds || {}).map(([pid, rid]) => ({ pid, rid, pts: pointsSince(pid, t.leg || 1) })))
  const gem = maxBy(gems.filter((g) => D.owner.get(g.pid) === g.rid), (g) => g.pts)
  if (gem?.pts > 0) add('Waiver gem', gem.rid, f1(gem.pts), `${pname(gem.pid)}, picked up for free, has put up that many points since.`)
  const steal = maxBy(draftRows().filter((d) => d.gp), (d) => d.no - d.rank)
  if (steal) add('Draft steal', steal.rid, `#${steal.no}`, `${esc(steal.n)}, taken ${ord(steal.no)}, has scored like the ${ord(steal.rank)} pick.`)
  if (D.finished.length) {
    const pf = maxBy(D.table, (r) => r.pf)
    add('Most points for', pf.rid, f1(pf.pf), 'Season points in finished weeks.')
    const luck = (r) => r.w - (r.apW / Math.max(1, r.apW + r.apL)) * (r.w + r.l + r.t)
    const charmed = maxBy(D.table, luck)
    if (luck(charmed) > 0.25) add('Charmed life', charmed.rid, `+${f1(luck(charmed))}`, 'Wins above what his scores would earn against the whole league.')
    const cursed = minBy(D.table, luck)
    if (luck(cursed) < -0.25) add('Snakebitten', cursed.rid, f1(luck(cursed)), 'Wins below what his scores would earn against the whole league.')
    if (D.finished.length >= 3) {
      const sd = (r) => { const m = sum(r.scores) / r.scores.length; return Math.sqrt(sum(r.scores.map((x) => (x - m) ** 2)) / (r.scores.length - 1)) }
      const steady = minBy(D.table, sd)
      add('Metronome', steady.rid, f1(sd(steady)), 'Steadiest weekly scores (smallest spread).')
      const wild = maxBy(D.table, sd)
      add('Rollercoaster', wild.rid, f1(sd(wild)), 'Wildest swings from week to week.')
    }
  }
  const expOf = (m) => {
    const xs = (m.roster.players || []).map((p) => S.players[p]?.exp).filter((x) => x != null)
    return xs.length ? sum(xs) / xs.length : null
  }
  const withExp = mgrs.filter((m) => expOf(m) != null)
  if (withExp.length) {
    const young = minBy(withExp, expOf)
    const vet = maxBy(withExp, expOf)
    add('Baby faces', young.rid, f1(expOf(young)), 'Fewest NBA seasons per player on his roster.')
    add('Grizzled vets', vet.rid, f1(expOf(vet)), 'Most NBA seasons per player on his roster.')
  }
  const fanOf = (m) => {
    const c = {}
    for (const p of m.roster.players || []) { const t = S.players[p]?.t; if (t && t !== 'FA') c[t] = (c[t] || 0) + 1 }
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0] || ['', 0]
  }
  const fan = maxBy(mgrs, (m) => fanOf(m)[1])
  const fanMax = fanOf(fan)[1]
  const tied = mgrs.filter((m) => m !== fan && fanOf(m)[1] === fanMax)
  if (fanMax > 1) add('Fan club', fan.rid, `${fanMax} ${fanOf(fan)[0]}`, tied.length
    ? `Tied with ${tied.map((m) => `${esc(m.name)} (${fanMax} ${fanOf(m)[0]})`).join(', ')} for most players off one NBA team.` : 'Most players off one NBA team.')
  const games = (m) => sum((m.roster.players || []).map((p) => S.players[p]?.gp || 0))
  const iron = maxBy(mgrs, games)
  if (games(iron)) add('Iron men', iron.rid, String(games(iron)), 'Most NBA games played by his roster this season.')
  const hurt = (m) => (m.roster.players || []).filter((p) => HURT.has(S.players[p]?.inj)).length
  const room = maxBy(mgrs, hurt)
  if (hurt(room)) add('Training room', room.rid, String(hurt(room)), 'Players listed Out or on IR right now.')
  return out
}

function awardCards(list) {
  return `<div class="awards">${list.map((a) => `<article class="award${a.rid === V.me ? ' is-me' : ''}" style="${mc(a.rid)}">
    <h3>${esc(a.title)}</h3><div class="who">${av(a.rid)}${nameOf(a.rid)}</div><div class="big num">${a.big}</div><p>${a.text}</p></article>`).join('')}</div>`
}

function renderAwards() {
  const week = weekAwards()
  const season = seasonAwards()
  const tally = {}
  for (const a of [...week, ...season]) tally[a.rid] = (tally[a.rid] || 0) + 1
  const leader = maxBy(Object.entries(tally), ([, n]) => n)
  $('#awards').innerHTML = `<div class="head"><h2 id="h-awards">Awards</h2>${leader ? `<span class="chip">Most banners: ${nameOf(Number(leader[0]))}, ${leader[1]}</span>` : ''}</div>
    <h3>Week ${V.week}</h3>${awardCards(week)}<h3>Season</h3>${awardCards(season)}`
}

// ---- players -------------------------------------------------------------

function renderPlayers() {
  const w = V.week
  const counted = D.weekSides.flatMap((s) => s.starters.filter((x) => x.pid && x.state !== 'pending').map((x) => ({ ...x, rid: s.roster_id })))
  const topGames = counted.sort((a, b) => b.pts - a.pts).slice(0, LIST_ROWS)
  const rostered = [...D.owner.keys()].filter((pid) => S.players[pid])
  const leaders = rostered.sort((a, b) => S.players[b].fp - S.players[a].fp).slice(0, LIST_ROWS)
  const free = Object.keys(S.players).filter((pid) => !D.owner.has(pid) && S.players[pid].gp >= 2 && !HURT.has(S.players[pid].inj) && S.players[pid].t !== 'FA')
    .sort((a, b) => S.players[b].avg - S.players[a].avg).slice(0, LIST_ROWS)
  const row = (pid, right, sub) => `<li>${face(pid)}<span class="pn"><b>${pname(pid)}</b><small>${esc(S.players[pid]?.t || '')} · ${sub}</small></span>
    <span class="val num">${right}</span></li>`
  $('#players').innerHTML = `<div class="head"><h2 id="h-players">Players</h2></div>
    <div class="lists">
      <article class="panel list"><h3>Best counted games, week ${w}</h3><ul>${topGames.map((x) => row(x.pid, f1(x.pts), nameOf(x.rid))).join('')}</ul></article>
      <article class="panel list"><h3>Season leaders on a roster</h3><ul>${leaders.map((pid) => row(pid, f1(S.players[pid].fp), `${nameOf(D.owner.get(pid))} · ${S.players[pid].gp} games`)).join('')}</ul></article>
      <article class="panel list"><h3>Best free agents</h3><ul>${free.map((pid) => row(pid, `${f1(S.players[pid].avg)}<small>per game</small>`, `${S.players[pid].gp} games`)).join('') || '<li class="muted">None with two games yet.</li>'}</ul></article>
    </div>`
}

// ---- moves ---------------------------------------------------------------

function renderMoves() {
  const moves = S.transactions.filter((t) => t.status === 'complete' && ['trade', 'free_agent', 'waiver'].includes(t.type))
    .sort((a, b) => b.created - a.created).slice(0, MOVES_ROWS)
  const items = moves.map((t) => {
    const rid = t.roster_ids?.[0]
    if (t.type === 'trade') {
      const parts = t.roster_ids.map((r) => `${nameOf(r)} gets ${Object.entries(t.adds || {}).filter(([, to]) => to === r).map(([p]) => pname(p)).join(', ') || 'picks'}`)
      return `<li style="${mc(rid)}"><span class="kind trade">Trade</span><span>${parts.join('; ')}</span><time>${dateOf(t.created)}</time></li>`
    }
    const added = Object.keys(t.adds || {}).map(pname)
    const dropped = Object.keys(t.drops || {}).map(pname)
    const what = [added.length ? `added ${added.join(', ')}` : '', dropped.length ? `dropped ${dropped.join(', ')}` : ''].filter(Boolean).join(', ')
    return `<li style="${mc(rid)}"><span class="kind">${t.type === 'waiver' ? 'Waiver' : 'Free agent'}</span><span>${mgr(rid)} ${what}</span><time>${dateOf(t.created)}</time></li>`
  }).join('')
  $('#moves').innerHTML = `<div class="head"><h2 id="h-moves">Latest moves</h2></div>
    <ul class="panel moves">${items || '<li class="muted">No moves yet.</li>'}</ul>`
}

// ---- head to head --------------------------------------------------------

function weekScores(w) {
  if (S.finals[w]) return S.finals[w]
  if (w === S.current) return D.currentSides
  return []
}

function renderH2H() {
  const rids = D.table.map((r) => r.rid)
  let [a, b] = V.h2h
  if (!rids.includes(a)) a = V.me && rids.includes(V.me) ? V.me : rids[0]
  if (!rids.includes(b) || b === a) {
    const g = pairs(D.currentSides).find(([x, y]) => x.roster_id === a || y.roster_id === a)
    b = g ? (g[0].roster_id === a ? g[1].roster_id : g[0].roster_id) : rids.find((r) => r !== a)
  }
  V.h2h = [a, b]
  const pair = [a, b].sort().join()
  const meets = (list) => pairs(list).filter(([x, y]) => [x.roster_id, y.roster_id].sort().join() === pair)
  const played = Array.from({ length: S.current }, (_, i) => i + 1).flatMap((w) => meets(weekScores(w))
    .map(([x, y]) => ({ w, sa: x.roster_id === a ? x.points : y.points, sb: x.roster_id === a ? y.points : x.points })))
  const ahead = D.futureWeeks.filter((w) => meets(S.pairings[w]).length)
  const winsA = played.filter((m) => weekFinal(m.w) && m.sa > m.sb).length
  const winsB = played.filter((m) => weekFinal(m.w) && m.sb > m.sa).length
  const col = (rid) => {
    const r = D.table.find((x) => x.rid === rid)
    const top = (D.M.get(rid).roster.players || []).filter((p) => S.players[p]).sort((x, y) => S.players[y].avg - S.players[x].avg).slice(0, 5)
    return `<div class="hcol" style="${mc(rid)}">${mgr(rid)}
      <dl><div><dt>Record</dt><dd class="num">${r.w}-${r.l}${r.t ? `-${r.t}` : ''}</dd></div><div><dt>Points for</dt><dd class="num">${f1(r.pf)}</dd></div>
        <div><dt>Playoffs</dt><dd class="num">${pct(V.tally[rid].po)}</dd></div><div><dt>Title</dt><dd class="num">${pct(V.tally[rid].title)}</dd></div></dl>
      <ul>${top.map((p) => `<li><span>${pname(p)}</span><span class="num">${f1(S.players[p].avg)}</span></li>`).join('')}</ul></div>`
  }
  const opts = (sel, other) => rids.filter((r) => r !== other).map((r) => `<option value="${r}"${r === sel ? ' selected' : ''}>${nameOf(r)}</option>`).join('')
  const series = played.length ? `Season series: ${nameOf(a)} ${winsA}, ${nameOf(b)} ${winsB}. ${played.map((m) => `Week ${m.w}: ${f2(m.sa)}-${f2(m.sb)}${weekFinal(m.w) ? '' : ' (live)'}`).join(' · ')}.` : 'They have not met yet.'
  const nextMeet = ahead.length ? ` Next meeting, week ${ahead[0]}: ${nameOf(a)} ${pct(winChance(D.strength[a], D.strength[b], D.doubt))} to win.` : ''
  $('#h2h').innerHTML = `<div class="head"><h2 id="h-h2h">Head to head</h2>
      <div class="controls"><label class="sr" for="h2h-a">First team</label><select id="h2h-a">${opts(a, b)}</select><span class="muted">vs</span>
        <label class="sr" for="h2h-b">Second team</label><select id="h2h-b">${opts(b, a)}</select></div></div>
    <article class="panel h2h">
      <p class="h2h-line">${series}${nextMeet}</p>
      <div class="hcols">${col(a)}${col(b)}</div>
      <p class="muted small">Top five by points per game this season.</p>
    </article>`
}

// ---- trades and draft ------------------------------------------------------

function tradeList() {
  const undo = (t) => S.transactions.some((u) => u !== t && u.type === t.type && Math.abs(u.created - t.created) < 15 * 60 * 1000
    && JSON.stringify(Object.keys(u.adds || {}).sort()) === JSON.stringify(Object.keys(t.adds || {}).sort()))
  return S.transactions.filter((t) => t.type === 'trade' && t.status === 'complete' && !undo(t))
    .sort((a, b) => a.created - b.created)
    .map((t) => ({
      created: t.created, week: t.leg || 1,
      sides: t.roster_ids.map((rid) => ({
        rid,
        gets: Object.entries(t.adds || {}).filter(([, to]) => to === rid).map(([pid]) => pid),
        picks: (t.draft_picks || []).filter((d) => d.owner_id === rid),
      })),
    }))
}

function pointsSince(pid, week) {
  let total = 0
  for (const [w, stats] of Object.entries(S.weekly)) if (Number(w) >= week && stats[pid]) total += fantasyPoints(stats[pid], S.scoring)
  return total
}

function renderTrades() {
  const trades = tradeList()
  const fixes = S.transactions.filter((t) => t.type === 'commissioner' && t.status === 'complete').length / 2
  const items = trades.map((t) => {
    const totals = t.sides.map((s) => sum(s.gets.map((pid) => pointsSince(pid, t.week))))
    const ahead = totals[0] === totals[1] ? null : totals[0] > totals[1] ? 0 : 1
    return `<article class="panel trade">
      <div class="date"><span>${dateOf(t.created)}</span>
        <span class="verdict ${ahead == null ? 'even' : 'win'}">${ahead == null ? 'Even so far' : `${nameOf(t.sides[ahead].rid)} +${f1(Math.abs(totals[0] - totals[1]))} so far`}</span></div>
      ${t.sides.map((s, i) => `<div class="tside" style="${mc(s.rid)}">${mgr(s.rid)}<span class="gets">Gets</span>
        <ul>${s.gets.map((pid) => `<li><span>${pname(pid)}</span><span class="num">${f1(pointsSince(pid, t.week))}</span></li>`).join('')}
        ${s.picks.map((p) => `<li><span>${p.season} round ${p.round} pick</span><span class="muted">pick</span></li>`).join('')}</ul>
        <span class="num muted small">${f1(totals[i])} fantasy points since</span></div>`).join('')}
    </article>`
  }).join('')
  $('#trades').innerHTML = `<div class="head"><h2 id="h-trades">Trade desk</h2>
      <span class="chip">${trades.length} trades</span>${fixes >= 1 ? `<span class="chip">${Math.floor(fixes)} undone by the commissioner</span>` : ''}</div>
    <p class="muted small">Scored by the fantasy points each side's new players have put up since the trade, in every game, started or not.</p>
    <div class="trades">${items || '<p class="muted">No trades yet.</p>'}</div>`
}

function draftRows() {
  const rid = new Map(S.rosters.map((r) => [r.owner_id, r.roster_id]))
  const rows = S.picks.map((p) => ({
    no: p.pick_no, round: p.round, slot: p.draft_slot, rid: rid.get(p.picked_by) ?? p.roster_id, pid: p.player_id,
    n: S.players[p.player_id]?.n || `${p.metadata?.first_name || ''} ${p.metadata?.last_name || ''}`.trim(),
    fp: S.players[p.player_id]?.fp || 0, gp: S.players[p.player_id]?.gp || 0,
  }))
  ;[...rows].sort((a, b) => b.fp - a.fp).forEach((d, i) => { d.rank = i + 1 })
  return rows
}

function renderDraft() {
  const rows = draftRows()
  if (!rows.length) { $('#draft').innerHTML = ''; return }
  const bySlot = new Map(rows.map((d) => [d.slot, d.rid]))
  const slots = [...bySlot.keys()].sort((a, b) => a - b)
  const heat = (d) => {
    const delta = Math.max(-40, Math.min(40, d.no - d.rank))
    const t = (delta + 40) / 80
    const mix = (a, b, k) => Math.round(a + (b - a) * k)
    const [r, g, b] = t < 0.5 ? [mix(200, 217, t * 2), mix(71, 211, t * 2), mix(61, 196, t * 2)]
      : [mix(217, 47, (t - 0.5) * 2), mix(211, 158, (t - 0.5) * 2), mix(196, 98, (t - 0.5) * 2)]
    return `--heat:rgb(${r},${g},${b});--heat-ink:${(r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#121826' : '#ffffff'}`
  }
  const rounds = Math.max(...rows.map((d) => d.round))
  let cells = `<span></span>${slots.map((s) => `<div class="colh" style="${mc(bySlot.get(s))}">${av(bySlot.get(s))}<span>${nameOf(bySlot.get(s))}</span></div>`).join('')}`
  for (let r = 1; r <= rounds; r++) {
    cells += `<div class="rowh">${r}</div>`
    for (const s of slots) {
      const d = rows.find((x) => x.round === r && x.slot === s)
      cells += d ? `<button type="button" class="cell${d.rid === V.me ? ' mine' : ''}" style="${heat(d)}" data-cell="${d.no}" aria-pressed="${V.pickedCell === d.no}"
        aria-label="Pick ${d.no}, ${esc(d.n)}"><b>${esc(d.n.split(' ').slice(-1)[0])}</b><span class="num">#${d.no} → ${d.rank}</span></button>` : '<span></span>'
    }
  }
  const d = rows.find((x) => x.no === V.pickedCell)
  const info = d ? `<div class="panel pickinfo" style="${mc(d.rid)}">${mgr(d.rid)} took <b>${esc(d.n)}</b> ${ord(d.no)} overall (round ${d.round}). He has ${f1(d.fp)} fantasy points in ${d.gp} games, ${ord(d.rank)} among everyone drafted.</div>`
    : '<p class="muted small">Tap any pick to see how it has aged. Colors compare each pick with where his points so far rank.</p>'
  $('#draft').innerHTML = `<div class="head"><h2 id="h-draft">Draft board</h2><div class="legend"><span>Reach</span><span class="ramp"></span><span>Steal</span></div></div>
    <div class="board-wrap"><div class="board" style="grid-template-columns:34px repeat(${slots.length}, minmax(64px, 1fr))">${cells}</div></div>${info}`
}

// ---- your team -------------------------------------------------------------

function renderTeam() {
  if (!V.me || !D.M.has(V.me)) {
    $('#team').innerHTML = '<div class="head"><h2 id="h-team">Your team</h2></div><p class="muted small">Tap your banner at the top to see your team here.</p>'
    return
  }
  const m = D.M.get(V.me)
  const row = D.table.find((r) => r.rid === V.me)
  const rank = D.table.indexOf(row) + 1
  const positions = S.league.roster_positions || []
  const starters = (m.roster.starters || []).map((pid, i) => ({ pid, slot: positions[i] })).filter((e) => e.pid && e.pid !== '0')
  const startSet = new Set(starters.map((e) => e.pid))
  const reserve = new Set(m.roster.reserve || [])
  const entries = [...starters, ...(m.roster.players || []).filter((p) => !startSet.has(p) && !reserve.has(p)).map((pid) => ({ pid, slot: 'BN' })),
    ...[...reserve].map((pid) => ({ pid, slot: 'IR' }))]
  const now = D.currentSides.find((s) => s.roster_id === V.me)
  const next = D.futureWeeks.slice(0, 3).map((w) => {
    const g = pairs(S.pairings[w]).find(([a, b]) => a.roster_id === V.me || b.roster_id === V.me)
    if (!g) return ''
    const o = g[0].roster_id === V.me ? g[1].roster_id : g[0].roster_id
    return `<div class="panel" style="${mc(o)}"><b>Week ${w}</b>${mgr(o)}<span class="num">${pct(winChance(D.strength[V.me], D.strength[o], D.doubt))} to win</span></div>`
  }).join('')
  $('#team').innerHTML = `<div class="head"><h2 id="h-team">Your team</h2></div>
    <article class="panel team" style="${mc(V.me)}">
      <div class="team-top">${av(V.me)}<h2>${esc(m.name)}</h2></div>
      <div class="stats"><span class="chip">${ord(rank)} · ${row.w}-${row.l}${row.t ? `-${row.t}` : ''}</span><span class="chip">PF ${f1(row.pf)}</span>
        <span class="chip">Playoffs ${pct(V.tally[V.me].po)}</span><span class="chip">Title ${pct(V.tally[V.me].title)}</span>
        ${now && !weekFinal(S.current) ? `<span class="chip">Week ${S.current}: ${f2(now.points)}, proj ${f2(now.proj)}</span>` : ''}
        ${row.scores.length ? `<span class="chip">Weeks: ${row.scores.map(f1).join(', ')}</span>` : ''}</div>
      <ul class="roster">${entries.map(({ pid, slot }) => {
        const p = S.players[pid] || {}
        return `<li><span class="slot${slot === 'BN' || slot === 'IR' ? ' bench' : ''}">${esc(slot || '')}</span>${face(pid)}
          <span class="pn"><b>${esc(p.n || pid)}${p.inj ? `<span class="hurt">${esc(p.inj)}</span>` : ''}</b><small>${esc(p.t || '')} · ${esc(p.pos || '')}</small></span>
          <span class="val num">${f1(p.avg)}<small>${p.gp || 0} games</small></span></li>`
      }).join('')}</ul>
      ${next ? `<h3>Next up</h3><div class="next">${next}</div>` : ''}
    </article>`
}

function render() {
  if (S.error && !S.ready) {
    $('#main').innerHTML = `<div class="banner-err" role="alert"><p>${esc(S.error)}</p><button type="button" class="btn" data-action="retry">Try again</button></div>`
    return
  }
  if (!S.ready) return
  D = derive()
  $('#title').textContent = S.league.name
  const upd = S.updated?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  $('#asof').textContent = `${S.rosters.length} teams · Sleeper Lock-in · ${S.inSeason && !weekFinal(S.current) ? `live, updated ${upd}` : `updated ${upd}`}`
  renderRafters()
  renderWeek()
  renderTable()
  renderAwards()
  renderPlayers()
  renderH2H()
  renderMoves()
  renderTrades()
  renderDraft()
  renderTeam()
}

// ---- wiring --------------------------------------------------------------

async function start() {
  try {
    await loadAll()
    S.ready = true
    S.updated = new Date()
    runSims(FIRST_SIMS)
  } catch (err) {
    S.error = err instanceof Error ? err.message : 'Sleeper could not be reached.'
  }
  render()
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  const d = b.dataset
  if (d.me) {
    V.me = Number(d.me) === V.me ? null : Number(d.me)
    store.set(ME_KEY, V.me ?? '')
    V.h2h = [null, null]
    render()
  } else if (d.expand) {
    V.open.has(d.expand) ? V.open.delete(d.expand) : V.open.add(d.expand)
    renderWeek()
  } else if (d.action === 'sim') {
    runSims(MORE_SIMS)
    render()
  } else if (d.action === 'retry') {
    S.error = null
    start()
  } else if (d.force) {
    const [key, rid] = d.force.split('|')
    V.forced[key] = V.forced[key] === Number(rid) ? undefined : Number(rid)
    runSims(MORE_SIMS)
    render()
  } else if (d.cell) {
    V.pickedCell = V.pickedCell === Number(d.cell) ? null : Number(d.cell)
    renderDraft()
  }
})

document.addEventListener('change', async (e) => {
  const id = e.target.id
  if (id === 'week-pick') {
    V.week = Number(e.target.value)
    try { await loadWeek(V.week) } catch { /* the week stays empty until Sleeper answers */ }
    render()
  } else if (id === 'h2h-a' || id === 'h2h-b') {
    V.h2h[id === 'h2h-a' ? 0 : 1] = Number(e.target.value)
    renderH2H()
  }
})

setInterval(async () => {
  if (!S.ready || document.visibilityState !== 'visible' || weekFinal(S.current)) return
  try {
    await refresh()
    S.updated = new Date()
    runSims(FIRST_SIMS)
    render()
  } catch { /* keep what is on screen; the next tick tries again */ }
}, REFRESH_MS)

start()
