import assert from 'node:assert/strict';
import test from 'node:test';
import { fitEventSignText } from './src/eventText.js';

test('uses a separator when the full title and time fit', () => {
  assert.equal(fitEventSignText('Lunch', '12:45 pm'), 'Lunch - 12:45 pm');
});

test('drops separator before dropping am/pm or title words', () => {
  // 'Thursday Meeting' (16) + ' - ' (3) + '12:45 pm' (8) = 27 > 25
  // 'Thursday Meeting' (16) + ' ' (1) + '12:45 pm' (8) = 25 <= 25
  assert.equal(fitEventSignText('Thursday Meeting', '12:45 pm'), 'Thursday Meeting 12:45 pm');
});

test('drops am/pm to preserve more complete title words', () => {
  assert.equal(fitEventSignText('Architecture Review', '12:00 pm'), 'Architecture Review 12:00');
  assert.equal(fitEventSignText('Fall Thursday Lunch', '12:45 pm'), 'Fall Thursday Lunch 12:45');
});

test('accounts for slashes as word boundaries in title (e.g. Board Review/Planning)', () => {
  assert.equal(fitEventSignText('Board Review/Planning', '12:00 pm'), 'Board Review - 12:00 pm');
  assert.equal(fitEventSignText('Board/Review/Planning', '12:00 pm'), 'Board/Review - 12:00 pm');
  assert.equal(fitEventSignText('Board Review / Planning', '12:00 pm'), 'Board Review - 12:00 pm');
  assert.equal(fitEventSignText('Board Review/Planning - Fullstack', '12:00 pm'), 'Board Review - 12:00 pm');
});

test('never clips a long first word or the am/pm suffix', () => {
  assert.equal(fitEventSignText('ExtraordinarilyLongMeetingName', '12:45 pm'), '12:45 pm');
});
