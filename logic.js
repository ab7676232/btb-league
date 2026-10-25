// The league page's math, kept apart from the page so it can be tested.
// Everything here works from Sleeper's own data: matchup points, lineups and
// box-score stats scored with the league's own settings.

// a team's week-to-week spread, and what a week still being played can swing by
export const WEEK_SD = 24
export const LIVE_SD = 18
// how far a team's real strength can sit from its estimate, once weeks pile up
export const STRENGTH_SD = 14
// extra doubt about that estimate before any week is played, shrinking as weeks are
export const EARLY_SD = 10
// last season counts as this many of this season's games in a player's average
export const LAST_SEASON_GAMES = 10
// a player with no last season leans on a bench-level average for this many games
export const ROOKIE_GAMES = 5
export const ROOKIE_AVG = 15
// the roster estimate counts as this many played weeks, so real weeks take over as they pile up
export const PRIOR_WEEKS = 4
// a lock-in week takes each player's best-ish game, so a lineup scores above its per-game average
export const LOCK_UPLIFT = 1.25

/** A player's points per game: this season's, steadied by last season's until games pile up. */
export function playerAverage(fp, gp, lastAvg) {
  const [weight, base] = lastAvg != null ? [LAST_SEASON_GAMES, lastAvg] : [ROOKIE_GAMES, ROOKIE_AVG]
  return (fp + weight * base) / (gp + weight)
}

/** Doubt about a team's strength after `weeks` played weeks. */
export const strengthSd = (weeks) => STRENGTH_SD + EARLY_SD * PRIOR_WEEKS / (PRIOR_WEEKS + weeks)

export const fantasyPoints = (stats, scoring) =>
  Object.entries(scoring || {}).reduce((sum, [key, weight]) => sum + (Number(weight) || 0) * (Number(stats?.[key]) || 0), 0)

/** One week's matchups as pairs of sides, by matchup_id; byes and empty slots dropped. */
export function pairs(matchups = []) {
  const byId = new Map()
  for (const m of matchups) {
    if (m.matchup_id == null) continue
    byId.set(m.matchup_id, [...(byId.get(m.matchup_id) || []), m])
  }
  return [...byId.keys()].sort((a, b) => a - b).map((id) => byId.get(id)).filter((p) => p.length === 2)
}

/** Each team's record against every other team's score that week. */
export function allPlay(sides) {
  const out = {}
  for (const s of sides) {
    const others = sides.filter((o) => o.roster_id !== s.roster_id)
    out[s.roster_id] = {
      w: others.filter((o) => s.points > o.points).length,
      l: others.filter((o) => s.points < o.points).length,
      t: others.filter((o) => s.points === o.points).length,
    }
  }
  return out
}

/** Season standings from finished weeks: record, points for and against, streak, all-play. */
export function standings(rosterIds, finishedWeeks) {
  const table = Object.fromEntries(rosterIds.map((r) => [r, { rid: r, w: 0, l: 0, t: 0, pf: 0, pa: 0, apW: 0, apL: 0, streak: '', results: [], scores: [] }]))
  for (const week of finishedWeeks) {
    const ps = pairs(week)
    const ap = allPlay(ps.flat())
    for (const [a, b] of ps) {
      for (const [s, o] of [[a, b], [b, a]]) {
        const row = table[s.roster_id]
        if (!row) continue
        const res = s.points > o.points ? 'W' : s.points < o.points ? 'L' : 'T'
        row[res.toLowerCase()]++
        row.pf += s.points
        row.pa += o.points
        row.results.push(res)
        row.scores.push(s.points)
        row.apW += ap[s.roster_id].w
        row.apL += ap[s.roster_id].l
      }
    }
  }
  for (const row of Object.values(table)) {
    const last = row.results[row.results.length - 1]
    let n = 0
    for (let i = row.results.length - 1; i >= 0 && row.results[i] === last; i--) n++
    row.streak = last ? `${last}${n}` : ''
  }
  return Object.values(table).sort((a, b) => b.w - a.w || a.l - b.l || b.pf - a.pf)
}

