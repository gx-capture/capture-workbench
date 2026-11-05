export function newDocumentId(before: readonly string[], matchingAfter: readonly string[]): string | undefined {
  const previous = new Set(before);
  const added = [...new Set(matchingAfter.filter((id) => id && !previous.has(id)))];
  if (added.length > 1) throw new Error('Import produced multiple new matching document cards.');
  return added[0];
}
