import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';

// Render's plain Node runtime has no system ffmpeg binary; @ffmpeg-installer/ffmpeg
// bundles a static binary via npm so this works without a Dockerfile.
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const TRANSCODE_TIMEOUT_MS = 30000;

/**
 * Transcodes any input audio file to WAV, 8000Hz, 16-bit, Mono (PCM/alaw/ulaw compatible format).
 * Prevents Asterisk server transcoding overhead.
 *
 * @param {string} inputPath - Absolute path to the source audio file.
 * @param {string} outputPath - Absolute path where the transcoded WAV file will be saved.
 * @returns {Promise<string>} outputPath of the transcoded audio.
 */
export function transcodeCampaignAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`[Transcoder] Starting transcode: ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);

    const command = ffmpeg(inputPath)
      .toFormat('wav')
      .audioChannels(1)          // Mono channel
      .audioFrequency(8000)      // 8kHz sampling rate (PSTN standard)
      .audioCodec('pcm_s16le');   // 16-bit signed PCM WAV

    const timer = setTimeout(() => {
      command.kill('SIGKILL');
      reject(new Error(`Transcode timed out after ${TRANSCODE_TIMEOUT_MS}ms`));
    }, TRANSCODE_TIMEOUT_MS);

    command
      .on('end', () => {
        clearTimeout(timer);
        console.log(`[Transcoder] Successfully transcoded file: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        clearTimeout(timer);
        console.error('[Transcoder] FFMPEG conversion failed:', err.message);
        reject(err);
      })
      .save(outputPath);
  });
}

export default transcodeCampaignAudio;
