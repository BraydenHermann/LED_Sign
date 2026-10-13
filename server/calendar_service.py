import datetime
import os.path
import traceback
from typing import Optional
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
REDIRECT_URI = os.getenv('GOOGLE_REDIRECT_URI', 'http://localhost:8000/auth/callback')

_active_flow: Flow = None

import re
import unicodedata

def clean_event_summary(summary: str, user_name: str = None) -> str:
    if not summary:
        return "Untitled"
        
    cleaned = summary
    names_to_strip = []
    if user_name:
        names_to_strip.append(user_name.strip())
        parts = user_name.strip().split()
        if len(parts) > 1:
            names_to_strip.append(parts[0])
            names_to_strip.append(parts[-1])

    # Always recognize Brayden and Hermann as user names for this environment
    for default_n in ['Brayden Hermann', 'Brayden', 'Hermann']:
        if default_n not in names_to_strip:
            names_to_strip.append(default_n)

    # Sort names by length descending so multi-word names match first
    names_to_strip = sorted(list(set(n for n in names_to_strip if len(n) > 1)), key=len, reverse=True)

    for name in names_to_strip:
        escaped_name = re.escape(name)
        # Matches: " and Name", " & Name", ", and Name", ", & Name"
        cleaned = re.sub(r'[\s,]+(?:and|&)\s+' + escaped_name + r'\b', '', cleaned, flags=re.IGNORECASE)
        # Matches: "Name and ", "Name & "
        cleaned = re.sub(r'\b' + escaped_name + r'\s+(?:and|&)\s*', '', cleaned, flags=re.IGNORECASE)
        # Matches: " with Name"
        cleaned = re.sub(r'\s*(?:with)\s+' + escaped_name + r'\b', '', cleaned, flags=re.IGNORECASE)
        # Matches: " - Name", " / Name", " : Name", " | Name"
        cleaned = re.sub(r'\s*[-/:|]\s*' + escaped_name + r'\b', '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'\b' + escaped_name + r'\s*[-/:|]\s*', '', cleaned, flags=re.IGNORECASE)
        # Matches: ", Name"
        cleaned = re.sub(r',\s*' + escaped_name + r'\b', '', cleaned, flags=re.IGNORECASE)
        # Matches standalone Name
        cleaned = re.sub(r'\b' + escaped_name + r'\b', '', cleaned, flags=re.IGNORECASE)
        
    # Clean up any leftover punctuation or dangling conjunctions
    cleaned = re.sub(r'\s*(?:and|&|\/|\-|:|,)\s*$', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'^\s*(?:and|&|\/|\-|:|,)\s*', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()

    # If stripping removed everything, keep the original summary
    if not cleaned:
        cleaned = summary.strip()

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
        env_token_path = os.getenv("GOOGLE_TOKEN_PATH")
        if env_token_path:
            self.token_path = env_token_path if os.path.isabs(env_token_path) else os.path.join(base_dir, env_token_path)
        else:
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

    def _create_flow(self):
        client_id = os.getenv("GOOGLE_CLIENT_ID")
        client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        
        if client_id and client_secret:
            client_config = {
                "web": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                }
            }
            return Flow.from_client_config(
                client_config, scopes=SCOPES, redirect_uri=REDIRECT_URI
            )
        else:
            if not os.path.exists(self.credentials_path):
                raise FileNotFoundError(
                    "Google OAuth credentials not found. Either set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET "
                    "environment variables, or provide a credentials.json file in the server/ folder."
                )
            return Flow.from_client_secrets_file(
                self.credentials_path, scopes=SCOPES, redirect_uri=REDIRECT_URI
            )

    def get_auth_url(self):
        global _active_flow
        _active_flow = self._create_flow()
        auth_url, _ = _active_flow.authorization_url(
            prompt='consent', access_type='offline', include_granted_scopes='true'
        )
        return auth_url

    def fetch_token(self, code: str):
        global _active_flow
        try:
            if _active_flow is None:
                _active_flow = self._create_flow()
            _active_flow.fetch_token(code=code)
            self.creds = _active_flow.credentials
            
            token_dir = os.path.dirname(self.token_path)
            if token_dir and not os.path.exists(token_dir):
                os.makedirs(token_dir, exist_ok=True)
                
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

    def get_primary_user_name(self) -> Optional[str]:
        if hasattr(self, '_cached_user_name') and self._cached_user_name:
            return self._cached_user_name
        service = self._get_service()
        if not service:
            return None
        try:
            cal = service.calendarList().get(calendarId='primary').execute()
            if cal and cal.get('summary'):
                self._cached_user_name = cal.get('summary')
                return self._cached_user_name
        except Exception:
            pass
        return None

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

    def get_today_events(self, clean_name=True):
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
            
            user_name = None
            if clean_name:
                organizer = e.get('organizer', {})
                creator = e.get('creator', {})
                attendees = e.get('attendees', [])
                
                for a in attendees:
                    if a.get('self') and a.get('displayName'):
                        user_name = a.get('displayName')
                        break
                        
                if not user_name and organizer.get('self') and organizer.get('displayName'):
                    user_name = organizer.get('displayName')
                    
                if not user_name and creator.get('self') and creator.get('displayName'):
                    user_name = creator.get('displayName')
                    
                if not user_name:
                    user_name = os.environ.get('CALENDAR_DISPLAY_NAME') or self.get_primary_user_name()
            
            cleaned_summary = clean_event_summary(raw_summary, user_name) if clean_name else raw_summary
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

