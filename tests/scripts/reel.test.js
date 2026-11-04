// scripts/lib/reel.mjs — word-pop captions + the Reel encode. Several of these
// pin bugs hit while making the first reel by hand; see the comments.
import { describe, expect, it } from 'vitest'
import {
  alignedAudioArgs, alignEdits, audioOffset, buildPrependIntroArgs, buildVideoReelArgs, chunkWords,
  groupsToSrt, hookHtml, instantiateReel, lowConfidence, mediaKind, parseReelArgs, wordPopHtml,
  wordPopTimeline, wordsFromWhisper,
} from '../../scripts/lib/reel.mjs'
import { concatPlaylist, parseSrt } from '../../scripts/lib/srt.mjs'
import { instantiateTemplate, parseArgs } from '../../scripts/lib/audiogram.mjs'
import { whisperWordArgs } from '../../scripts/lib/whisper.mjs'

const w = (text, start, end, p = 0.9) => ({ text, start, end, p })

describe('wordsFromWhisper', () => {
  it('flattens segments, trims, and glues whisper\'s split hyphenated words', () => {
    const json = { segments: [
      { words: [{ word: ' two', start: 1, end: 1.2, probability: 0.9 }, { word: ' -part', start: 1.2, end: 1.5, probability: 0.4 }] },
      { words: [{ word: ' episode', start: 1.6, end: 2, probability: 0.8 }, { word: ' ', start: 2, end: 2 }] },
    ] }
    expect(wordsFromWhisper(json)).toEqual([
      { text: 'two-part', start: 1, end: 1.5, p: 0.4 },
      { text: 'episode', start: 1.6, end: 2, p: 0.8 },
    ])
  })
})

describe('chunkWords', () => {
  it('closes groups at 4 words, 18 chars, a pause, or punctuation', () => {
    const words = [
      w('Hi,', 0, 0.5), w("I'm", 0.6, 0.8), w('a', 0.8, 0.9), w('member', 0.9, 1.2), w('of', 1.2, 1.3), w('it', 1.3, 1.4),
      w('wait', 2.0, 2.2), w('extraordinarily', 2.2, 2.9), w('long', 2.9, 3.1),
    ]
    expect(chunkWords(words).map(g => g.map(x => x.text).join(' '))).toEqual(
      ['Hi,', "I'm a member of", 'it', 'wait', 'extraordinarily', 'long'])
  })
})

describe('review SRT round trip', () => {
  it('one cue per group, and an unedited SRT keeps whisper\'s word timings', () => {
    const words = [w('Go', 0.3, 0.5), w('watch', 0.5, 0.8), w('movies.', 0.8, 1.2), w('Bye!', 2, 2.4)]
    const groups = chunkWords(words)
    const cues = parseSrt(groupsToSrt(groups))
    expect(cues.map(c => c.text)).toEqual(['Go watch movies.', 'Bye!'])
    const aligned = alignEdits(cues, words)
    expect(aligned.every(g => !g.retimed)).toBe(true)
    expect(aligned[0].words.map(x => x.start)).toEqual([0.3, 0.5, 0.8])
  })

  it('keeps timings for same-count edits (proper-noun fixes) and re-times only the edited cue otherwise', () => {
    const words = [w("I'm", 1.46, 1.78), w('Mary', 1.78, 2.38), w('Ann', 2.38, 2.62), w('Smith', 2.62, 3.1), w('hi', 3.2, 3.4)]
    const cues = [
      { start: 1.46, end: 2.62, text: "I'm Mary-Ann" },      // 3 words → 2: re-timed
      { start: 2.62, end: 3.1, text: 'Smythe' },           // same count: keeps timing
      { start: 3.2, end: 3.4, text: 'hi' },
    ]
    const [a, b, c] = alignEdits(cues, words)
    expect(a.retimed).toBe(true)
    expect(a.words[0].start).toBeCloseTo(1.46)
    expect(a.words[1].end).toBeCloseTo(2.62)
    expect(b).toEqual({ retimed: false, words: [{ text: 'Smythe', start: 2.62, end: 3.1 }] })
    expect(c.words[0]).toEqual({ text: 'hi', start: 3.2, end: 3.4 })
  })
})

