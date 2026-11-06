/**
 * Video and sound in formats no browser plays (WMV, AVI, WMA…) are converted in the leader's browser
 * when a pack is loaded: H.264 + AAC in MP4 plays everywhere. ffmpeg.wasm (about 32 MB) is loaded
 * only for a pack that needs it, and only once.
 */
import type { FFmpeg } from "@ffmpeg/ffmpeg";

/** Formats browsers don't play, by extension: what they turn into. */
const VIDEO = new Set(["wmv", "avi", "flv", "mpg", "mpeg", "3gp", "asf", "rm", "rmvb", "vob"]);
const AUDIO = new Set(["wma", "amr", "ra"]);

export function needsConversion(path: string): "video" | "audio" | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? "";
  return VIDEO.has(ext) ? "video" : AUDIO.has(ext) ? "audio" : undefined;
}

let loading: Promise<FFmpeg> | undefined;
function ffmpeg(): Promise<FFmpeg> {
  return (loading ??= (async () => {
    const [{ FFmpeg }, core, wasm] = await Promise.all([
      import("@ffmpeg/ffmpeg"),
      import("@ffmpeg/core?url"),
      import("@ffmpeg/core/wasm?url"),
    ]);
    const ff = new FFmpeg();
    await ff.load({ coreURL: core.default, wasmURL: wasm.default });
    return ff;
  })().catch((e) => { loading = undefined; throw e; }));
}

/** One clip at most this long to convert; a broken file must not hang the pack. */
const CLIP_LIMIT_MS = 5 * 60_000;

/**
 * The clip as MP4 (or M4A for sound), or undefined if it couldn't be converted (then the original
 * stays, and players see a note instead of it).
 */
export async function toPlayable(bytes: Uint8Array, path: string, onProgress: (p: number) => void): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  const kind = needsConversion(path);
  if (!kind) return undefined;
  let ff: FFmpeg;
  try { ff = await ffmpeg(); } catch { return undefined; }
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)![1].toLowerCase();
  const input = `in.${ext}`;
  const output = kind === "video" ? "out.mp4" : "out.m4a";
  const progress = ({ progress }: { progress: number }) => { if (progress >= 0 && progress <= 1) onProgress(progress); };
  ff.on("progress", progress);
  try {
    await ff.writeFile(input, bytes);
    const args = kind === "video"
      ? [
          "-i", input,
          // Old clips are small; big ones are brought down to 854 px wide, which a quiz screen doesn't miss.
          "-vf", "scale='trunc(min(854,iw)/2)*2':-2",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k", "-ac", "2",
          "-movflags", "+faststart", output,
        ]
      : ["-i", input, "-vn", "-c:a", "aac", "-b:a", "128k", "-ac", "2", output];
    const code = await ff.exec(args, CLIP_LIMIT_MS);
    if (code !== 0) return undefined;
    const out = await ff.readFile(output);
    if (!(out instanceof Uint8Array) || out.length < 100) return undefined;
    return { bytes: out, mime: kind === "video" ? "video/mp4" : "audio/mp4" };
  } catch {
    return undefined;
  } finally {
    ff.off("progress", progress);
    for (const f of [input, output]) { try { await ff.deleteFile(f); } catch { /* not there */ } }
  }
}
