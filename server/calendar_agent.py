import time
import datetime
import os
import urllib.request
import urllib.error
import json
import calendar_service
from win11toast import toast

# Track state in memory
last_notified_event_id = None
last_pushed_event_id = None

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
ICON_PATH = os.path.abspath(os.path.join(STATIC_DIR, "..", "..", "client", "public", "favicon.ico"))
if not os.path.exists(ICON_PATH):
    ICON_PATH = None

def send_push_request(summary, time_str):
    req_body = json.dumps({
        "text": f"{summary} ||| {time_str}",
        "textColor": "#FFFFFF",
        "bgColor": "#000000",
        "speed": 8
    }).encode('utf-8')
    
    req = urllib.request.Request("http://127.0.0.1:8000/push-text", data=req_body, headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=3)
        print(f"[calendar_agent] Pushed calendar event to sign: {summary}")
    except Exception as e:
        print(f"[calendar_agent] Server not available to push text: {e}")

def run_loop():
    global last_notified_event_id, last_pushed_event_id
    print("[calendar_agent] Started standalone calendar monitor.")
    
    while True:
        time.sleep(10)
        
        try:
            if not (os.path.exists(calendar_service.token_path) or (calendar_service.creds is not None and calendar_service.creds.valid)):
                continue

            events = calendar_service.get_today_events(clean_name=True)
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
                time_str = target_event.get('time', '')
                
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
                        
                if last_pushed_event_id != event_id:
                    last_pushed_event_id = event_id
                    send_push_request(summary, time_str)
                    
        except Exception as e:
            print(f"[calendar_agent] Loop error: {e}")

if __name__ == "__main__":
    run_loop()
