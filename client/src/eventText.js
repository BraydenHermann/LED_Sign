export function fitEventSignText(summary, endTime, maxLength = 25) {
  const title = String(summary || '').replace(/\s+/g, ' ').trim();
  const time = String(endTime || '').trim();
  if (!time) return title.slice(0, maxLength);
  if (!title) return time.slice(0, maxLength);

  // Keep the separator only when the complete title and time both fit.
  if (`${title} - ${time}`.length <= maxLength) return `${title} - ${time}`;
  if (`${title} ${time}`.length <= maxLength) return `${title} ${time}`;

  const titleBudget = maxLength - time.length - 1;
  let wholeWords = '';
  for (const word of title.split(' ')) {
    const candidate = wholeWords ? `${wholeWords} ${word}` : word;
    if (candidate.length > titleBudget) break;
    wholeWords = candidate;
  }

  // A partial first word is less useful than the readable end time.
  return wholeWords ? `${wholeWords} ${time}` : time.slice(0, maxLength);
}
