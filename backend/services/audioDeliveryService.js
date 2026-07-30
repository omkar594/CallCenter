import fs from 'fs';
import path from 'path';
import SftpClient from 'ssh2-sftp-client';

const SSH_HOST = process.env.ASTERISK_SSH_HOST;
const SSH_PORT = parseInt(process.env.ASTERISK_SSH_PORT) || 22;
const SSH_USER = process.env.ASTERISK_SSH_USER;
const SSH_KEY_PATH = process.env.ASTERISK_SSH_PRIVATE_KEY_PATH;
// This path is interpreted from the SFTP user's own root, NOT the Asterisk host's root -
// the deploy runbook sets up ASTERISK_SSH_USER as an SFTP-only account chrooted to
// /var/lib/asterisk/sounds, so "/campaign_audio" here really means
// /var/lib/asterisk/sounds/campaign_audio on disk. If you ever point this at a
// non-chrooted user instead, set the full host path here.
const REMOTE_SOUNDS_DIR = process.env.ASTERISK_SOUNDS_DIR || '/campaign_audio';

/**
 * Pushes a transcoded campaign prompt to the Asterisk box's custom sounds directory
 * over SFTP, so Playback() in the dialplan can find it by filename.
 *
 * Requires ASTERISK_SSH_HOST/USER/PRIVATE_KEY_PATH to be configured. Throws if delivery
 * fails - callers should treat that as campaign-creation failure, since a campaign whose
 * audio never reaches Asterisk will silently dial into dead air.
 *
 * @param {string} localWavPath - Absolute path to the transcoded WAV on this host.
 * @returns {Promise<string>} the remote filename (no path, no extension) to use in Playback().
 */
export async function deliverCampaignAudio(localWavPath) {
  if (!SSH_HOST || !SSH_USER || !SSH_KEY_PATH) {
    throw new Error(
      'Audio delivery is not configured. Set ASTERISK_SSH_HOST, ASTERISK_SSH_USER and ' +
      'ASTERISK_SSH_PRIVATE_KEY_PATH so transcoded prompts can be pushed to the Asterisk box.'
    );
  }
  if (!fs.existsSync(SSH_KEY_PATH)) {
    throw new Error(`ASTERISK_SSH_PRIVATE_KEY_PATH does not exist on disk: ${SSH_KEY_PATH}`);
  }

  const filename = path.basename(localWavPath);
  const remotePath = `${REMOTE_SOUNDS_DIR}/${filename}`;
  const sftp = new SftpClient();

  try {
    await sftp.connect({
      host: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      privateKey: fs.readFileSync(SSH_KEY_PATH),
      readyTimeout: 15000
    });

    const dirExists = await sftp.exists(REMOTE_SOUNDS_DIR);
    if (!dirExists) {
      await sftp.mkdir(REMOTE_SOUNDS_DIR, true);
    }

    await sftp.put(localWavPath, remotePath);
    console.log(`[AudioDelivery] Pushed ${filename} to ${SSH_HOST}:${remotePath}`);
  } finally {
    await sftp.end().catch(() => {});
  }

  // Playback() takes the sound file basename without extension.
  return filename.replace(/\.[^/.]+$/, '');
}

export default deliverCampaignAudio;
