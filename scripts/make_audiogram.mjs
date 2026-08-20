#!/usr/bin/env node
// Render branded audiogram MP4s — animated waveform + Night Shift branding —
// from podcast voice clips, so audio can travel with the club's visual
// identity (video-podcast import, IG/story promos).
//
//   node scripts/make_audiogram.mjs <audio-file> [--format 16x9|1x1|9x16|all]
//        [--title T] [--name N] [--out DIR]
//   node scripts/make_audiogram.mjs --prompt <promptId> [--env production|staging]
//        [--format ...] [--member ID] [--segment-only|--clips-only] [--out DIR]
//
// Pipeline (node + wrangler + ffmpeg + the repo's existing Playwright):
//   1. Audio: either the given file, or the APPROVED clips for a prompt —
//      every one of them, or just those named by --member (same KV/R2 fetch +
//      two-pass loudnorm as compile_voices.mjs, via scripts/lib/voices.mjs).
//      Filtering happens BEFORE the R2 pulls, so narrowing to one member
//      downloads one object, not the whole round.
//   2. Frame: scripts/assets/audiogram.html instantiated per clip/format and
//      screenshotted by headless Chromium with a transparent wave window —
//      the template links the real css/tokens.css + self-hosted fonts, served
//      by an ephemeral local http server (fonts use absolute /fonts URLs).
//      NOTE: Homebrew's ffmpeg has no drawtext (formula dropped freetype), so
//      the browser is the text renderer; ffmpeg never draws type.
//   3. ffmpeg: showfreqs waveform (grey + brand-red band) upscaled into the
//      wave window, branded PNG composited on top, H.264/AAC + faststart.
//
// Prompt mode writes out/audiogram/<promptId>/{<memberId>-<fmt>.mp4,
// segment-<fmt>.mp4, manifest.json}. Clips age out 60 days after submission
// (R2 lifecycle) — a missing object is skipped with a warning, not fatal.
//
// Output is append-only: existing files are never overwritten or deleted, and
// a run that would collide stops BEFORE it downloads or encodes anything.
// --force is the sole override.
//
// Pulled source audio is KEPT at out/archive/<promptId>/ (--no-keep-audio opts
// out), so re-rendering a round makes no R2 requests at all. The 60-day
// retention promise binds the SERVICE — KV rows and R2 objects — not an
// operator's local export; once the audio is exported to this machine it is
// out of that policy's scope. Pulls land via a .part rename, so repeating a
// run, or resuming an interrupted one, costs nothing and corrupts nothing.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  archivePathFor, BUCKETS, concatWithGaps, ensureWritable, ffmpeg, fmtDur,
  listApprovedClips, normalizeClip, pullClip, run,
} from './lib/voices.mjs'
import {
  buildRenderArgs, FORMATS, instantiateTemplate, mergeManifest, parseArgs,
  plannedRenderPaths, safeName, selectClips,
} from './lib/audiogram.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_PATH = join(REPO_ROOT, 'scripts', 'assets', 'audiogram.html')

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

let tmp = null
process.on('exit', () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// --- ephemeral asset server ---------------------------------------------
// tokens.css references /fonts/… with absolute URLs, so file:// pages load no
// fonts. Serve /css and /fonts from the repo plus the instantiated frame HTML
// from memory; nothing ever binds beyond 127.0.0.1.

const MIME = {
  '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.html': 'text/html',
}

function startServer(frames) {
  return new Promise((resolveStart, rejectStart) => {
    const srv = createServer(async (req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      if (path.startsWith('/frame/')) {
        const html = frames.get(path.slice('/frame/'.length))
        if (html === undefined) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(html)
        return
      }
      const file = resolve(REPO_ROOT, path.slice(1))
      const allowed = file.startsWith(join(REPO_ROOT, 'css')) || file.startsWith(join(REPO_ROOT, 'fonts'))
      if (!allowed) { res.writeHead(404); res.end(); return }
      try {
        const data = await readFile(file)
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end()
      }
    })
    srv.on('error', rejectStart)
    srv.listen(0, '127.0.0.1', () => resolveStart(srv))
  })
}

// --- frame rendering -----------------------------------------------------

async function launchChromium() {
  try {
    const { chromium } = await import('playwright')
    return await chromium.launch()
  } catch (err) {
    fail(`could not launch headless Chromium (needed to render the branded frame): ${err.message}\n` +
      'If the browser binaries are missing, install them with: npx playwright install chromium')
  }
}

// Screenshot one instantiated frame. The template body is transparent except
// the panels/grill, so the PNG composites on top of the waveform.
async function screenshotFrame(page, port, frames, { format, title, name }, pngPath) {
  const key = `${frames.size}-${format}.html`
  frames.set(key, instantiateTemplate(TEMPLATE, { format, title, name }))
  const { width, height } = FORMATS[format]
  await page.setViewportSize({ width, height })
  await page.goto(`http://127.0.0.1:${port}/frame/${key}`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: pngPath, omitBackground: true })
}

