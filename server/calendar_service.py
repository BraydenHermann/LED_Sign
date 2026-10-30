import json
import threading
import secrets
import time
import datetime
import os.path
import traceback
from typing import Optional
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly'
]
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
        self._pending_states = {}
        self._last_code_verifier = None
        self._state_storage_path = os.path.join(base_dir, ".oauth_pending.json")
        self._schedule_lock = threading.Lock()
        self._schedule_cache = {}
        self._cache_ttl = 15
        if os.path.exists(self.token_path):
            try:
                self.creds = Credentials.from_authorized_user_file(self.token_path, SCOPES)
            except Exception:
                pass

    def _ensure_valid(self):
        if self.creds and self.creds.expired and self.creds.refresh_token:
            try:
                self.creds.refresh(Request())
                with open(self.token_path, 'w') as f:
                    f.write(self.creds.to_json())
            except Exception as e:
                # If refresh failed with invalid_scope, fallback to reloading directly from token.json
                if "invalid_scope" in str(e).lower() and os.path.exists(self.token_path):
                    self.creds = Credentials.from_authorized_user_file(self.token_path)
                    self.creds.refresh(Request())
                    with open(self.token_path, 'w') as f:
                        f.write(self.creds.to_json())
                else:
                    raise

    def _create_flow(self, code_verifier: Optional[str] = None, state: Optional[str] = None):
        client_id = os.getenv("GOOGLE_CLIENT_ID")
        client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        
        flow_kwargs = {
            "scopes": SCOPES,
            "redirect_uri": REDIRECT_URI,
        }
        if state:
            flow_kwargs["state"] = state
        if code_verifier:
            flow_kwargs["code_verifier"] = code_verifier
            flow_kwargs["autogenerate_code_verifier"] = False

        if client_id and client_secret:
            client_config = {
                "web": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                }
            }
            try:
                flow = Flow.from_client_config(client_config, **flow_kwargs)
            except TypeError:
                flow_kwargs.pop("code_verifier", None)
                flow_kwargs.pop("autogenerate_code_verifier", None)
                flow = Flow.from_client_config(client_config, **flow_kwargs)
        else:
            if not os.path.exists(self.credentials_path):
                raise FileNotFoundError(
                    "Google OAuth credentials not found. Either set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET "
                    "environment variables, or provide a credentials.json file in the server/ folder."
                )
            try:
                flow = Flow.from_client_secrets_file(self.credentials_path, **flow_kwargs)
            except TypeError:
                flow_kwargs.pop("code_verifier", None)
                flow_kwargs.pop("autogenerate_code_verifier", None)
                flow = Flow.from_client_secrets_file(self.credentials_path, **flow_kwargs)

        if code_verifier:
            flow.code_verifier = code_verifier
            if hasattr(flow, "oauth2session") and flow.oauth2session:
                flow.oauth2session.code_verifier = code_verifier

        return flow

    def _save_oauth_state(self, state: str, code_verifier: str):
        self._pending_states[state] = {
            "code_verifier": code_verifier,
            "created_at": time.time()
        }
        self._last_code_verifier = code_verifier
        try:
            with open(self._state_storage_path, 'w') as f:
                json.dump({
                    "states": self._pending_states,
                    "latest": code_verifier
                }, f)
        except Exception as e:
            print(f"[calendar] Warning: could not persist oauth state to disk: {e}")

    def _get_code_verifier(self, state: Optional[str] = None) -> Optional[str]:
        # 1. In-memory dictionary by state
        if state and state in self._pending_states:
            val = self._pending_states[state]
            return val.get("code_verifier") if isinstance(val, dict) else val

        # 2. Disk storage
        try:
            if os.path.exists(self._state_storage_path):
                with open(self._state_storage_path, 'r') as f:
                    data = json.load(f)
                    states_dict = data.get("states", {})
                    if state and state in states_dict:
                        val = states_dict[state]
                        return val.get("code_verifier") if isinstance(val, dict) else val
                    if data.get("latest"):
                        return data["latest"]
        except Exception:
            pass

        # 3. In-memory latest
        if getattr(self, "_last_code_verifier", None):
            return self._last_code_verifier

        # 4. Global active flow
        global _active_flow
        if _active_flow is not None:
            v = getattr(_active_flow, 'code_verifier', None)
            if v:
                return v
            if hasattr(_active_flow, 'oauth2session') and hasattr(_active_flow.oauth2session, 'code_verifier'):
                return _active_flow.oauth2session.code_verifier

        return None

    def get_auth_url(self):
        global _active_flow
        code_verifier = secrets.token_urlsafe(64)
        flow = self._create_flow(code_verifier=code_verifier)
        auth_url, state = flow.authorization_url(
            prompt='consent', access_type='offline', include_granted_scopes='true'
        )
        actual_verifier = getattr(flow, 'code_verifier', None)
        if not actual_verifier and hasattr(flow, 'oauth2session') and hasattr(flow.oauth2session, 'code_verifier'):
            actual_verifier = flow.oauth2session.code_verifier
        if not actual_verifier:
            actual_verifier = code_verifier

        flow.code_verifier = actual_verifier
        if hasattr(flow, 'oauth2session') and flow.oauth2session:
            flow.oauth2session.code_verifier = actual_verifier

        self._save_oauth_state(state=state, code_verifier=actual_verifier)
        _active_flow = flow
        return auth_url

    def fetch_token(self, code: str, state: Optional[str] = None):
        global _active_flow
        code_verifier = self._get_code_verifier(state)
        
        flow = _active_flow
        if flow is None or (state and getattr(flow, 'state', None) != state):
            flow = self._create_flow(code_verifier=code_verifier, state=state)
        elif code_verifier:
            flow.code_verifier = code_verifier
            if hasattr(flow, "oauth2session") and flow.oauth2session:
                flow.oauth2session.code_verifier = code_verifier

        try:
            fetch_kwargs = {"code": code}
            if code_verifier:
                fetch_kwargs["code_verifier"] = code_verifier
            try:
                flow.fetch_token(**fetch_kwargs)
            except TypeError:
                flow.fetch_token(code=code)

            self.creds = flow.credentials
            
            token_dir = os.path.dirname(self.token_path)
            if token_dir and not os.path.exists(token_dir):
                os.makedirs(token_dir, exist_ok=True)
                
            with open(self.token_path, 'w') as f:
                f.write(self.creds.to_json())

            if state and state in self._pending_states:
                self._pending_states.pop(state, None)
            try:
                if os.path.exists(self._state_storage_path):
                    os.remove(self._state_storage_path)
            except Exception:
                pass
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

    def get_today_schedule(self, clean_name=True, force_refresh=False):
        """
        Return timed events and pending invites for today only (all-day events excluded).
        Returns a dict: {"events": [accepted_events], "invites": [pending_invites]}
        """
        now_utc = datetime.datetime.now(datetime.timezone.utc)

        if not force_refresh:
            with self._schedule_lock:
                cached = self._schedule_cache.get(clean_name)
                if cached:
                    cache_time, data = cached
                    if time.time() - cache_time < self._cache_ttl:
                        events_copy = []
                        for ev in data.get("events", []):
                            ev_copy = dict(ev)
                            try:
                                s_dt = datetime.datetime.fromisoformat(ev["start_iso"].replace('Z', '+00:00'))
                                e_dt = datetime.datetime.fromisoformat(ev["end_iso"].replace('Z', '+00:00'))
                                ev_copy["is_active"] = (s_dt <= now_utc <= e_dt)
                            except Exception:
                                pass
                            events_copy.append(ev_copy)
                        return {"events": events_copy, "invites": data.get("invites", [])}

        with self._schedule_lock:
            if not force_refresh:
                cached = self._schedule_cache.get(clean_name)
                if cached:
                    cache_time, data = cached
                    if time.time() - cache_time < self._cache_ttl:
                        events_copy = []
                        for ev in data.get("events", []):
                            ev_copy = dict(ev)
                            try:
                                s_dt = datetime.datetime.fromisoformat(ev["start_iso"].replace('Z', '+00:00'))
                                e_dt = datetime.datetime.fromisoformat(ev["end_iso"].replace('Z', '+00:00'))
                                ev_copy["is_active"] = (s_dt <= now_utc <= e_dt)
                            except Exception:
                                pass
                            events_copy.append(ev_copy)
                        return {"events": events_copy, "invites": data.get("invites", [])}

            service = self._get_service()
            if not service:
                return {"events": [], "invites": []}

            today_start = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
            today_end = today_start + datetime.timedelta(days=1)

            try:
                result = service.events().list(
                    calendarId='primary',
                    timeMin=today_start.isoformat(),
                    timeMax=today_end.isoformat(),
                    singleEvents=True,
                    orderBy='startTime'
                ).execute()
            except Exception as e:
                print(f"[calendar] Error fetching events from Google: {e}")
                cached = self._schedule_cache.get(clean_name)
                if cached:
                    return cached[1]
                return {"events": [], "invites": []}

        events = []
        invites = []
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
                    # User is not organizer and not an attendee -> skip
                    continue
            elif is_self_organizer:
                response_status = 'accepted'
            else:
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

            html_link = e.get("htmlLink", "")
            event_url = ""
            if html_link:
                try:
                    from urllib.parse import urlparse, parse_qs
                    qs = parse_qs(urlparse(html_link).query)
                    if "eid" in qs and qs["eid"]:
                        event_url = f"https://calendar.google.com/calendar/event?eid={qs['eid'][0]}"
                except Exception:
                    pass
            if not event_url and e.get("id"):
                import base64
                cal_id = user_name or "primary"
                try:
                    raw_eid = f"{e.get('id')} {cal_id}".encode("utf-8")
                    eid = base64.b64encode(raw_eid).decode("ascii").rstrip("=")
                    event_url = f"https://calendar.google.com/calendar/event?eid={eid}"
                except Exception:
                    event_url = html_link or f"https://calendar.google.com/calendar/event?eid={e.get('id')}"

            organizer_name = ""
            org_info = e.get("organizer", {})
            if org_info:
                organizer_name = org_info.get("displayName") or org_info.get("email", "")

            item = {
                "id": e.get("id"),
                "summary": cleaned_summary,
                "raw_summary": raw_summary,
                "time": time_str,
                "start_iso": start_raw,
                "end_iso": end_raw,
                "is_active": is_active,
                "html_link": html_link,
                "event_url": event_url or html_link,
                "response_status": response_status.lower(),
                "organizer": organizer_name
            }

            if response_status.lower() == 'accepted':
                events.append(item)
            elif response_status.lower() in ('needsaction', 'tentative'):
                invites.append(item)
            else:
                print(f"[calendar] Skipping declined event: {cleaned_summary}")

        schedule_result = {"events": events, "invites": invites}
        with self._schedule_lock:
            self._schedule_cache[clean_name] = (time.time(), schedule_result)
        return schedule_result

    def get_today_events(self, clean_name=True):
        """Return timed events for today only (all-day events excluded), each with is_active flag."""
        schedule = self.get_today_schedule(clean_name=clean_name)
        return schedule.get("events", []) if schedule else []

    def respond_to_event(self, event_id: str, response: str = 'accepted') -> dict:
        """
        Accept or respond to an event invite on Google Calendar directly.
        Returns dict with updated status or raises RuntimeError with clear context.
        """
        service = self._get_service()
        if not service:
            raise RuntimeError("Google Calendar is not connected. Please sign in.")

        # Check existing token scopes
        scopes = getattr(self.creds, 'scopes', []) or []
        has_write_scope = any('calendar.events' in s or 'calendar' == s or s.endswith('/calendar') for s in scopes)
        if not has_write_scope:
            raise PermissionError("READ_ONLY_SCOPE")

        event = service.events().get(calendarId='primary', eventId=event_id).execute()
        attendees = event.get('attendees', [])
        self_attendee = next((a for a in attendees if a.get('self')), None)

        if self_attendee:
            self_attendee['responseStatus'] = response
        else:
            primary_name = self.get_primary_user_name()
            matched = False
            for a in attendees:
                if a.get('displayName') == primary_name:
                    a['responseStatus'] = response
                    matched = True
                    break
            if not matched:
                attendees.append({'email': 'primary', 'responseStatus': response, 'self': True})

        try:
            updated = service.events().patch(
                calendarId='primary',
                eventId=event_id,
                body={'attendees': attendees}
            ).execute()
            with self._schedule_lock:
                self._schedule_cache.clear()
            return {"status": "success", "event_id": event_id, "response_status": response}
        except Exception as e:
            err_str = str(e)
            if "insufficient" in err_str.lower() or "403" in err_str:
                raise PermissionError("READ_ONLY_SCOPE")
            raise

