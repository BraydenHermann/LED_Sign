import assert from 'node:assert/strict';
import test from 'node:test';
import { fitEventSignText } from './src/eventText.js';

test('keeps whole title words and am/pm before a separator', () => {
  assert.equal(fitEventSignText('Fall Thursday Lunch', '12:45 pm'), 'Fall Thursday 12:45 pm');
});

test('uses a separator when the full title and time fit', () => {
  assert.equal(fitEventSignText('Lunch', '12:45 pm'), 'Lunch - 12:45 pm');
});

test('drops separator before dropping a complete title word', () => {
  assert.equal(fitEventSignText('Thursday Lunch Event', '12:45 pm'), 'Thursday Lunch 12:45 pm');
});

test('never clips a long first word or the am/pm suffix', () => {
  assert.equal(fitEventSignText('ExtraordinarilyLongMeetingName', '12:45 pm'), '12:45 pm');
});
