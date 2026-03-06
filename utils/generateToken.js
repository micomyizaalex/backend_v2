const crypto = require('crypto');

/**
 * Generate a cryptographically-secure random token string.
 * @param {number} bytes - Number of random bytes (default 32 → 64 hex chars)
 * @returns {string} Hex-encoded token
 */
const generateSecureToken = (bytes = 32) => {
  return crypto.randomBytes(bytes).toString('hex');
};

module.exports = { generateSecureToken };
