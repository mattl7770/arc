/**
 * A text's opening words, cut at a word boundary near `max` characters and
 * closed with an ellipsis — what a line shows of prose too long to print whole
 * (a knowledge entry's body on the Coach's removal card, a note on the Log
 * tab's Undo row). Whitespace is flattened so the line stays one line, and a
 * trailing comma or dash is dropped before the ellipsis.
 */
export function excerpt(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  // The cut already ends a word when the next character is a space.
  const space = flat[max] === ' ' ? max : cut.lastIndexOf(' ');
  const kept = space > max / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,.;:—-]+$/, '')}…`;
}
