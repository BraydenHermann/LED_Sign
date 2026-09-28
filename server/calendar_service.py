import datetime
import os.path
import traceback
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
REDIRECT_URI = 'http://localhost:8000/auth/callback'

_active_flow: Flow = None

import re
import unicodedata

def clean_event_summary(summary: str) -> str:
    if not summary:
        return "Untitled"
    # Remove common boilerplate like 'and Brayden Hermann'
    cleaned = re.sub(r'\s*(?:and|&)\s+Brayden\s+Hermann\b', '', summary, flags=re.IGNORECASE)
    cleaned = re.sub(r'\bBrayden\s+Hermann\s+(?:and|&)\s*', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\s*[-/]\s*Brayden\s+Hermann\b', '', cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip()

    # Transliterate French / European / special characters to ASCII equivalents
    cleaned = cleaned.replace('œ', 'oe').replace('Œ', 'OE').replace('æ', 'ae').replace('Æ', 'AE')
    cleaned = cleaned.replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"')
    cleaned = cleaned.replace('–', '-').replace('—', '-').replace('…', '...')
    cleaned = ''.join(c for c in unicodedata.normalize('NFD', cleaned) if unicodedata.category(c) != 'Mn')
    return cleaned.strip() or "Untitled"

class CalendarService:
    def __init__(self, credentials_path="credentials.json", token_path="token.json"):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        self.credentials_path = os.path.join(base_dir, credentials_path) if not os.path.isabs(credentials_path) else credentials_path
        self.token_path = os.path.join(base_dir, token_path) if not os.path.isabs(token_path) else token_path
        self.creds = None
        if os.path.exists(self.token_path):
            try:
                self.creds = Credentials.from_authorized_user_file(self.token_path, SCOPES)
            except Exception:
                pass

    def _ensure_valid(self):
        if self.creds and self.creds.expired and self.creds.refresh_token:
            self.creds.refresh(Request())
            with open(self.token_path, 'w') as f:
                f.write(self.creds.to_json())

    def get_auth_url(self):
        global _active_flow
        if not os.path.exists(self.credentials_path):
            raise FileNotFoundError("credentials.json not found in server/ folder")
        _active_flow = Flow.from_client_secrets_file(
            self.credentials_path, scopes=SCOPES, redirect_uri=REDIRECT_URI
        )
        auth_url, _ = _active_flow.authorization_url(
            prompt='consent', access_type='offline', include_granted_scopes='true'
        )
        return auth_url

    def fetch_token(self, code: str):
        global _active_flow
        try:
            if _active_flow is None:
                _active_flow = Flow.from_client_secrets_file(
                    self.credentials_path, scopes=SCOPES, redirect_uri=REDIRECT_URI
                )
            _active_flow.fetch_token(code=code)
            self.creds = _active_flow.credentials
            with open(self.token_path, 'w') as f:
                f.write(self.creds.to_json())
        except Exception as e:
            traceback.print_exc()
            raise RuntimeError(f"Token exchange failed: {e}")

    def _get_service(self):
        if not self.creds or not self.creds.valid:
            self._ensure_valid()
        if not self.creds or not self.creds.valid:
            return None
        return build('calendar', 'v3', credentials=self.creds)

    def get_active_events(self):
        """Return events that are currently happening right now."""
        service = self._get_service()
        if not service:
            return None

        now = datetime.datetime.utcnow()
        now_str = now.isoformat() + 'Z'
        # timeMin = now, timeMax = now (events that overlap current moment)
        result = service.events().list(
            calendarId='primary',
            timeMin=now_str,
            timeMax=now_str,
            singleEvents=True,
            orderBy='startTime'
        ).execute()
        items = result.get('items', [])
        return [
            {"summary": e.get("summary", "Meeting"),
             "start": e['start'].get('dateTime', e['start'].get('date')),
             "end": e['end'].get('dateTime', e['end'].get('date'))}
            for e in items
        ]

    def get_upcoming_events(self, max_results=5):
        service = self._get_service()
        if not service:
            return None
        now = datetime.datetime.utcnow().isoformat() + 'Z'
        result = service.events().list(
            calendarId='primary', timeMin=now,
            maxResults=max_results, singleEvents=True, orderBy='startTime'
        ).execute()
        return result.get('items', [])

    def get_today_events(self):
        """Return timed events for today only (all-day events excluded), each with is_active flag."""
        service = self._get_service()
        if not service:
            return None

        now_utc = datetime.datetime.now(datetime.timezone.utc)
        today_start = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
        today_end = today_start + datetime.timedelta(days=1)

        result = service.events().list(
            calendarId='primary',
            timeMin=today_start.isoformat(),
            timeMax=today_end.isoformat(),
            singleEvents=True,
            orderBy='startTime'
        ).execute()

        events = []
        for e in result.get('items', []):
            start_raw = e['start'].get('dateTime')
            end_raw = e['end'].get('dateTime')

            # Skip all-day events (no dateTime, only date)
            if not start_raw or not end_raw:
                continue

            try:
                start_dt = datetime.datetime.fromisoformat(start_raw.replace('Z', '+00:00'))
                end_dt = datetime.datetime.fromisoformat(end_raw.replace('Z', '+00:00'))
                is_active = start_dt <= now_utc <= end_dt
                print(f"[calendar] Event: {e.get('summary')} | Start: {start_dt} | End: {end_dt} | Now: {now_utc} | Active: {is_active}")
                # Windows uses %#I for zero-padded-suppressed hours, %-I is for Linux
                start_fmt = start_dt.astimezone().strftime('%#I:%M %p')
                end_fmt = end_dt.astimezone().strftime('%#I:%M %p')
                time_str = f"{start_fmt} - {end_fmt}"
            except Exception as ex:
                print(f"[calendar] Error formatting event {e.get('summary')}: {ex}")
                # Keep is_active but fallback the time string
                time_str = start_raw

            # Skip cancelled events
            if e.get('status') == 'cancelled':
                continue

            # Determine attendee response status
            attendees = e.get('attendees', [])
            is_self_organizer = e.get('organizer', {}).get('self', False)
            
            if attendees:
                self_attendee = next((a for a in attendees if a.get('self')), None)
                if self_attendee:
                    response_status = self_attendee.get('responseStatus', 'needsAction')
                elif is_self_organizer:
                    response_status = 'accepted'
                else:
                    # User is not organizer and not an accepted attendee -> skip
                    continue
            elif is_self_organizer:
                response_status = 'accepted'
            else:
                # External event without attendees list
                response_status = 'needsAction'

            raw_summary = e.get('summary', 'Untitled')
            cleaned_summary = clean_event_summary(raw_summary)
            print(f"[calendar] Event: {cleaned_summary} (raw: {raw_summary}) | Status: {response_status} | Attendees: {len(attendees)}")

            # Only accepted calendar invites/events appear in the schedule to avoid spam
            if response_status.lower() != 'accepted':
                print(f"[calendar] Skipping unaccepted invite: {cleaned_summary} (status: {response_status})")
                continue

            events.append({
                "id": e.get("id"),
                "summary": cleaned_summary,
                "time": time_str,
                "start_iso": start_raw,
                "end_iso": end_raw,
                "is_active": is_active,
                "html_link": e.get("htmlLink", ""),
                "response_status": response_status.lower()
            })
        return events