describe('lowConfidence', () => {
  it('surfaces the words whisper was unsure of', () => {
    expect(lowConfidence([w('Bruges', 0, 1, 0.3), w('the', 1, 2, 0.99)]).map(x => x.text)).toEqual(['Bruges'])
  })
})

describe('wordPopTimeline', () => {
  const groups = [[{ text: 'Hi,', start: 0.5, end: 1 }], [{ text: 'go', start: 2, end: 2.2 }, { text: 'watch', start: 2.3, end: 2.6 }]]

  it('covers [0, duration] with blanks in the gaps and one state per word', () => {
    const tl = wordPopTimeline(groups, 4, { hold: 0.2 }) // frame-aligned at 30fps
    const r = t => Math.round(t * 30)
    expect(tl.map(s => [s.text, r(s.start), r(s.end)])).toEqual([
      ['', 0, 15], ['0:0', 15, 36], ['', 36, 60], ['1:0', 60, 69], ['1:1', 69, 84], ['', 84, 120],
    ])
    expect(tl[4]).toMatchObject({ words: ['go', 'watch'], on: 1 })
  })

  it('snaps to frames and clamps to the duration', () => {
    const tl = wordPopTimeline([[{ text: 'x', start: 0.51, end: 9 }]], 3)
    expect(tl[1].start).toBeCloseTo(15 / 30)
    expect(tl[tl.length - 1].end).toBe(3)
  })

  it('applies an audio-clock offset to every word (the 0.475s phone-audio bug)', () => {
    const tl = wordPopTimeline(groups, 4, { offset: 0.5 })
    expect(tl.find(s => s.text === '0:0').start).toBeCloseTo(1)
  })

  it('plays through srt.mjs concatPlaylist, blank frame shared by every gap', () => {
    const list = concatPlaylist(wordPopTimeline(groups, 4), t => (t ? `${t}.png` : 'blank.png'))
    expect(list.match(/blank\.png/g).length).toBe(4) // 3 gaps + the repeated final entry
  })
})

describe('markup', () => {
  it('escapes every caption word and marks only the active one', () => {
    expect(wordPopHtml(['<b>', 'ok'], 1)).toBe('<span class="w">&lt;b&gt;</span> <span class="w on">ok</span>')
  })

  it('turns *starred* hook words into the red italic, after escaping', () => {
    expect(hookHtml('What\'s your reaction to a *recent release?*')).toBe('What&#39;s your reaction to a <em>recent release?</em>')
    expect(hookHtml('<script>')).toBe('&lt;script&gt;')
  })

  it('instantiates reel.html modes and refuses unknown ones', () => {
    const tpl = '{{MODE}}|{{CAPTION_HTML}}|{{KICKER}}|{{HOOK_HTML}}|{{PHOTO}}'
    expect(instantiateReel(tpl, { mode: 'card', hook: '*Hi*', kicker: 'A & B', photo: 'data:x"y' }))
      .toBe('card||A &amp; B|<em>Hi</em>|data:xy')
    expect(() => instantiateReel(tpl, { mode: 'nope' })).toThrow(/unknown reel frame mode/)
  })

  it('audiogram frames take word-pop markup verbatim and switch style', () => {
    const tpl = '{{FORMAT}}|{{CAPTION}}'
    expect(instantiateTemplate(tpl, { format: '9x16', title: '', name: '', captionHtml: wordPopHtml(['a'], 0) }))
      .toBe('f-9x16 cap-wordpop|<span class="w on">a</span>')
    expect(instantiateTemplate(tpl, { format: '9x16', title: '', name: '', caption: '<i>' })).toBe('f-9x16|&lt;i&gt;')
  })
})

