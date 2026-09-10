import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fmtDuration, fmtBytes, voiceDaysLeft, groupVoiceClips, sanitizeVoicePrompt,
  countPendingVoice, countOpenFeedback,
} from '../../admin/lib.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('fmtDuration', () => {
  it('formats seconds as m:ss with zero-padded seconds', () => {
    expect(fmtDuration(0)).toBe('0:00')
    expect(fmtDuration(7)).toBe('0:07')
    expect(fmtDuration(65)).toBe('1:05')
    expect(fmtDuration(180)).toBe('3:00')
    expect(fmtDuration(59.6)).toBe('1:00')  // rounds
  })

  it('em-dash for missing/invalid durations', () => {
    expect(fmtDuration(null)).toBe('—')
    expect(fmtDuration(undefined)).toBe('—')
    expect(fmtDuration('')).toBe('—')
    expect(fmtDuration(-3)).toBe('—')
    expect(fmtDuration('nope')).toBe('—')
  })
})

describe('fmtBytes', () => {
  it('formats B / KB / MB tiers', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2048)).toBe('2 KB')
    expect(fmtBytes(950 * 1024)).toBe('950 KB')
    expect(fmtBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })

  it('em-dash for missing/invalid sizes', () => {
    expect(fmtBytes(null)).toBe('—')
    expect(fmtBytes(undefined)).toBe('—')
    expect(fmtBytes('')).toBe('—')
    expect(fmtBytes(-1)).toBe('—')
  })
})

describe('voiceDaysLeft', () => {
  it('rounds up: anything still in the future is at least 1 day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
    const nowSec = Math.floor(Date.now() / 1000)
    expect(voiceDaysLeft(nowSec + 3600)).toBe(1)          // 1h left → 1d
    expect(voiceDaysLeft(nowSec + 86400)).toBe(1)         // exactly 1 day
    expect(voiceDaysLeft(nowSec + 86400 + 1)).toBe(2)
    expect(voiceDaysLeft(nowSec + 59 * 86400 + 3600)).toBe(60)
  })

  it('clamps expired to 0 and nulls invalid input', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
    const nowSec = Math.floor(Date.now() / 1000)
    expect(voiceDaysLeft(nowSec - 10)).toBe(0)
    expect(voiceDaysLeft(null)).toBeNull()
    expect(voiceDaysLeft(undefined)).toBeNull()
    expect(voiceDaysLeft(0)).toBeNull()
    expect(voiceDaysLeft('nope')).toBeNull()
  })

  it('accepts an explicit now anchor', () => {
    const now = Date.parse('2026-08-01T00:00:00Z')
    expect(voiceDaysLeft(Date.parse('2026-08-31T00:00:00Z') / 1000, now)).toBe(30)
  })
})

describe('groupVoiceClips', () => {
  const row = (promptId, memberId, at, extra = {}) => ({
    keyName: `voice:${promptId}:${memberId}`,
    promptId, memberId, at, r2Key: `voice/${promptId}/${memberId}.webm`, ...extra,
  })

  it('groups by promptId with the current prompt first and clips newest-first', () => {
    const rows = [
      row('older-prompt', 'm1', '2026-06-01T00:00:00Z', { promptText: 'Old question' }),
      row('summer-2026', 'm2', '2026-08-01T00:00:00Z', { promptText: 'What are you watching?' }),
      row('summer-2026', 'm3', '2026-08-05T00:00:00Z'),
      row('older-prompt', 'm4', '2026-07-15T00:00:00Z'),
    ]
    const groups = groupVoiceClips(rows, 'summer-2026')
    expect(groups.map(g => g.promptId)).toEqual(['summer-2026', 'older-prompt'])
    expect(groups[0].promptText).toBe('What are you watching?')
    expect(groups[0].clips.map(c => c.memberId)).toEqual(['m3', 'm2'])
    expect(groups[1].clips.map(c => c.memberId)).toEqual(['m4', 'm1'])
  })

  it('orders non-current groups by most recent submission', () => {
    const rows = [
      row('a', 'm1', '2026-01-01T00:00:00Z'),
      row('b', 'm2', '2026-07-01T00:00:00Z'),
      row('c', 'm3', '2026-04-01T00:00:00Z'),
    ]
    const groups = groupVoiceClips(rows, 'zzz-current-has-no-rows')
    expect(groups.map(g => g.promptId)).toEqual(['b', 'c', 'a'])
  })

  it('drops rows without a promptId and tolerates empty input', () => {
    expect(groupVoiceClips([{ memberId: 'm1' }, null], 'x')).toEqual([])
    expect(groupVoiceClips([], 'x')).toEqual([])
    expect(groupVoiceClips(undefined, 'x')).toEqual([])
  })
})

describe('sanitizeVoicePrompt', () => {
  it('slugifies the id and trims the text', () => {
    expect(sanitizeVoicePrompt({ id: '  Summer 2026! ', text: '  What are you watching?  ' }))
      .toEqual({ id: 'summer-2026', text: 'What are you watching?' })
  })

  it('keeps a valid deadline and drops an empty one', () => {
    expect(sanitizeVoicePrompt({ id: 'x', text: 'y', deadline: '2026-09-30' }))
      .toEqual({ id: 'x', text: 'y', deadline: '2026-09-30' })
    expect(sanitizeVoicePrompt({ id: 'x', text: 'y', deadline: '  ' }))
      .toEqual({ id: 'x', text: 'y' })
  })

  it('nulls unusable input: missing id/text or a malformed deadline', () => {
    expect(sanitizeVoicePrompt({ id: '', text: 'y' })).toBeNull()
    expect(sanitizeVoicePrompt({ id: '!!!', text: 'y' })).toBeNull()   // slug empties out
    expect(sanitizeVoicePrompt({ id: 'x', text: '   ' })).toBeNull()
    expect(sanitizeVoicePrompt({ id: 'x', text: 'y', deadline: 'Sept 30' })).toBeNull()
    expect(sanitizeVoicePrompt(null)).toBeNull()
    expect(sanitizeVoicePrompt(undefined)).toBeNull()
  })
})

