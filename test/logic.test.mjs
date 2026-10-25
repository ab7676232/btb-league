import test from 'node:test'
import assert from 'node:assert/strict'
import { fantasyPoints, pairs, allPlay, standings, strengths, simulate, winChance, playerAverage, strengthSd, starterCount, liveWinChance, rollSeason, PRIOR_WEEKS, LOCK_UPLIFT, LAST_SEASON_GAMES, ROOKIE_AVG, STRENGTH_SD } from '../logic.js'

const side = (roster_id, matchup_id, points) => ({ roster_id, matchup_id, points })

test('league scoring applies each weight, ignoring stats it does not score', () => {
  const scoring = { pts: 0.5, reb: 1, dd: 1, td: 2, bonus_pt_40p: 0 }
  assert.equal(fantasyPoints({ pts: 40, reb: 10, dd: 1, td: 0, bonus_pt_40p: 1, fga: 30 }, scoring), 31)
  assert.equal(fantasyPoints({}, scoring), 0)
})

test('matchups pair up by matchup id and drop an unpaired side', () => {
  const ps = pairs([side(1, 2, 10), side(2, 1, 5), side(3, 2, 7), side(4, 1, 9), side(5, null, 0), side(6, 3, 1)])
  assert.deepEqual(ps.map((p) => p.map((s) => s.roster_id)), [[2, 4], [1, 3]])
})

test('all-play counts each team against every other score that week', () => {
  const ap = allPlay([side(1, 1, 30), side(2, 1, 20), side(3, 2, 20), side(4, 2, 10)])
  assert.deepEqual(ap[1], { w: 3, l: 0, t: 0 })
  assert.deepEqual(ap[2], { w: 1, l: 1, t: 1 })
})

test('standings rank by wins then points, with streaks and all-play', () => {
  const w1 = [side(1, 1, 250), side(2, 1, 240), side(3, 2, 260), side(4, 2, 200)]
  const w2 = [side(1, 1, 230), side(3, 1, 220), side(2, 2, 210), side(4, 2, 215)]
  const t = standings([1, 2, 3, 4], [w1, w2])
  assert.deepEqual(t.map((r) => r.rid), [1, 3, 4, 2])
  const r1 = t[0]
  assert.equal(r1.streak, 'W2')
  assert.equal(r1.pf, 480)
  assert.equal(r1.apW, 2 + 3)
  assert.equal(t.find((r) => r.rid === 2).streak, 'L2')
})

test('strength starts from the roster and moves toward real scores as weeks are played', () => {
  const avg = { 1: [20, 20], 2: [10, 10] }
  const none = strengths(avg, {}, 2)
  assert.equal(none[1], 40 * LOCK_UPLIFT)
  const played = strengths(avg, { 1: [100], 2: [100] }, 2)
  // the league's real weeks average 100, so the roster estimates scale to a 100 mean first
  const scale = 100 / ((40 + 20) * LOCK_UPLIFT / 2)
  assert.ok(Math.abs(played[1] - (100 + PRIOR_WEEKS * 40 * LOCK_UPLIFT * scale) / (1 + PRIOR_WEEKS)) < 1e-9)
  assert.ok(played[1] > played[2])
})

test('a much stronger team makes the playoffs nearly always; forcing a result moves the odds', () => {
  const rids = [1, 2, 3, 4, 5, 6, 7, 8]
  const strength = Object.fromEntries(rids.map((r) => [r, r === 1 ? 320 : 240]))
  const table = rids.map((rid) => ({ rid, w: 0, pf: 0 }))
  const week = [[1, 2], [3, 4], [5, 6], [7, 8]]
  const schedule = Array.from({ length: 10 }, () => week)
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const t = simulate({ rids, strength, table, schedule, n: 2000, rand })
  assert.ok(t[1].po > 0.97 && t[1].title > t[2].title)
  const sum = rids.reduce((s, r) => s + t[r].po, 0)
  assert.ok(Math.abs(sum - 6) < 1e-9)
  const forced = Object.fromEntries(schedule.map((_, wi) => [`${wi}:0`, 2]))
  const t2 = simulate({ rids, strength, table, schedule, forced, n: 2000, rand })
  assert.ok(t2[2].po > t[2].po)
})

test('even teams are a coin flip; a stronger one is favoured', () => {
  assert.ok(Math.abs(winChance(250, 250) - 0.5) < 1e-9)
  assert.ok(winChance(280, 240) > 0.75)
})

