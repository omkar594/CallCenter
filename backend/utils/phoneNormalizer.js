// India-only normalization, matching the SIMs this gateway currently carries. A genuine
// 12-digit non-Indian number that happens to start with "91" will be mis-stripped - extend
// this (or bring in a real phone-number library) before dialing outside India.
//
// Shared by bulkCampaignWorker.js (outbound dial target), campaignController.js (DNC filtering
// at upload time), and the opt-out webhook (DNC insert at DTMF-9 time) - all three MUST use the
// exact same normalization, or an opted-out number can quietly re-enter a future campaign just
// because it was formatted differently in that CSV.
export function normalizePhoneNumber(rawNumber) {
  const raw = String(rawNumber).trim();
  let digits = raw.replace(/[^0-9]/g, '');
  if (raw.startsWith('+91') && digits.length === 12) {
    digits = digits.substring(2);
  } else if (digits.startsWith('91') && digits.length === 12) {
    digits = digits.substring(2);
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.substring(1);
  }
  return digits;
}

export default normalizePhoneNumber;
