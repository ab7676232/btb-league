import { fantasyPoints, pairs, allPlay, standings, strengths, simulate, winChance, playerAverage, strengthSd } from './logic.js'

// BeneathTheBoxscore's league page: scores, lineups, standings, odds, awards,
// trades and the draft, read live from Sleeper's public API in the browser.
// Team names are never shown (managers appear by Sleeper username).

const LEAGUE_ID = '1394804447258869760'
const API = 'https://api.sleeper.app/v1'
const STATS = 'https://api.sleeper.com'
const faceUrl = (pid) => `https://sleepercdn.com/content/nba/players/thumb/${pid}.jpg`
const avatarUrl = (id) => `https://sleepercdn.com/avatars/thumbs/${id}`
const REFRESH_MS = 2 * 60 * 1000
const FETCH_POOL = 4
const FIRST_SIMS = 4000
const MORE_SIMS = 10000
const HURT = new Set(['Out', 'IR', 'Sus'])
// how much of a hurt player's average his team's season estimate keeps: a rest day costs
// nothing, surgery or IR a big share, any other Out a little
function healthWeight(p) {
  if (!p?.inj || p.inj === 'GTD' || p.inj === 'DTD' || p.inj === 'Questionable') return 1
  if (p.inj === 'IR' || p.inj === 'Sus' || /surgery/i.test(p.notes || '')) return 0.5
  return /rest/i.test(p.part || '') ? 1 : 0.85
}
const BENCH = new Set(['BN', 'IR', 'TAXI'])
const COLORS = ['#d9480f', '#1c7ed6', '#c2255c', '#2b8a3e', '#7048e8', '#e67700', '#0b7285', '#5c3d2e']
const ME_KEY = 'btb-me'