// --- main ----------------------------------------------------------------

let args
try { args = parseArgs(process.argv.slice(2)) } catch (err) { fail(err.message) }
if (!BUCKETS[args.envName]) fail(`--env must be production or staging (got: ${args.envName})`)

const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8')

try {
  // Preflight ffmpeg before any slow wrangler/Chromium work.
  run('ffmpeg', ['-version'])
} catch (err) { fail(err.message) }

const browser = await launchChromium()
const frames = new Map()
const server = await startServer(frames)
const port = server.address().port
const page = await browser.newPage()

async function shutdown() {
  await browser.close().catch(() => {})
  server.close()
}

try {
  tmp = mkdtempSync(join(tmpdir(), 'jxnfc-audiogram-'))
  const written = []

  // Render one audio+text job across all requested formats.
  async function renderJob({ audioPath, title, name, outDir, stem }) {
    mkdirSync(outDir, { recursive: true })
    const files = {}
    for (const format of args.formats) {
      const png = join(tmp, `frame-${safeName(stem)}-${format}.png`)
      await screenshotFrame(page, port, frames, { format, title, name }, png)
      const outPath = join(outDir, `${stem}-${format}.mp4`)
      console.log(`Rendering ${outPath}…`)
      ffmpeg(buildRenderArgs({ format, audioPath, framePath: png, outPath }))
      files[format] = outPath
      written.push(outPath)
    }
    return files
  }

  if (!args.promptId) {
    // --- file mode ---
    const stem = safeName(basename(args.audioPath).replace(/\.[^.]+$/, ''))
    const fileOutDir = join(args.outDir, 'audiogram')
    ensureWritable(plannedRenderPaths(fileOutDir, [stem], args.formats), { force: args.force })

    const norm = join(tmp, 'norm.wav')
    console.log(`Normalizing ${args.audioPath}…`)
    normalizeClip(args.audioPath, norm, args.audioPath)
    await renderJob({
      audioPath: norm,
      title: args.title,
      name: args.name || 'JXN Film Club',
      outDir: fileOutDir,
      stem,
    })
  } else {
    // --- prompt mode ---
    const { clips: approved } = listApprovedClips(args.promptId, args.envName)
    if (!approved.length) throw new Error(`no APPROVED clips for prompt "${args.promptId}" on ${args.envName} — approve some in the admin Voice tab first`)

    // Narrow BEFORE pulling: --member should cost one download, not the round.
    let clips = approved
    if (args.members.length) {
      const { selected, missing } = selectClips(approved, args.members)
      if (missing.length) {
        throw new Error(`no approved clip for ${missing.join(', ')} in "${args.promptId}" — approved: ${approved.map(c => c.memberId).join(', ')}`)
      }
      clips = selected
      console.log(`Limited to ${clips.length} of ${approved.length} approved clip(s): ${clips.map(c => c.name || c.memberId).join(', ')}`)
    }

    const outDir = join(args.outDir, 'audiogram', safeName(args.promptId))
    const promptText = clips[0].promptText || args.promptId

    // Refuse collisions BEFORE any download or encode — a run that can't
    // finish cleanly shouldn't spend ten minutes of ffmpeg finding out.
    // Planned from the selected clips, so a clip that later turns out to have
    // aged out is counted conservatively rather than missed. manifest.json is
    // deliberately NOT in this list: it's a derived index that merges (see
    // mergeManifest), so it can't collide and can't lose anything either.
    const plannedStems = [
      ...(args.segmentOnly ? [] : clips.map(c => c.memberId || c.key)),
      ...(args.clipsOnly ? [] : ['segment']),
    ]
    ensureWritable(plannedRenderPaths(outDir, plannedStems, args.formats), { force: args.force })

    // Pull + normalize, skipping clips whose R2 object already aged out (the
    // 60-day lifecycle sweeps daily; a miss is an expected state, not an error).
    clips.forEach((c, i) => {
      const ext = ((c.r2Key.split('.').pop() || '').replace(/[^a-z0-9]/gi, '')) || 'bin'
      // Default: pull straight into the archive, so the download is paid for
      // once per round ever. --no-keep-audio pulls to the temp dir instead but
      // still reuses an archive if one is already there.
      const archived = archivePathFor(args.outDir, args.promptId, c)
      c.raw = args.keepAudio ? archived : join(tmp, `raw-${i}.${ext}`)
      c.norm = join(tmp, `norm-${i}.wav`)
      try {
        pullClip(c, args.envName, c.raw, args.keepAudio ? {} : { reuseFrom: archived })
        c.probedSec = normalizeClip(c.raw, c.norm, c.key)
      } catch (err) {
        console.warn(`  SKIPPING ${c.key} (${c.name || c.memberId}): ${err.message.split('\n')[0]} — likely expired (60-day lifecycle)`)
        c.skipped = err.message.split('\n')[0]
      }
    })
    const live = clips.filter(c => !c.skipped)
    if (!live.length) throw new Error(`every clip for prompt "${args.promptId}" failed to pull — all expired?`)

    if (!args.segmentOnly) {
      for (const c of live) {
        c.files = await renderJob({
          audioPath: c.norm,
          title: args.withPrompt ? (c.promptText || promptText) : '',
          name: c.name || 'A JXN Film Club member',
          outDir,
          stem: safeName(c.memberId || c.key),
        })
      }
    }

    let segment = null
    if (!args.clipsOnly) {
      const segWav = join(tmp, 'segment.wav')
      console.log('Concatenating segment…')
      concatWithGaps(live.map(c => c.norm), segWav, tmp)
      segment = {
        files: await renderJob({
          audioPath: segWav,
          title: args.withPrompt ? promptText : '',
          name: `${live.length} member${live.length === 1 ? '' : 's'} · JXN Film Club`,
          outDir,
          stem: 'segment',
        }),
      }
    }

    // --- manifest: machine-readable counterpart of compile_voices' table ---
    const manifest = {
      promptId: args.promptId,
      env: args.envName,
      generatedAt: new Date().toISOString(),
      formats: args.formats,
      ...(args.members.length
        ? { members: args.members, approvedTotal: approved.length }
        : {}),
      clips: clips.map((c, i) => ({
        order: i + 1,
        key: c.key,
        memberId: c.memberId,
        name: c.name || null,
        // Submission order is what a merged manifest re-sorts on.
        at: c.at || null,
        seconds: c.skipped ? null : Math.min(180, c.probedSec ?? (Number(c.duration) || 0)),
        ...(c.skipped ? { skipped: c.skipped } : { files: c.files || null }),
      })),
      segment,
    }
    // A narrowed run describes a subset, so it must not clobber the round's
    // real manifest — that would make a full round look like it shrank.
    const manifestPath = join(outDir, 'manifest.json')
    mkdirSync(outDir, { recursive: true })
    let previous = null
    if (existsSync(manifestPath)) {
      try {
        previous = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        // Refuse rather than silently replacing something we can't read and
        // therefore can't preserve.
        throw new Error(`${manifestPath} exists but is not valid JSON — move it aside; refusing to replace a file whose contents can't be merged`)
      }
    }
    writeFileSync(manifestPath, JSON.stringify(mergeManifest(previous, manifest), null, 2) + '\n')
    written.push(manifestPath)

    console.log('\nManifest (segment order):')
    clips.forEach((c, i) => {
      const label = c.name || c.memberId
      if (c.skipped) console.log(`  ${i + 1}. ${label} — SKIPPED (${c.skipped})`)
      else console.log(`  ${i + 1}. ${label} — ${fmtDur(Math.min(180, c.probedSec ?? 0))}  (${c.key})`)
    })
    console.log('\nReminder: source clips auto-delete 60 days after submission (R2 lifecycle).')
  }

  console.log('\nWrote:')
  written.forEach(f => console.log(`  ${f}`))
} catch (err) {
  await shutdown()
  fail(err.message)
} finally {
  await shutdown()
}
