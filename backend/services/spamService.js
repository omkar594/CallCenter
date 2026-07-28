import axios from 'axios';

// Cache list of local spam numbers
const localSpamBlacklist = new Set([
  '+919999999999',
  '+918888888888',
  '+917777777777',
  '1400123456' // Typical telemarketer code prefix
]);

/**
 * Service to identify incoming spam/bot calls.
 */
class SpamService {
  /**
   * Verify if caller is verified spam/bot
   * @param {string} callerNumber - Customer number (CLI)
   * @returns {Promise<boolean>} true if number is spam
   */
  async checkIsSpam(callerNumber) {
    const formattedNumber = callerNumber.replace(/[\s\-()]/g, '');
    
    // 1. Check local blacklisted numbers
    if (localSpamBlacklist.has(formattedNumber)) {
      console.log(`[SpamCheck] Number ${callerNumber} flagged by Local Blacklist`);
      return true;
    }

    // 2. Prefix spam checks (e.g. telemarketing prefix codes)
    if (formattedNumber.startsWith('+91140') || formattedNumber.startsWith('140')) {
      console.log(`[SpamCheck] Number ${callerNumber} matches telemarketing prefix`);
      return true;
    }

    // 3. Mock Truecaller / Spam API lookup
    try {
      // In production: const response = await axios.get(`https://api.truecaller.com/v1/search?phone=${formattedNumber}`, { headers: { ... } });
      // We will perform a simulated request
      const isMockSpam = Math.random() > 0.95; // 5% chance of mock spam detection
      if (isMockSpam) {
        console.log(`[SpamCheck] Number ${callerNumber} flagged as Spam by Truecaller API Simulator`);
        return true;
      }
    } catch (err) {
      console.error('[SpamCheck] External lookup failed, defaulting to safe bypass:', err.message);
    }

    return false;
  }
}

const spamService = new SpamService();
export default spamService;