/**
 * Each team's expected weekly score: its roster estimate (the best `slots`
 * players' points per game, lifted for lock-in and scaled to the league's real
 * weekly scores once there are some) blended with its real weekly scores.
 */
export function strengths(rosterAvg, scoresByRid, slots) {
  const rids = Object.keys(rosterAvg)
  const prior = Object.fromEntries(rids.map((r) => [r, rosterAvg[r].slice().sort((a, b) => b - a).slice(0, slots).reduce((s, v) => s + v, 0) * LOCK_UPLIFT]))
  const played = rids.flatMap((r) => scoresByRid[r] || [])
  const priorMean = rids.reduce((s, r) => s + prior[r], 0) / (rids.length || 1)
  const scale = played.length && priorMean > 0 ? (played.reduce((s, v) => s + v, 0) / played.length) / priorMean : 1
  return Object.fromEntries(rids.map((r) => {
    const own = scoresByRid[r] || []
    const sum = own.reduce((s, v) => s + v, 0)
    return [r, (sum + PRIOR_WEEKS * prior[r] * scale) / (own.length + PRIOR_WEEKS)]
  }))
}

const randn = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())

/**
 * Plays out the rest of the regular season n times. `played` holds finished
 * weeks' records, `live` the week being played (its points so far), `schedule`
 * the weeks still to come as [ridA, ridB] pairs, `forced` week-index winners.
 * Top `playoffTeams` make it, the top two with byes, then a 6-team bracket.
 */
export function simulate({ rids, strength, table, live = [], schedule = [], forced = {}, playoffTeams = 6, n = 4000, rand = Math.random, doubt = STRENGTH_SD }) {
  const tally = Object.fromEntries(rids.map((r) => [r, { po: 0, bye: 0, final: 0, title: 0, wins: 0 }]))
  const base = Object.fromEntries(table.map((row) => [row.rid, row]))
  for (let s = 0; s < n; s++) {
    const real = Object.fromEntries(rids.map((r) => [r, strength[r] + doubt * randn(rand)]))
    const score = (r) => real[r] + WEEK_SD * randn(rand)
    const wins = Object.fromEntries(rids.map((r) => [r, base[r]?.w ?? 0]))
    const pf = Object.fromEntries(rids.map((r) => [r, base[r]?.pf ?? 0]))
    for (const [a, b] of live) {
      const sa = a.points + LIVE_SD * randn(rand) / Math.SQRT2
      const sb = b.points + LIVE_SD * randn(rand) / Math.SQRT2
      wins[sa > sb ? a.roster_id : b.roster_id]++
      pf[a.roster_id] += sa
      pf[b.roster_id] += sb
    }
    schedule.forEach((week, wi) => week.forEach(([a, b], gi) => {
      const sa = score(a)
      const sb = score(b)
      wins[forced[`${wi}:${gi}`] ?? (sa > sb ? a : b)]++
      pf[a] += sa
      pf[b] += sb
    }))
    const seeds = [...rids].sort((a, b) => wins[b] - wins[a] || pf[b] - pf[a])
    const field = seeds.slice(0, playoffTeams)
    field.forEach((r) => tally[r].po++)
    field.slice(0, 2).forEach((r) => tally[r].bye++)
    const game = (a, b) => (score(a) > score(b) ? a : b)
    if (field.length >= 6) {
      const r1 = game(field[2], field[5])
      const r2 = game(field[3], field[4])
      const [low, high] = seeds.indexOf(r1) > seeds.indexOf(r2) ? [r1, r2] : [r2, r1]
      const f1 = game(field[0], low)
      const f2 = game(field[1], high)
      tally[f1].final++
      tally[f2].final++
      tally[game(f1, f2)].title++
    }
    rids.forEach((r) => { tally[r].wins += wins[r] })
  }
  for (const t of Object.values(tally)) for (const k of Object.keys(t)) t[k] /= n
  return tally
}

/** Chance a beats b in one week. */
export function winChance(sa, sb, doubt = STRENGTH_SD) {
  const z = (sa - sb) / Math.sqrt(2 * (WEEK_SD ** 2 + doubt ** 2))
  return 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3)))
}
