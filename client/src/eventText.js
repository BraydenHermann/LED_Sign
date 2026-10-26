export function fitEventSignText(summary, endTime, maxLength = 25) {
  const title = String(summary || '').replace(/\s+/g, ' ').trim();
  const time = String(endTime || '').trim();
  if (!time) return title.slice(0, maxLength);
  if (!title) return time.slice(0, maxLength);

  const ampmMatch = time.match(/\s*([ap]\.?m\.?)$/i);
  const ampm = ampmMatch ? ampmMatch[1].toLowerCase().replace(/\./g, '') : '';
  const timeDigits = time.replace(/\s*[ap]\.?m\.?$/i, '').trim();
  const timeWithAmPm = ampm ? `${timeDigits} ${ampm}` : timeDigits;
  const timeWithoutAmPm = timeDigits;

  const wordMatches = [...title.matchAll(/[^\s/]+/g)];
  const candidatePrefixes = [];
  for (let i = 0; i < wordMatches.length; i++) {
    const match = wordMatches[i];
    const prefix = title.slice(0, match.index + match[0].length).replace(/[\s\/\-,;:]+$/, '');
    if (prefix && !candidatePrefixes.includes(prefix)) {
      candidatePrefixes.push(prefix);
    }
  }

  // Prioritize in strict order:
  // 1. Full words in event title (iterate from most words down to 1)
  // 2. End TIME (timeDigits always included)
  // 3. am/pm labels (timeWithAmPm preferred over timeWithoutAmPm)
  // 4. - separators (' - ' preferred over ' ')
  for (let i = candidatePrefixes.length - 1; i >= 0; i--) {
    const p = candidatePrefixes[i];
    if (ampm) {
      if (`${p} - ${timeWithAmPm}`.length <= maxLength) return `${p} - ${timeWithAmPm}`;
      if (`${p} ${timeWithAmPm}`.length <= maxLength) return `${p} ${timeWithAmPm}`;
    } else {
      if (`${p} - ${timeDigits}`.length <= maxLength) return `${p} - ${timeDigits}`;
      if (`${p} ${timeDigits}`.length <= maxLength) return `${p} ${timeDigits}`;
    }
    // Drop am/pm to keep more title words
    if (ampm && `${p} ${timeWithoutAmPm}`.length <= maxLength) {
      return `${p} ${timeWithoutAmPm}`;
    }
  }

  return timeWithAmPm.length <= maxLength ? timeWithAmPm : timeWithAmPm.slice(0, maxLength);
}
