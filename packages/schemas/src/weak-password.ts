// Weak-password rejection (inbox/review.md P2-4: "block breached passwords,
// welcome password managers"). Fully self-contained — no external API — so it
// runs in register/change-password without an outbound dependency. The 12-char
// minimum already blocks the classic short passwords; this targets the 12+ char
// weak patterns the length rule misses (repeats, sequences, common phrases).

// Common 12+ char weak passwords / base phrases (lowercased). Kept small and
// curated; the pattern checks below cover the mechanical cases.
const COMMON = new Set([
  "password1234",
  "passwordpassword",
  "123456789012",
  "1234567890123",
  "qwertyuiop12",
  "qwertyuiop123",
  "qwerty123456",
  "iloveyou1234",
  "adminadmin12",
  "letmein12345",
  "welcome12345",
  "abc123abc123",
  "1q2w3e4r5t6y",
  "changeme1234",
  "trustno12345",
]);

const isRepeatedChar = (s: string) => /^(.)\1+$/.test(s);

// A monotonic run of digits like "123456789012" or "987654321098".
function isDigitSequence(s: string): boolean {
  if (!/^\d+$/.test(s)) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1) up = false;
    if (d !== -1) down = false;
  }
  return up || down;
}

/** True if the password is trivially weak despite meeting the length minimum. */
export function isWeakPassword(password: string): boolean {
  const p = password.trim().toLowerCase();
  if (COMMON.has(p)) return true;
  if (isRepeatedChar(p)) return true;
  if (isDigitSequence(p)) return true;
  return false;
}
