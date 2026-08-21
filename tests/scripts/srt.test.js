import { describe, expect, it } from 'vitest'
import {
  captionCues, captionTimeline, chunkText, concatPlaylist, coverage, formatSrt,
  formatTimestamp, joinCueTracks, MAX_CHARS, parseSrt, parseTimestamp, splitCue,
  tidyCues,
} from '../../scripts/lib/srt.mjs'

describe('timestamps', () => {
  it('round-trips', () => {
    for (const s of [0, 0.001, 1.5, 83.456, 3661.999]) {
      expect(parseTimestamp(formatTimestamp(s))).toBeCloseTo(s, 3)
    }
  })
  it('formats SRT comma-millisecond form', () => {
    expect(formatTimestamp(83.456)).toBe('00:01:23,456')
    expect(formatTimestamp(0)).toBe('00:00:00,000')
  })
  it('accepts the VTT dot form too, since editors produce both', () => {
    expect(parseTimestamp('00:01:23.456')).toBeCloseTo(83.456, 3)
  })
  it('rejects nonsense rather than silently returning 0', () => {
    expect(() => parseTimestamp('later')).toThrow(/bad SRT timestamp/)
  })
})

describe('parseSrt', () => {
  const srt = '1\n00:00:00,000 --> 00:00:02,000\nHey, this is Michael Lamb.\n\n' +
              '2\n00:00:02,000 --> 00:00:04,500\nThis is the first response\nto a new feature.\n'

  it('reads blocks and joins wrapped lines', () => {
    const cues = parseSrt(srt)
    expect(cues).toHaveLength(2)
    expect(cues[1]).toEqual({ start: 2, end: 4.5, text: 'This is the first response to a new feature.' })
  })

  it('tolerates CRLF, a BOM, blank runs and missing index lines', () => {
    const messy = '﻿00:00:00,000 --> 00:00:01,000\r\nOne\r\n\r\n\r\n' +
                  '7\r\n00:00:01,000 --> 00:00:02,000\r\nTwo\r\n'
    expect(parseSrt(messy).map(c => c.text)).toEqual(['One', 'Two'])
  })

  it('skips a broken block instead of losing the whole file', () => {
    const broken = '1\nnot a timing line\nOrphan\n\n2\n00:00:05,000 --> 00:00:06,000\nKept\n'
    expect(parseSrt(broken).map(c => c.text)).toEqual(['Kept'])
  })

  it('drops cues an editor emptied out', () => {
    expect(parseSrt('1\n00:00:00,000 --> 00:00:01,000\n\n')).toEqual([])
  })

  it('round-trips through formatSrt', () => {
    expect(parseSrt(formatSrt(parseSrt(srt)))).toEqual(parseSrt(srt))
  })
})

describe('chunkText', () => {
  it('breaks at word boundaries under the limit', () => {
    const out = chunkText('one two three four five six seven eight nine ten', 20)
    expect(out.every(l => l.length <= 20)).toBe(true)
    expect(out.join(' ')).toBe('one two three four five six seven eight nine ten')
  })
  it('never chops a word that is longer than the limit', () => {
    expect(chunkText('supercalifragilistic ok', 10)).toEqual(['supercalifragilistic', 'ok'])
  })
  it('returns nothing for empty input', () => {
    expect(chunkText('   ')).toEqual([])
  })
})

describe('splitCue', () => {
  const segment = {
    start: 11.2, end: 23.76,
    text: 'This is the first response to a cool new feature on the Jackson Film Club web portal. If you',
  }

  it('keeps a short cue whole', () => {
    expect(splitCue({ start: 0, end: 2, text: 'Short one' })).toEqual([{ start: 0, end: 2, text: 'Short one' }])
  })

  it('stays strictly inside the segment span', () => {
    // The whole point: whisper's SEGMENT bounds are trustworthy, its word
    // timings are not, so error must never escape one segment.
    const cues = splitCue(segment)
    expect(cues.length).toBeGreaterThan(1)
    expect(cues[0].start).toBe(segment.start)
    expect(cues[cues.length - 1].end).toBe(segment.end)
    for (const c of cues) {
      expect(c.start).toBeGreaterThanOrEqual(segment.start)
      expect(c.end).toBeLessThanOrEqual(segment.end)
    }
  })

  it('is contiguous and monotonic — no gaps, no overlaps, no drift', () => {
    const cues = splitCue(segment)
    cues.slice(1).forEach((c, i) => expect(c.start).toBeCloseTo(cues[i].end, 6))
  })

  it('spends the whole span and no more', () => {
    const cues = splitCue({ start: 0, end: 10, text: 'aaaa bbbb cccc dddd' }, 9)
    expect(cues.reduce((n, c) => n + (c.end - c.start), 0)).toBeCloseTo(10, 6)
  })

  it('loses no words', () => {
    expect(splitCue(segment).map(c => c.text).join(' ')).toBe(segment.text)
  })
})