test('a hot two-game start is steadied by last season; a rookie leans on a bench-level average', () => {
  // 2 games at 36.8 against a 25-point last season
  const avg = playerAverage(73.6, 2, 25)
  assert.ok(Math.abs(avg - (73.6 + LAST_SEASON_GAMES * 25) / (2 + LAST_SEASON_GAMES)) < 1e-9)
  assert.ok(avg < 28)
  assert.equal(playerAverage(0, 0, null), ROOKIE_AVG)
  assert.ok(Math.abs(playerAverage(300, 10, 20) - 25) < 1e-9)
})

test('doubt about team strength is widest before any week and settles toward its floor', () => {
  assert.ok(strengthSd(0) > strengthSd(4))
  assert.ok(strengthSd(4) > strengthSd(20))
  assert.ok(strengthSd(1000) - STRENGTH_SD < 0.1)
})

// AbBall's week 1 lineup as the Sleeper app counted it on Oct 25
const games = { tor: [{ id: 't1', date: '2026-10-22', done: true }, { id: 't2', date: '2026-10-24', done: true }, { id: 't3', date: '2026-10-25', done: false }],
  den: [{ id: 'd1', date: '2026-10-22', done: true }, { id: 'd2', date: '2026-10-24', done: true }] }
const points = { t1: 22, t2: 34.5, d1: 11, d2: 36.5 }
const scoreIn = (id) => points[id] ?? 0
const projIn = (id) => (id === 't3' ? 23.37 : 0)

test('a locked starter counts his locked game, even with games left', () => {
  assert.deepEqual(starterCount({ lockedGame: 't2', teamGames: games.tor, scoreIn, projIn }), { state: 'locked', pts: 34.5, proj: 0 })
})

test('an unlocked starter with a game to come counts nothing yet and projects his last game', () => {
  assert.deepEqual(starterCount({ lockedGame: null, teamGames: games.tor, scoreIn, projIn }), { state: 'pending', pts: 0, proj: 23.37 })
})

test('an unlocked starter whose team is done counts its final game, zero if he sat it', () => {
  assert.deepEqual(starterCount({ lockedGame: null, teamGames: games.den, scoreIn, projIn }), { state: 'final', pts: 36.5, proj: 0 })
  assert.equal(starterCount({ lockedGame: null, teamGames: games.den, scoreIn: () => 0, projIn }).pts, 0)
  assert.equal(starterCount({ lockedGame: null, teamGames: [], scoreIn, projIn }).pts, 0)
})

test('live win odds land within a point of the app (56%, 61%, 47%, 60% on Oct 25)', () => {
  const near = (x, app) => assert.ok(Math.abs(100 * x - app) <= 1.05, `${(100 * x).toFixed(1)} vs ${app}`)
  near(liveWinChance(272.57, 267.53, [13.21, 23.37, 22.87, 22.16]), 56)
  near(liveWinChance(289.5, 280.69, [27.21, 23.98]), 61)
  near(liveWinChance(259.55, 262.38, [27.54, 31.13, 21.77, 23.48]), 47)
  near(liveWinChance(245.44, 232.75, [22.5, 21.7, 20.73, 25.03, 20.27, 23.96]), 60)
  assert.equal(liveWinChance(250, 240, []), 1)
})

test('one rolled season gives every team a record, six seeds in the bracket and a champion among them', () => {
  const rids = [1, 2, 3, 4, 5, 6, 7, 8]
  const strength = Object.fromEntries(rids.map((r) => [r, 240 + r]))
  const table = rids.map((rid) => ({ rid, w: 1, l: 0, pf: 250 }))
  const week = [[1, 2], [3, 4], [5, 6], [7, 8]]
  let seed = 11
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const s = rollSeason({ rids, strength, table, schedule: Array.from({ length: 20 }, () => week), rand })
  assert.equal(rids.reduce((n, r) => n + s.wins[r] + s.losses[r], 0), 8 * 21)
  assert.equal(s.field.length, 6)
  assert.deepEqual([...s.seeds].sort(), rids)
  assert.ok(s.field.includes(s.bracket.champ))
  assert.ok([s.bracket.final.a, s.bracket.final.b].includes(s.bracket.champ))
  assert.ok(s.bracket.semis.some((g) => g.a === s.field[0]) && s.bracket.semis.some((g) => g.a === s.field[1]))
})