const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch { /* private window */ } },
}
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const f1 = (x) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(1))
const pct = (x) => (x >= 0.995 ? '>99%' : x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`)
const ord = (n) => `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

async function getJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sleeper answered ${res.status}.`)
  return res.json()
}
async function pool(items, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(FETCH_POOL, items.length) }, worker))
  return out
}

const S = { ready: false, error: null }
const V = { week: null, me: Number(store.get(ME_KEY)) || null, forced: {}, pickedCell: null, open: new Set(), tally: null }

// ---- loading -------------------------------------------------------------

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
  const regular = Array.from({ length: S.lastRegular }, (_, i) => i + 1)
  const played = regular.filter((w) => w <= S.current)
  const [matchups, transactions, picks, tradedPicks, season, weekly, lastSeason] = await Promise.all([
    pool(regular, (w) => getJSON(`${API}/league/${LEAGUE_ID}/matchups/${w}`)),
    pool(played, (w) => getJSON(`${API}/league/${LEAGUE_ID}/transactions/${w}`)),
    getJSON(`${API}/draft/${league.draft_id}/picks`),
    getJSON(`${API}/league/${LEAGUE_ID}/traded_picks`),
    getJSON(`${STATS}/stats/nba/${S.season}?season_type=regular`),
    pool(played, (w) => getJSON(`${API}/stats/nba/regular/${S.season}/${w}`)),
    getJSON(`${STATS}/stats/nba/${Number(S.season) - 1}?season_type=regular`).catch(() => []),
  ])
  S.lastAvg = {}
  for (const r of lastSeason || []) {
    const gp = r.stats?.gp || 0
    if (/^\d+$/.test(r.player_id) && gp) S.lastAvg[r.player_id] = fantasyPoints(r.stats, S.scoring) / gp
  }
  S.matchups = Object.fromEntries(regular.map((w, i) => [w, matchups[i] || []]))
  S.transactions = transactions.flat().filter(Boolean)
  S.picks = picks || []
  S.tradedPicks = tradedPicks || []
  S.weekly = Object.fromEntries(played.map((w, i) => [w, weekly[i] || {}]))
  readSeason(season)
  if (V.week == null || V.week > S.current) V.week = S.current
  await loadWeekGames(V.week)
}

/** Live refresh: this week's matchups, its games and the season line. */
async function refresh() {
  const w = S.current
  const [m, season, weekly] = await Promise.all([
    getJSON(`${API}/league/${LEAGUE_ID}/matchups/${w}`),
    getJSON(`${STATS}/stats/nba/${S.season}?season_type=regular`),
    getJSON(`${API}/stats/nba/regular/${S.season}/${w}`),
  ])
  S.matchups[w] = m || []
  S.weekly[w] = weekly || {}
  readSeason(season)
  if (V.week === w) await loadWeekGames(w, true)
}

function readSeason(rows) {
  S.players = {}
  for (const r of rows || []) {
    if (!/^\d+$/.test(r.player_id)) continue
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

S.weekGames = {}
async function loadWeekGames(week, fresh = false) {
  if (S.weekGames[week] && !fresh) return
  const rows = await getJSON(`${STATS}/stats/nba/${S.season}/${week}?season_type=regular`)
  const games = {}
  for (const r of rows || []) {
    if (!/^\d+$/.test(r.player_id) || !(r.stats?.sp > 0 || r.stats?.min > 0)) continue
    ;(games[r.player_id] ||= []).push({ date: r.date, opp: r.opponent, fp: fantasyPoints(r.stats, S.scoring) })
  }
  for (const list of Object.values(games)) list.sort((a, b) => a.date.localeCompare(b.date))
  S.weekGames[week] = games
}

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
  const finished = Object.keys(S.matchups).map(Number).filter((w) => w <= S.current && weekFinal(w)).sort((a, b) => a - b)
  const table = standings(rids, finished.map((w) => S.matchups[w]))
  const scores = Object.fromEntries(table.map((row) => [row.rid, row.scores]))
  const rosterAvg = Object.fromEntries(rids.map((r) => [r, (M.get(r).roster.players || [])
    .map((pid) => (S.players[pid]?.steady || 0) * healthWeight(S.players[pid]))]))
  const strength = strengths(rosterAvg, scores, slotsOf().length)
  const doubt = strengthSd(finished.length)
  const live = weekFinal(S.current) ? [] : pairs(S.matchups[S.current])
  // 0-0 ties before any week is final go to this week's score so far
  const liveNow = Object.fromEntries(live.flat().map((s) => [s.roster_id, s.points]))
  table.sort((a, b) => b.w - a.w || a.l - b.l || b.pf - a.pf || (liveNow[b.rid] || 0) - (liveNow[a.rid] || 0))
  const futureWeeks = Object.keys(S.matchups).map(Number).filter((w) => w > S.current).sort((a, b) => a - b)
  const schedule = futureWeeks.map((w) => pairs(S.matchups[w]).map(([a, b]) => [a.roster_id, b.roster_id]))
  return { M, rids, table, strength, doubt, live, futureWeeks, schedule }
}

function runSims(n) {
  const d = derive()
  V.tally = simulate({ rids: d.rids, strength: d.strength, table: d.table, live: d.live, schedule: d.schedule,
    forced: V.forced, playoffTeams: Number(S.league.settings?.playoff_teams) || 6, n, doubt: d.doubt })
}

// ---- pieces --------------------------------------------------------------

let D = null
const mc = (rid) => `--mc:${D.M.get(rid).color}`
function av(rid) {
  const m = D.M.get(rid)
  return `<span class="av" style="${mc(rid)}">${m.avatar ? `<img src="${avatarUrl(m.avatar)}" alt="" loading="lazy">` : ''}</span>`
}
const mgr = (rid) => `<span class="mgr" style="${mc(rid)}">${av(rid)}<b>${esc(D.M.get(rid).name)}</b>${rid === V.me ? '<span class="me-tag">You</span>' : ''}</span>`
function face(pid) {
  const initials = (S.players[pid]?.n || '?').split(' ').map((w) => w[0]).slice(0, 2).join('')
  return `<span class="face" aria-hidden="true"><span>${esc(initials)}</span><img src="${faceUrl(pid)}" alt="" loading="lazy" onerror="this.remove()"></span>`
}
const pname = (pid) => esc(S.players[pid]?.n || S.picks.find((p) => p.player_id === pid)?.metadata?.last_name || `Player ${pid}`)
const bestGame = (week, pid) => Math.max(...(S.weekGames[week]?.[pid] || []).map((g) => g.fp), -Infinity)

// ---- sections ------------------------------------------------------------

function renderRafters() {
  $('#rafters').classList.toggle('has-me', V.me != null)
  $('#rafters').innerHTML = D.table.map((row, i) => `<button type="button" class="banner${row.rid === V.me ? ' is-me' : ''}" style="${mc(row.rid)}"
      data-me="${row.rid}" aria-pressed="${row.rid === V.me}" aria-label="${esc(D.M.get(row.rid).name)}, ${ord(i + 1)}">
      <span class="rank">${i + 1}</span>${av(row.rid)}<b>${esc(D.M.get(row.rid).name)}</b><small class="num">${row.w}-${row.l}${row.t ? `-${row.t}` : ''}</small></button>`).join('')
  $('#pickme').textContent = V.me ? `Following ${D.M.get(V.me).name}. Tap another banner to switch.` : 'Tap your banner and the page follows your team.'
}

function lineup(week, side) {
  const positions = S.league.roster_positions || []
  const starters = side.starters || []
  const rows = starters.map((pid, i) => {
    if (!pid || pid === '0') return `<li><span class="slot">${esc(positions[i] || '')}</span><span class="muted">Empty</span><b class="num">0.0</b></li>`
    const pts = side.starters_points?.[i] ?? side.players_points?.[pid] ?? 0
    const best = bestGame(week, pid)
    const extra = best > pts + 0.01 ? `<span class="left">best ${f1(best)}</span>` : ''
    return `<li><span class="slot">${esc(positions[i] || '')}</span><span class="pl">${pname(pid)}${extra}</span><b class="num">${f1(pts)}</b></li>`
  }).join('')
  const bench = (side.players || []).filter((pid) => !starters.includes(pid))
  const benchRows = bench.map((pid) => `<li class="bn"><span class="slot">BN</span><span class="pl">${pname(pid)}</span><span class="num">${f1(side.players_points?.[pid] ?? 0)}</span></li>`).join('')
  return `<ul class="lineup">${rows}<li class="total"><span></span><span>Total</span><b class="num">${f1(side.points)}</b></li>${benchRows}</ul>`
}

function renderWeek() {
  const w = V.week
  const ps = pairs(S.matchups[w])
  const final = weekFinal(w)
  const games = ps.map(([a, b]) => {
    const id = `${w}-${a.matchup_id}`
    const lead = a.points >= b.points ? a.roster_id : b.roster_id
    const open = V.open.has(id)
    return `<article class="panel game" style="${mc(lead)}">
      <button type="button" aria-expanded="${open}" aria-controls="lu-${id}" data-expand="${id}">
        ${[a, b].map((s) => `<div class="side-row${s.roster_id === lead && (final || s.points !== (s === a ? b : a).points) ? ' lead' : ''}">${mgr(s.roster_id)}<span class="pts num">${f1(s.points)}</span></div>`).join('')}
        <span class="margin">${a.points === b.points ? 'Tied' : `${esc(D.M.get(lead).name)} ${final ? 'won by' : 'up'} ${f1(Math.abs(a.points - b.points))}`} · ${open ? 'hide lineups' : 'lineups'}</span>
      </button>
      <div class="lineups" id="lu-${id}"${open ? '' : ' hidden'}>${lineup(w, a)}${lineup(w, b)}</div>
    </article>`
  }).join('')
  const weeks = Array.from({ length: S.current }, (_, i) => i + 1)
  $('#week').innerHTML = `<div class="head"><h2 id="h-week">Week ${w}</h2>
      <div class="controls"><span class="chip ${final ? '' : 'live'}">${final ? 'Final' : 'Live'}</span>
        <label class="sr" for="week-pick">Week</label><select id="week-pick">${weeks.map((x) => `<option value="${x}"${x === w ? ' selected' : ''}>Week ${x}</option>`).join('')}</select></div></div>
    <div class="games">${games || '<p class="muted">No matchups this week.</p>'}</div>
    <p class="muted small">Totals and lineups are Sleeper's own: each starter's counted game. "Best" marks a starter who had a better game that week than the one counting.</p>`
}

function renderTable() {
  const t = V.tally
  const bar = (x, rid) => `<div class="bar${x < 0.3 ? ' light' : ''}" style="${mc(rid)}"><i style="width:${(x * 100).toFixed(1)}%"></i><span>${pct(x)}</span></div>`
  const nextWeek = D.futureWeeks[0]
  const next = nextWeek ? pairs(S.matchups[nextWeek]) : []
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
        return `<button type="button" style="${mc(s.roster_id)}" data-force="${key}|${s.roster_id}" aria-pressed="${V.forced[key] === s.roster_id}">${esc(D.M.get(s.roster_id).name)}<small>${pct(winChance(D.strength[s.roster_id], D.strength[o.roster_id], D.doubt))} to win</small></button>`
      }).join('')}<span class="vs">${V.forced[key] ? 'Tap again to undo' : 'Tap who wins'}</span></div>`
    }).join('')}</div>` : ''}`
}