describe('tidyCues', () => {
  it('clears a cue that would linger', () => {
    const [cue] = tidyCues([{ start: 0, end: 30, text: 'x' }], { maxSeconds: 6 })
    expect(cue.end).toBe(6)
  })

  it('shortening one cue does not shift the next', () => {
    const cues = tidyCues([
      { start: 0, end: 30, text: 'a' },
      { start: 31, end: 33, text: 'b' },
    ], { maxSeconds: 6 })
    expect(cues[1].start).toBe(31)
  })

  it('merges an unreadably short cue into the line before it', () => {
    // REGRESSION: cues from splitCue are CONTIGUOUS, so there is never room to
    // extend a short cue — the earlier implementation tried, and its test only
    // passed because the fixture left a gap. Fixtures here are contiguous.
    const cues = tidyCues([
      { start: 0, end: 2, text: 'So, alright, Jackson Film Club.' },
      { start: 2, end: 2.2, text: 'Bye.' },
    ], { minSeconds: 0.9 })
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('So, alright, Jackson Film Club. Bye.')
    expect(cues[0].end).toBe(2.2)
  })

  it('leaves a short opening cue alone when there is nothing to merge into', () => {
    const cues = tidyCues([
      { start: 0, end: 0.3, text: 'Hey.' },
      { start: 0.3, end: 4, text: 'This is a much longer line indeed.' },
    ], { minSeconds: 0.9, mergeChars: 20 })
    expect(cues.map(c => c.text)).toEqual(['Hey.', 'This is a much longer line indeed.'])
  })

  it('will not merge into a line that is already long', () => {
    const long = 'x'.repeat(60)
    const cues = tidyCues([
      { start: 0, end: 3, text: long },
      { start: 3, end: 3.2, text: 'tail' },
    ], { minSeconds: 0.9, mergeChars: 40 })
    expect(cues).toHaveLength(2)
  })

  it('sorts, and drops zero-length or empty cues', () => {
    const cues = tidyCues([
      { start: 5, end: 6, text: 'second' },
      { start: 1, end: 1, text: 'zero length' },
      { start: 0, end: 1, text: '' },
      { start: 2, end: 3, text: 'first' },
    ])
    expect(cues.map(c => c.text)).toEqual(['first', 'second'])
  })
})

describe('captionCues', () => {
  const whisper = '1\n00:00:00,000 --> 00:00:11,200\n' +
    'Hey, this is Michael Lamb. I am currently recording this message on Thursday, August the 20th.\n\n' +
    '2\n00:00:11,200 --> 00:00:23,760\n' +
    'This is the first response to a cool new feature on the Jackson Film Club web portal. If you\n'

  it('turns fat whisper segments into readable cues', () => {
    const cues = captionCues(whisper)
    expect(cues.length).toBeGreaterThan(4)
    for (const c of cues) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHARS)
      expect(c.end - c.start).toBeLessThanOrEqual(6.001)
    }
  })

  it('never runs past the end of the audio it came from', () => {
    const cues = captionCues(whisper)
    expect(cues[cues.length - 1].end).toBeLessThanOrEqual(23.76)
  })

  it('keeps every word, in order', () => {
    expect(captionCues(whisper).map(c => c.text).join(' '))
      .toBe(parseSrt(whisper).map(c => c.text).join(' '))
  })

  it('reports how much of the clip is captioned', () => {
    expect(coverage(captionCues(whisper))).toBeGreaterThan(15)
  })
})

