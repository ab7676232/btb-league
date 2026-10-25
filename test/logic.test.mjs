import test from 'node:test'
import assert from 'node:assert/strict'
import { fantasyPoints, pairs, allPlay, standings, strengths, simulate, winChance, playerAverage, strengthSd, consensus, lockRead, PRIOR_WEEKS, LOCK_UPLIFT, LAST_SEASON_GAMES, ROOKIE_AVG, STRENGTH_SD } from '../logic.js'

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

test('of several feed answers, the one most servers agree on wins', () => {
  const a = [{ roster_id: 7, points: 244 }]
  const b = [{ roster_id: 7, points: 234.5 }]
  assert.deepEqual(consensus([b, a, a, null, b, a]), a)
  assert.deepEqual(consensus([b, a]), b)
  assert.equal(consensus([]), null)
})

test('a counted score reads as a lock, a ride to the last game, or neither', () => {
  // locked Thursday's 30.5 before Saturday's 21.0
  assert.deepEqual(lockRead(30.5, [30.5, 21]), { kind: 'locked', gain: 9.5, left: 0 })
  // locked Friday's 29.5, then he put up 41 on Saturday
  assert.deepEqual(lockRead(29.5, [28.5, 29.5, 41]), { kind: 'locked', gain: -11.5, left: 11.5 })
  assert.deepEqual(lockRead(21, [30.5, 21]), { kind: 'rode', gain: 0, left: 9.5 })
  assert.deepEqual(lockRead(0, [17.5, 19.5]), { kind: 'other', gain: 0, left: 19.5 })
  assert.deepEqual(lockRead(0, []), { kind: 'other', gain: 0, left: 0 })
})
