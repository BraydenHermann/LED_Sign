import unittest
import os
import sys

# Setup for testing
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from calendar_service import clean_event_summary

class TestCalendarName(unittest.TestCase):
    def test_enabling_removes_dynamic_name(self):
        self.assertEqual(clean_event_summary("John and Jane Doe", "Jane Doe"), "John")
        self.assertEqual(clean_event_summary("Jane Doe and John", "Jane Doe"), "John")

    def test_disabling_preserves_original(self):
        # Disabling passes None as user_name
        self.assertEqual(clean_event_summary("John and Jane Doe", None), "John and Jane Doe")

    def test_works_with_non_calendly(self):
        self.assertEqual(clean_event_summary("Random Sync - Jane Doe", "Jane Doe"), "Random Sync")
        self.assertEqual(clean_event_summary("Jane Doe / Alice", "Jane Doe"), "Alice")

    def test_works_with_different_account_names(self):
        self.assertEqual(clean_event_summary("Alice & Bob Smith", "Bob Smith"), "Alice")
        self.assertEqual(clean_event_summary("Bob Smith - Sync", "Bob Smith"), "Sync")

    def test_missing_identity_leaves_unchanged(self):
        self.assertEqual(clean_event_summary("Team Sync with Bob", None), "Team Sync with Bob")

    def test_other_attendees_not_removed(self):
        self.assertEqual(clean_event_summary("Alice and Bob Smith", "Alice"), "Bob Smith")

    def test_titles_without_user_name_unchanged(self):
        self.assertEqual(clean_event_summary("Weekly Review", "Alice"), "Weekly Review")

if __name__ == '__main__':
    unittest.main()