describe('captionTimeline', () => {
  const cues = [
    { start: 1, end: 3, text: 'first' },
    { start: 3, end: 5, text: 'second' },
    { start: 7, end: 8, text: 'third' },
  ]

  it('covers the whole clip with no gaps and no overlaps', () => {
    const t = captionTimeline(cues, 10)
    expect(t[0].start).toBe(0)
    expect(t[t.length - 1].end).toBe(10)
    t.slice(1).forEach((seg, i) => expect(seg.start).toBeCloseTo(t[i].end, 6))
  })

  it('makes silence explicit — the frame is still on screen', () => {
    const t = captionTimeline(cues, 10)
    expect(t.filter(s => s.text === '').map(s => [s.start, s.end]))
      .toEqual([[0, 1], [5, 7], [8, 10]])
  })

  it('never runs past the audio', () => {
    // A transcript edited to overshoot must not extend the video.
    const t = captionTimeline([{ start: 0, end: 99, text: 'long' }], 4)
    expect(t).toEqual([{ start: 0, end: 4, text: 'long' }])
  })

  it('handles a clip with no cues at all', () => {
    expect(captionTimeline([], 5)).toEqual([{ start: 0, end: 5, text: '' }])
  })
})

describe('concatPlaylist', () => {
  const segments = [
    { start: 0, end: 1, text: '' },
    { start: 1, end: 3.5, text: 'hello' },
  ]
  const pathFor = (text) => (text ? `cue-${text}.png` : 'plain.png')

  it('emits durations per segment', () => {
    const out = concatPlaylist(segments, pathFor)
    expect(out).toContain("file 'plain.png'\nduration 1.000")
    expect(out).toContain("file 'cue-hello.png'\nduration 2.500")
  })

  it('repeats the last file, because concat drops the final duration', () => {
    // Without this the closing segment collapses to a single frame.
    const lines = concatPlaylist(segments, pathFor).trim().split('\n')
    expect(lines[0]).toBe('ffconcat version 1.0')
    expect(lines[lines.length - 1]).toBe("file 'cue-hello.png'")
  })

  it('reuses one file for every uncaptioned gap', () => {
    const many = [
      { start: 0, end: 1, text: '' }, { start: 1, end: 2, text: 'a' },
      { start: 2, end: 3, text: '' }, { start: 3, end: 4, text: 'b' },
    ]
    const out = concatPlaylist(many, pathFor)
    expect(out.match(/plain\.png/g)).toHaveLength(2)
  })
})

describe('joinCueTracks', () => {
  const track = (texts, duration) => ({
    duration,
    cues: texts.map((text, i) => ({ start: i, end: i + 1, text })),
  })

  it('shifts each clip by everything that plays before it', () => {
    // Two 3s clips with a 0.5s gap: clip two starts at 3.5.
    const out = joinCueTracks([track(['a1', 'a2'], 3), track(['b1', 'b2'], 3)], 0.5)
    expect(out.map(c => [c.text, c.start])).toEqual([
      ['a1', 0], ['a2', 1], ['b1', 3.5], ['b2', 4.5],
    ])
  })

  it('inserts no gap before the first clip and none after the last', () => {
    const out = joinCueTracks([track(['a'], 2), track(['b'], 2)], 0.5)
    expect(out[0].start).toBe(0)
    expect(out[out.length - 1].end).toBe(3.5)
  })

  it('clamps a cue that overran its clip', () => {
    // THE failure this guards: a cue bleeding past its slot would appear while
    // the NEXT member is speaking and caption them with someone else's words.
    const over = { duration: 2, cues: [{ start: 0, end: 30, text: 'runs long' }] }
    const out = joinCueTracks([over, track(['next'], 2)], 0.5)
    expect(out[0].end).toBe(2)
    expect(out[1].start).toBe(2.5)
    expect(out[0].end).toBeLessThanOrEqual(out[1].start)
  })

  it('drops a cue that starts after its clip has ended', () => {
    const past = { duration: 2, cues: [{ start: 5, end: 6, text: 'ghost' }] }
    expect(joinCueTracks([past], 0.5)).toEqual([])
  })

  it('tolerates a clip with no transcript cues', () => {
    const out = joinCueTracks([{ duration: 2, cues: [] }, track(['b'], 2)], 0.5)
    expect(out.map(c => c.text)).toEqual(['b'])
    expect(out[0].start).toBe(2.5)
  })

  it('refuses to guess the gap or a missing duration', () => {
    // Guessing either would drift every caption after the first clip.
    expect(() => joinCueTracks([track(['a'], 2)], undefined)).toThrow(/gap/)
    expect(() => joinCueTracks([{ cues: [], duration: 0 }], 0.5)).toThrow(/duration/)
  })

  it('uses the same gap the audio concat uses', async () => {
    const { CONCAT_GAP_SECONDS } = await import('../../scripts/lib/voices.mjs')
    const out = joinCueTracks([track(['a'], 2), track(['b'], 2)], CONCAT_GAP_SECONDS)
    expect(out[1].start).toBe(2 + CONCAT_GAP_SECONDS)
  })
})