describe('encode args', () => {
  it('decodes audio onto the video clock (first_pts=0 pads a late audio start)', () => {
    expect(alignedAudioArgs('in.mp4', 'a.wav')).toEqual(
      ['-i', 'in.mp4', '-vn', '-af', 'aresample=async=1:first_pts=0', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', 'a.wav'])
    expect(audioOffset('0.475396', '0.000000')).toBeCloseTo(0.475396)
    expect(audioOffset(null, '0')).toBe(0)
  })

  it('joins the intro with the concat FILTER in one encode, never a stream copy', () => {
    // A -c copy join of separately encoded clips froze QuickTime on the intro.
    const a = buildVideoReelArgs({ video: 'v.mp4', audio: 'a.wav', bug: 'b.png', playlist: 'p.txt', intro: 'i.png', out: 'o.mp4' })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain('concat=n=2:v=1:a=1')
    expect(a).not.toContain('copy')
    expect(a.slice(a.indexOf('-level'), a.indexOf('-level') + 2)).toEqual(['-level', '4.2'])
    // audio comes from the aligned WAV (input 1), never the source track
    expect(graph).toContain('[1:a]')
    expect(graph).not.toContain('[0:a]')
    expect(a).toContain('+faststart')
  })

  it('without an intro the graph has no concat', () => {
    const a = buildVideoReelArgs({ video: 'v.mp4', audio: 'a.wav', bug: 'b.png', playlist: 'p.txt', out: 'o.mp4' })
    expect(a[a.indexOf('-filter_complex') + 1]).not.toContain('concat')
  })

  it('prepends the intro to an audiogram body in one re-encode', () => {
    const a = buildPrependIntroArgs({ body: 'ag.mp4', intro: 'i.png', out: 'o.mp4' })
    expect(a[a.indexOf('-filter_complex') + 1]).toContain('[intro][introa][main][a]concat=n=2:v=1:a=1')
  })

  it('asks whisper for word timestamps as JSON', () => {
    expect(whisperWordArgs('a.wav', '/t', 'small')).toEqual(['--from', 'mlx-whisper', 'mlx_whisper', 'a.wav',
      '--model', 'mlx-community/whisper-small-mlx', '--word-timestamps', 'True',
      '--output-dir', '/t', '--output-name', 'words', '--output-format', 'json'])
  })
})

describe('CLI args', () => {
  it('parses draft and render', () => {
    expect(parseReelArgs(['draft', 'a.mp4', 'b.m4a', '--model', 'medium'])).toMatchObject({ command: 'draft', files: ['a.mp4', 'b.m4a'], model: 'medium' })
    expect(parseReelArgs(['render', 'a.mp4', '--hook', 'Hi', '--cover-at', '12', '--no-normalize']))
      .toMatchObject({ hook: 'Hi', coverAt: 12, normalize: false, intro: true })
  })

  it('refuses a render with an intro but no hook, unknown flags, and no files', () => {
    expect(() => parseReelArgs(['render', 'a.mp4'])).toThrow(/--hook/)
    expect(parseReelArgs(['render', 'a.mp4', '--no-intro']).intro).toBe(false)
    expect(() => parseReelArgs(['draft', 'a.mp4', '--bogus'])).toThrow(/unknown flag/)
    expect(() => parseReelArgs(['draft'])).toThrow(/no input files/)
    expect(() => parseReelArgs(['publish', 'a.mp4'])).toThrow(/usage/)
  })

  it('make_audiogram --words is file-mode only and not combinable with --captions', () => {
    expect(parseArgs(['a.wav', '--words', 'g.json']).wordsPath).toBe('g.json')
    expect(() => parseArgs(['--prompt', 'p', '--words', 'g.json'])).toThrow(/file mode/)
    expect(() => parseArgs(['a.wav', '--words', 'g.json', '--captions', '--srt', 'x.srt'])).toThrow(/alternatives/)
  })

  it('classifies media by extension', () => {
    expect(mediaKind('x.MOV')).toBe('video')
    expect(mediaKind('x.m4a')).toBe('audio')
    expect(mediaKind('x.bin')).toBe(null)
  })
})
