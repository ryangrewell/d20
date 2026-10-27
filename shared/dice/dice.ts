/**
 * Dice notation parser and roller.
 *
 * Supported: sums of terms separated by + / -, where a term is a constant or
 * `NdS` with optional keep/drop modifiers: `kh`, `kl`, `dh`, `dl` (e.g. 4d6kh3).
 * `d20` == `1d20`, `d%` == `d100`. Limits guard against abusive expressions.
 */
export const DICE_LIMITS = { maxTerms: 20, maxDicePerTerm: 100, maxTotalDice: 200, maxSides: 1000, maxConstant: 100000, maxLength: 120 };

export type DiceTerm =
  | { kind: 'const'; sign: 1 | -1; value: number }
  | { kind: 'dice'; sign: 1 | -1; count: number; sides: number; keep?: { mode: 'kh' | 'kl' | 'dh' | 'dl'; n: number } };

export type ParsedDice = { expression: string; terms: DiceTerm[] };

export type RolledTerm =
  | { kind: 'const'; sign: 1 | -1; value: number }
  | { kind: 'dice'; sign: 1 | -1; count: number; sides: number; keep?: { mode: 'kh' | 'kl' | 'dh' | 'dl'; n: number }; faces: number[]; kept: boolean[]; subtotal: number };

export type DiceResult = { expression: string; terms: RolledTerm[]; total: number };

export class DiceError extends Error {}

const TERM_RE = /^(\d*)d(\d+|%)(?:(kh|kl|dh|dl)(\d+))?$/;

export function parseDice(input: string): ParsedDice {
  const expression = input.replace(/\s+/g, '').toLowerCase();
  if (!expression) throw new DiceError('Enter a dice expression such as 1d20+5.');
  if (expression.length > DICE_LIMITS.maxLength) throw new DiceError('That dice expression is too long.');
  if (!/^[0-9d%+\-khl]+$/.test(expression)) throw new DiceError('Only dice notation like 2d6+3 or 4d6kh3 is supported.');

  const parts = expression.match(/[+-]?[^+-]+/g);
  if (!parts || parts.join('') !== expression) throw new DiceError('Could not read that dice expression.');
  if (parts.length > DICE_LIMITS.maxTerms) throw new DiceError(`Use at most ${DICE_LIMITS.maxTerms} terms.`);

  let totalDice = 0;
  const terms: DiceTerm[] = parts.map((raw) => {
    const sign: 1 | -1 = raw.startsWith('-') ? -1 : 1;
    const body = raw.replace(/^[+-]/, '');
    if (/^\d+$/.test(body)) {
      const value = Number(body);
      if (value > DICE_LIMITS.maxConstant) throw new DiceError('That modifier is too large.');
      return { kind: 'const', sign, value };
    }
    const m = TERM_RE.exec(body);
    if (!m) throw new DiceError(`"${body}" is not valid dice notation.`);
    const count = m[1] ? Number(m[1]) : 1;
    const sides = m[2] === '%' ? 100 : Number(m[2]);
    if (count < 1) throw new DiceError('Roll at least one die.');
    if (count > DICE_LIMITS.maxDicePerTerm) throw new DiceError(`Roll at most ${DICE_LIMITS.maxDicePerTerm} dice at once.`);
    if (sides < 2 || sides > DICE_LIMITS.maxSides) throw new DiceError(`Dice must have between 2 and ${DICE_LIMITS.maxSides} sides.`);
    totalDice += count;
    const term: DiceTerm = { kind: 'dice', sign, count, sides };
    if (m[3]) {
      const n = Number(m[4]);
      if (n < 1 || n > count) throw new DiceError(`Keep/drop count must be between 1 and ${count}.`);
      term.keep = { mode: m[3] as 'kh' | 'kl' | 'dh' | 'dl', n };
    }
    return term;
  });
  if (totalDice > DICE_LIMITS.maxTotalDice) throw new DiceError(`Roll at most ${DICE_LIMITS.maxTotalDice} dice in total.`);
  if (!terms.some((t) => t.kind === 'dice')) throw new DiceError('Include at least one die, e.g. 1d20.');
  return { expression, terms };
}

/** `randomInt(n)` must return a uniformly distributed integer in [0, n). */
export function rollDice(parsed: ParsedDice, randomInt: (n: number) => number): DiceResult {
  let total = 0;
  const terms: RolledTerm[] = parsed.terms.map((t) => {
    if (t.kind === 'const') {
      total += t.sign * t.value;
      return t;
    }
    const faces = Array.from({ length: t.count }, () => randomInt(t.sides) + 1);
    const kept = keepMask(faces, t.keep);
    const subtotal = faces.reduce((s, f, i) => (kept[i] ? s + f : s), 0);
    total += t.sign * subtotal;
    return { ...t, faces, kept, subtotal };
  });
  return { expression: parsed.expression, terms, total };
}

function keepMask(faces: number[], keep?: { mode: 'kh' | 'kl' | 'dh' | 'dl'; n: number }): boolean[] {
  if (!keep) return faces.map(() => true);
  const order = faces.map((f, i) => ({ f, i })).sort((a, b) => a.f - b.f || a.i - b.i);
  const n = keep.n;
  const keepIdx = new Set<number>();
  const len = order.length;
  const pick = (from: number, to: number) => order.slice(from, to).forEach((o) => keepIdx.add(o.i));
  if (keep.mode === 'kh') pick(len - n, len);
  if (keep.mode === 'kl') pick(0, n);
  if (keep.mode === 'dh') pick(0, len - n);
  if (keep.mode === 'dl') pick(n, len);
  return faces.map((_, i) => keepIdx.has(i));
}

export function describeRoll(r: DiceResult): string {
  return r.terms
    .map((t, idx) => {
      const sign = t.sign < 0 ? '- ' : idx > 0 ? '+ ' : '';
      if (t.kind === 'const') return `${sign}${t.value}`;
      const faces = t.faces.map((f, i) => (t.kept[i] ? `${f}` : `~~${f}~~`)).join(', ');
      return `${sign}[${faces}]`;
    })
    .join(' ');
}
