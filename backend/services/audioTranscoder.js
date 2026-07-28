import ffmpeg from 'fluent-ffmpeg';
import path from 'path';

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
    
    ffmpeg(inputPath)
      .toFormat('wav')
      .audioChannels(1)          // Mono channel
      .audioFrequency(8000)      // 8kHz sampling rate (PSTN standard)
      .audioCodec('pcm_s16le')    // 16-bit signed PCM WAV
      .on('end', () => {
        console.log(`[Transcoder] Successfully transcoded file: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('[Transcoder] FFMPEG conversion failed:', err.message);
        reject(err);
      })
      .save(outputPath);
  });
}

export default transcodeCampaignAudio;
