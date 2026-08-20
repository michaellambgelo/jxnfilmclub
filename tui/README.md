# jxnfilm-tui

A [Textual](https://textual.textualize.io/) TUI over the JXN Film Club voice-clip
pipeline: browse the `voice:*` rounds in KV, see what's already rendered, and run
the audiogram / compile / archive jobs without remembering flag combinations.

It is an **orchestration layer**, not a reimplementation. Every job it runs is
`scripts/make_audiogram.mjs`, `scripts/compile_voices.mjs`, or `wrangler` — the
same commands documented in [`admin/README.md`](../admin/README.md).

```bash
cd tui
uv sync
uv run jxnfilm-tui              # production
uv run jxnfilm-tui staging      # staging
uv run pytest -q                # no wrangler, ffmpeg or network needed
```

## What it does

| Tab | Contents |
|-----|----------|
| **Rounds** | Every prompt round from `voice:*`, its clips in submission order (= the order a rendered segment plays), each clip's moderation status, capped runtime, **days until the audio is deleted**, and which formats are already rendered under `out/audiogram/`. |
| **KV** | Read-only browse of the whole keyspace by prefix, one value at a time. Aggregates are labelled as such. |

Keys: `r` refresh · `e` toggle production/staging · `a` actions on the selected
round · `f` render a local audio file · `o` open `out/` · `q` quit.

## Actions

`a` opens one list carrying both grains — the highlighted clip on its own, or
the whole round:

| Action | Grain | Runs |
|--------|-------|------|
| Render this clip only | clip | `make_audiogram.mjs --prompt <id> --member <memberId> --clips-only` — one R2 download, no segment |
| Render the whole round | round | `make_audiogram.mjs --prompt <id>` (format, scope = all / clips-only / segment-only, `--with-prompt`) |
| Compile segment WAV | round | `compile_voices.mjs <id>` |
| Archive source clips | round | one `wrangler r2 object get` per approved clip → `out/archive/<id>/` |
| Render from a file | — | `make_audiogram.mjs <audio-file>` — no KV, no R2 (`f`) |

The clip action only appears when the highlighted clip is **approved** — the
CLI refuses anything else, so offering it would only produce a failed run.

Every render action carries an **Overwrite existing output** tick, off by
default. Left off, a run that would replace files already in `out/` stops
before downloading or encoding anything and lists them.

The launch modal previews the exact command before it runs, built by the same
pure function the runner uses, so the preview can't drift from what executes.
Jobs stream their output live and can be cancelled.

## Deliberate limits

- **Read-only against KV and R2.** Moderation (approve/reject/delete) stays in
  the admin dashboard, which routes through the Worker's `/admin/voice`
  endpoints and their cascade logic. Two of the KV prefixes are aggregates that
  crons rebuild from canonical rows; hand-patching one has cost this project a
  signup before, so the TUI doesn't offer the gun.
- **No R2 listing.** wrangler has no `r2 object list` — buckets can only be read
  in aggregate or one key at a time. The R2 view is therefore *projected* from
  the `r2Key` on each KV row, and presence is an explicit on-demand pull rather
  than a background poll (a probe is a real download).
- **Output is append-only.** Nothing here deletes or overwrites a file in
  `out/`; conflicts stop the run and name themselves, and `--force` is an
  explicit tick rather than a default. `tests/test_settings.py` asks `git
  check-ignore` about every path the pipeline writes, so output can't reach a
  commit even if `.gitignore` is later edited.
- **R2 downloads are idempotent.** Pulled source audio is kept at
  `out/archive/<promptId>/`, so the first render of a round pays for the
  download and every later one makes no R2 request. A byte-complete file costs
  no request; transfers land via a `.part` rename so an interrupted pull leaves
  nothing truncated at the real path; a wrong-size file is re-pulled and says
  so. The 60-day promise binds the service (KV + R2), not a local export.
- **`manifest.json` merges rather than collides.** It's a derived index, so
  successive runs accumulate into one manifest and nothing is dropped. Every
  `.mp4` is still protected by the no-clobber guard.
- **Everything is one env at a time.** The env toggle rebuilds `Settings` rather
  than mutating it, which is how in-flight reads notice their answer is stale
  and drop it instead of painting production numbers over staging.

## The 60-day clock

Both voice buckets carry a lifecycle rule that deletes objects 60 days after
upload, and the KV rows carry a matching TTL. **Approval is a moderation state,
not a retention extension** — an approved clip nobody rendered still evaporates
on day 60. That is why the clip table's `left` column exists and turns yellow
inside two weeks, and why "Archive source clips" is a first-class action.

The R2 sweep is a daily cadence while the KV TTL is exact, so a metadata row can
briefly outlive its audio and vice versa. A pull that comes back missing is
reported and skipped, never fatal.

## Layout

```
src/jxnfilm_tui/
  settings.py          paths, buckets, TTL, the KV prefix catalog
  model/state.py       Clip / Round / RenderSet — pure data
  data/parsers.py      pure parsers over wrangler stdout (fixture-tested)
  data/wrangler.py     the ONLY subprocess boundary to wrangler; --remote + retry
  data/voices.py       voice:* → rounds, annotated with local renders
  data/kv.py           read-only prefix browse
  data/renders.py      scan out/audiogram/
  actions/catalog.py   the runnable actions, as data
  actions/argv.py      pure argv builders
  actions/runner.py    process + in-process jobs, streamed
  screens/ widgets/    Textual UI
```

`tests/test_settings.py` guards the constants copied from JS (buckets, the
60-day TTL, the format list, the CLI's flag names) against their sources, the
same way `tests/scripts/audiogram.test.js` guards the CLI's brand hexes against
`css/tokens.css`.