// --- Tab-strip review badges ---

describe('countPendingVoice', () => {
  const clip = (o) => ({ promptId: 'p', r2Key: 'voice/x.webm', ...o })

  it('counts anything not approved/rejected, including a status-less row', () => {
    expect(countPendingVoice([
      clip({ status: 'approved' }),
      clip({ status: 'rejected' }),
      clip({ status: 'pending' }),
      clip({}),               // never moderated — the tab pills this "pending"
      clip({ status: null }),
    ])).toBe(3)
  })

  it('ignores rows the Voice tab itself drops (no promptId / no r2Key)', () => {
    expect(countPendingVoice([
      clip({}),
      { r2Key: 'voice/y.webm' },        // no promptId
      { promptId: 'p' },                // no r2Key
      null,
    ])).toBe(1)
  })

  it('is 0 for empty/missing input', () => {
    expect(countPendingVoice([])).toBe(0)
    expect(countPendingVoice(null)).toBe(0)
    expect(countPendingVoice(undefined)).toBe(0)
  })
})

describe('countOpenFeedback', () => {
  it('counts every parseable row — a present row IS an unhandled one', () => {
    const keys = [{ name: 'feedback:1' }, { name: 'feedback:2' }]
    const values = { 'feedback:1': '{"message":"a"}', 'feedback:2': '{"message":"b"}' }
    expect(countOpenFeedback(keys, values)).toBe(2)
  })

  it('skips unparseable or missing values, as the tab does', () => {
    const keys = [{ name: 'feedback:1' }, { name: 'feedback:2' }, { name: 'feedback:3' }]
    const values = { 'feedback:1': '{"message":"a"}', 'feedback:2': 'not json' }
    expect(countOpenFeedback(keys, values)).toBe(1)
  })

  it('is 0 for empty/missing input', () => {
    expect(countOpenFeedback([], {})).toBe(0)
    expect(countOpenFeedback(null, null)).toBe(0)
    expect(countOpenFeedback(undefined, undefined)).toBe(0)
  })
})

describe('groupVoiceClips — free-form messages', () => {
  const round = (promptId, at, promptText) => ({ promptId, at, promptText, r2Key: 'x' })
  const msg = (promptId, at, promptText) => ({ promptId, at, promptText, r2Key: 'x', kind: 'message' })

  it('collapses every message into one inbox instead of a round each', () => {
    // Five messages carry five minted promptIds. Grouping them by promptId
    // would bury the actual round under five one-clip "rounds".
    const groups = groupVoiceClips([
      round('spring', '2026-08-01T00:00:00Z', 'What did you rewatch?'),
      msg('msg_a1', '2026-08-02T00:00:00Z', 'The ending of Nope'),
      msg('msg_b2', '2026-08-03T00:00:00Z', 'Sirk, briefly'),
    ], 'spring')

    expect(groups).toHaveLength(2)
    expect(groups[0].promptId).toBe('spring')
    expect(groups[1].messages).toBe(true)
    expect(groups[1].clips.map(c => c.promptId)).toEqual(['msg_b2', 'msg_a1'])
  })

  it('pins the current round first and the inbox second, above older rounds', () => {
    const groups = groupVoiceClips([
      round('older', '2026-07-01T00:00:00Z', 'Old one'),
      msg('msg_a1', '2026-06-01T00:00:00Z', 'An old message'),
      round('spring', '2026-08-01T00:00:00Z', 'Current'),
    ], 'spring')
    // The inbox outranks older rounds even when its newest clip is older:
    // it is an inbox, and things in it are waiting on a human.
    expect(groups.map(g => g.messages ? 'messages' : g.promptId)).toEqual(['spring', 'messages', 'older'])
  })

  it('carries no promptId on the inbox, because there is no round to publish', () => {
    const groups = groupVoiceClips([msg('msg_a1', '2026-08-02T00:00:00Z', 'Subject')], 'spring')
    expect(groups[0].promptId).toBe('')
    expect(groups[0].promptText).toBe('Messages')
  })

  it('counts pending messages toward the review badge like any other clip', () => {
    expect(countPendingVoice([
      msg('msg_a1', '2026-08-02T00:00:00Z', 'Subject'),
      { ...msg('msg_b2', '2026-08-03T00:00:00Z', 'Done'), status: 'approved' },
    ])).toBe(1)
  })
})

describe('sanitizeVoicePrompt — the msg_ namespace is reserved', () => {
  it('refuses a prompt id in the message namespace', () => {
    // Unreachable through the slugifier today (it cannot emit an underscore);
    // the guard is here so the reservation survives someone loosening it.
    expect(sanitizeVoicePrompt({ id: 'msg_deadbeef01', text: 'Sneaky' })).toBeNull()
  })

  it('still slugifies an ordinary prompt id', () => {
    expect(sanitizeVoicePrompt({ id: '  Summer 2026! ', text: 'Best snack?' }))
      .toEqual({ id: 'summer-2026', text: 'Best snack?' })
  })
})