function awards() {
  const list = []
  const add = (title, rid, big, text) => rid != null && list.push({ title, rid, big, text })
  const w = V.week
  const sides = pairs(S.matchups[w]).flat()
  const live = !weekFinal(w)
  if (sides.length) {
    const top = [...sides].sort((a, b) => b.points - a.points)[0]
    add(live ? 'Top score so far' : 'Top score', top.roster_id, f1(top.points), `Week ${w}'s best total.`)
    const starts = sides.flatMap((s) => (s.starters || []).map((pid, i) => ({ pid, pts: s.starters_points?.[i] ?? 0, rid: s.roster_id }))).filter((x) => x.pid && x.pid !== '0')
    const game = [...starts].sort((a, b) => b.pts - a.pts)[0]
    if (game) add('Game of the week', game.rid, f1(game.pts), `${pname(game.pid)}, the best game anyone has counting.`)
    const leftOf = (s) => (s.starters || []).reduce((t, pid, i) => {
      const best = bestGame(w, pid)
      const pts = s.starters_points?.[i] ?? 0
      return t + (best > pts ? best - pts : 0)
    }, 0)
    const regret = [...sides].sort((a, b) => leftOf(b) - leftOf(a))[0]
    if (leftOf(regret) > 0) add('Left on the table', regret.roster_id, f1(leftOf(regret)), 'Points his starters scored in better games than the ones counting.')
    const benchOf = (s) => (s.players || []).filter((p) => !(s.starters || []).includes(p)).reduce((t, p) => t + (s.players_points?.[p] || 0), 0)
    const bench = [...sides].sort((a, b) => benchOf(b) - benchOf(a))[0]
    add('Bench mob', bench.roster_id, f1(benchOf(bench)), 'Points left sitting on his bench.')
    const ap = allPlay(sides)
    const losers = pairs(S.matchups[w]).map(([a, b]) => (a.points < b.points ? a : b.points < a.points ? b : null)).filter(Boolean)
    const unlucky = losers.sort((a, b) => ap[b.roster_id].w - ap[a.roster_id].w)[0]
    if (unlucky && ap[unlucky.roster_id].w) add('Wrong opponent', unlucky.roster_id, `${ap[unlucky.roster_id].w}-${ap[unlucky.roster_id].l}`,
      `${live ? 'Trailing' : 'Lost'} his matchup, but his ${f1(unlucky.points)} beats ${ap[unlucky.roster_id].w} other teams.`)
    const margins = pairs(S.matchups[w]).map(([a, b]) => ({ a, b, m: Math.abs(a.points - b.points) }))
    const close = [...margins].sort((x, y) => x.m - y.m)[0]
    if (close) add(live ? 'Closest game so far' : 'Closest game', (close.a.points >= close.b.points ? close.a : close.b).roster_id, f1(close.m),
      `${esc(D.M.get(close.a.roster_id).name)} vs ${esc(D.M.get(close.b.roster_id).name)}, decided by ${f1(close.m)}.`)
  }
  const mgrs = [...D.M.values()]
  const trades = tradeList()
  const tradeCount = (rid) => trades.filter((t) => t.sides.some((s) => s.rid === rid)).length
  const trader = [...mgrs].sort((a, b) => tradeCount(b.rid) - tradeCount(a.rid))[0]
  if (tradeCount(trader.rid)) {
    const gave = S.tradedPicks.filter((p) => p.roster_id === trader.rid && p.owner_id !== trader.rid).length
    add('Trade machine', trader.rid, String(tradeCount(trader.rid)), `Trades so far${gave ? `, with ${gave} of his future picks sent away` : ''}.`)
  }
  const adds = (rid) => S.transactions.filter((t) => t.status === 'complete' && (t.type === 'free_agent' || t.type === 'waiver') && Object.values(t.adds || {}).includes(rid)).length
  const adder = [...mgrs].sort((a, b) => adds(b.rid) - adds(a.rid))[0]
  if (adds(adder.rid)) add('Lives on the wire', adder.rid, String(adds(adder.rid)), 'Free-agent and waiver pickups so far.')
  const steal = draftRows().filter((d) => d.gp).sort((a, b) => (b.no - b.rank) - (a.no - a.rank))[0]
  if (steal) add('Draft steal', steal.rid, `#${steal.no}`, `${esc(steal.n)}, taken ${ord(steal.no)}, has scored like the ${ord(steal.rank)} pick.`)
  const top = D.table[0]
  if (top?.pf) add('Most points for', [...D.table].sort((a, b) => b.pf - a.pf)[0].rid, f1(Math.max(...D.table.map((r) => r.pf))), 'Season points, finished weeks only.')
  const expOf = (m) => {
    const xs = (m.roster.players || []).map((p) => S.players[p]?.exp).filter((x) => x != null)
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null
  }
  const withExp = mgrs.filter((m) => expOf(m) != null)
  if (withExp.length) {
    const young = [...withExp].sort((a, b) => expOf(a) - expOf(b))[0]
    const vet = [...withExp].sort((a, b) => expOf(b) - expOf(a))[0]
    add('Baby faces', young.rid, f1(expOf(young)), 'Fewest NBA seasons per player on his roster.')
    add('Grizzled vets', vet.rid, f1(expOf(vet)), 'Most NBA seasons per player on his roster.')
  }
  const fanOf = (m) => {
    const c = {}
    for (const p of m.roster.players || []) { const t = S.players[p]?.t; if (t && t !== 'FA') c[t] = (c[t] || 0) + 1 }
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0] || ['', 0]
  }
  const fan = [...mgrs].sort((a, b) => fanOf(b)[1] - fanOf(a)[1])[0]
  const fanMax = fanOf(fan)[1]
  const tied = mgrs.filter((m) => m !== fan && fanOf(m)[1] === fanMax)
  if (fanMax > 1) add('Fan club', fan.rid, `${fanMax} ${fanOf(fan)[0]}`, tied.length
    ? `Tied with ${tied.map((m) => `${esc(m.name)} (${fanMax} ${fanOf(m)[0]})`).join(', ')} for most players off one NBA team.` : 'Most players off one NBA team.')
  const hurt = (m) => (m.roster.players || []).filter((p) => HURT.has(S.players[p]?.inj)).length
  const room = [...mgrs].sort((a, b) => hurt(b) - hurt(a))[0]
  if (hurt(room)) add('Training room', room.rid, String(hurt(room)), 'Players listed Out or on IR right now.')
  return list
}

