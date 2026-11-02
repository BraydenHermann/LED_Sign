import time
import datetime
import os
import urllib.request
import urllib.error
import json
from win11toast import toast

# Track state in memory
last_notified_event_id = None

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
ICON_PATH = os.path.abspath(os.path.join(STATIC_DIR, "..", "..", "client", "public", "favicon.ico"))
if not os.path.exists(ICON_PATH):
    ICON_PATH = None

def run_loop():
    global last_notified_event_id
    print("[calendar_agent] Started standalone calendar monitor.")
    
    while True:
        time.sleep(15)
        
        try:
            # Query backend for today's schedule to share cache and avoid Google API rate limits
            req = urllib.request.Request("http://127.0.0.1:8000/calendar/today?clean_name=true")
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                    events = data.get("events", [])
            except Exception:
                continue

            if not events:
                continue
                
            now_local = datetime.datetime.now().astimezone()
            target_event = None
            
            for ev in events:
                if ev.get('response_status', '').lower() == 'declined':
                    continue
                start_iso = ev.get('start_iso')
                end_iso = ev.get('end_iso')
                if not start_iso or not end_iso:
                    continue
                
                try:
                    start_dt = datetime.datetime.fromisoformat(start_iso)
                    end_dt = datetime.datetime.fromisoformat(end_iso)
                except ValueError:
                    continue
                
                if start_dt - datetime.timedelta(minutes=5) <= now_local <= end_dt:
                    target_event = ev
                    break
                    
            if target_event:
                event_id = target_event['id']
                summary = target_event.get('summary', 'Event')
                
                if last_notified_event_id != event_id:
                    last_notified_event_id = event_id
                    try:
                        start_dt = datetime.datetime.fromisoformat(target_event['start_iso'])
                        minutes_until = max(0, round((start_dt - now_local).total_seconds() / 60.0))
                        time_label = 'now' if minutes_until <= 1 else f'in {minutes_until} min'
                        
                        toast('Upcoming Meeting', f'{summary} starts {time_label}', duration='short', icon=ICON_PATH)
                        print(f"[calendar_agent] Displayed toast notification for {summary}")
                    except Exception as e:
                        print(f"[calendar_agent] Notification error: {e}")
                        
                # Showing the event on the sign belongs to the dashboard, or
                # to the server's own fallback when no dashboard is open; a
                # push from here bypassed slot 1 and drew "|||" on the sign.
            else:
                last_notified_event_id = None
                    
        except Exception as e:
            print(f"[calendar_agent] Loop error: {e}")

def wait_for_single_instance():
    """Block until no other calendar agent runs.

    A tray launcher that is killed leaves its agent running, and the next
    launcher starts another one, which would show every reminder twice.
    Waiting (rather than exiting) keeps the launcher from respawning this one.
    """
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        mutex = kernel32.CreateMutexW(None, False, "LEDSignCalendarAgentMutex")
        kernel32.WaitForSingleObject(mutex, 0xFFFFFFFF)
        return mutex
    except Exception:
        return None


if __name__ == "__main__":
    _instance_mutex = wait_for_single_instance()
    run_loop()
