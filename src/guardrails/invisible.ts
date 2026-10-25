/**
 * Control characters except tab and newline, plus zero-width and Unicode tag characters that
 * can hide instructions from a human reviewer.
 */
export const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