function renderAwards() {
  const list = awards()
  $('#awards').innerHTML = `<div class="head"><h2 id="h-awards">Awards</h2><span class="chip">Week ${V.week} and season</span></div>
    <div class="awards">${list.map((a) => `<article class="award${a.rid === V.me ? ' is-me' : ''}" style="${mc(a.rid)}">
      <h3>${esc(a.title)}</h3><div class="who">${av(a.rid)}${esc(D.M.get(a.rid).name)}</div><div class="big num">${a.big}</div><p>${a.text}</p></article>`).join('')}</div>`
}

// trades, with the fantasy points each side's new players have scored since
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
    const totals = t.sides.map((s) => s.gets.reduce((sum, pid) => sum + pointsSince(pid, t.week), 0))
    const ahead = totals[0] === totals[1] ? null : totals[0] > totals[1] ? 0 : 1
    return `<article class="panel trade">
      <div class="date"><span>${new Date(t.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        <span class="verdict ${ahead == null ? 'even' : 'win'}">${ahead == null ? 'Even so far' : `${esc(D.M.get(t.sides[ahead].rid).name)} +${f1(Math.abs(totals[0] - totals[1]))} so far`}</span></div>
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
  let cells = `<span></span>${slots.map((s) => `<div class="colh" style="${mc(bySlot.get(s))}">${av(bySlot.get(s))}<span>${esc(D.M.get(bySlot.get(s))?.name || '')}</span></div>`).join('')}`
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
  const next = D.futureWeeks.slice(0, 3).map((w) => {
    const g = pairs(S.matchups[w]).find(([a, b]) => a.roster_id === V.me || b.roster_id === V.me)
    if (!g) return ''
    const o = g[0].roster_id === V.me ? g[1].roster_id : g[0].roster_id
    return `<div class="panel" style="${mc(o)}"><b>Week ${w}</b>${mgr(o)}<span class="num">${pct(winChance(D.strength[V.me], D.strength[o], D.doubt))} to win</span></div>`
  }).join('')
  $('#team').innerHTML = `<div class="head"><h2 id="h-team">Your team</h2></div>
    <article class="panel team" style="${mc(V.me)}">
      <div class="team-top">${av(V.me)}<h2>${esc(m.name)}</h2></div>
      <div class="stats"><span class="chip">${ord(rank)} · ${row.w}-${row.l}${row.t ? `-${row.t}` : ''}</span><span class="chip">PF ${f1(row.pf)}</span>
        <span class="chip">Playoffs ${pct(V.tally[V.me].po)}</span><span class="chip">Title ${pct(V.tally[V.me].title)}</span>
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

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b) return
  const d = b.dataset
  if (d.me) {
    V.me = Number(d.me) === V.me ? null : Number(d.me)
    store.set(ME_KEY, V.me ?? '')
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
  if (e.target.id !== 'week-pick') return
  V.week = Number(e.target.value)
  try { await loadWeekGames(V.week) } catch { /* lineups still show without the best-game marks */ }
  render()
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
