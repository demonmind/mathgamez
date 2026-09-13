const { customAlphabet } = require('nanoid');

// Excludes ambiguous characters (0/O, 1/I) so codes are easy to read aloud
// and type on a tablet.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generate = customAlphabet(ALPHABET, 6);

async function createFamilyWithUniqueCode(pool) {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generate();
    try {
      const result = await pool.query(
        'INSERT INTO families (family_code) VALUES ($1) RETURNING id, family_code, created_at',
        [code]
      );
      return result.rows[0];
    } catch (err) {
      if (err.code === '23505') continue; // unique_violation, retry with a new code
      throw err;
    }
  }
  throw new Error('Could not generate a unique family code, please try again');
}

function isValidFamilyCodeFormat(code) {
  return typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code);
}

module.exports = { createFamilyWithUniqueCode, isValidFamilyCodeFormat };
