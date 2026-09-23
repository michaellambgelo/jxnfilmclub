// Whisper invocation shared by the laptop CLI (scripts/transcribe.mjs) and
// node0's always-on drafter (scripts/transcribe_service.mjs), so both produce
// the same draft from the same clip.
//
// Only the ARGUMENTS live here, not the process handling: the CLI runs whisper
// synchronously with its progress streamed to the terminal, while the service
// must never block its event loop (a hook arriving mid-transcription has to be
// accepted at once, or the Worker's waitUntil times out waiting for it).
//
// whisper runs via `uvx --from mlx-whisper`, so the model stays out of this
// repo's dependencies. Cue timing comes from whisper's SEGMENTS, never its
// words — see scripts/lib/srt.mjs.

export const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']
export const DEFAULT_MODEL = 'small'

// Decode to what whisper actually wants — 16 kHz mono — rather than handing it
// an Opus/WebM container and hoping. Deliberately the RAW audio, not the
// loudnorm'd render input: normalization buys nothing for recognition.
// (Without the -hide_banner/-nostdin/-y prefix that voices.mjs's ffmpeg()
// adds; callers that spawn ffmpeg directly add it themselves.)
export function wavArgs(src, dest) {
  return ['-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest]
}

// uvx argv that writes <outDir>/raw.srt.
export function whisperArgs(wavPath, outDir, model = DEFAULT_MODEL) {
  if (!MODELS.includes(model)) throw new Error(`unknown whisper model: ${model}`)
  return ['--from', 'mlx-whisper', 'mlx_whisper', wavPath,
    '--model', `mlx-community/whisper-${model}-mlx`,
    '--output-dir', outDir, '--output-name', 'raw', '--output-format', 'srt']
}

export const RAW_SRT = 'raw.srt'
