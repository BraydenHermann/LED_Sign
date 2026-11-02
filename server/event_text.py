"""Calendar event text for the sign, matching client/src/eventText.js.

The dashboard and the server both put the current meeting in slot 1; they
must produce the same text so the sign, the live preview and the saved
preset always agree.
"""
import datetime
import re


def fit_event_sign_text(summary: str, end_time: str, max_length: int = 25) -> str:
    """Port of fitEventSignText: keep whole title words, then the end time."""
    title = re.sub(r"\s+", " ", str(summary or "")).strip()
    time = str(end_time or "").strip()
    if not time:
        return title[:max_length]
    if not title:
        return time[:max_length]

    ampm_match = re.search(r"\s*([ap]\.?m\.?)$", time, re.IGNORECASE)
    ampm = ampm_match.group(1).lower().replace(".", "") if ampm_match else ""
    time_digits = re.sub(r"\s*[ap]\.?m\.?$", "", time, flags=re.IGNORECASE).strip()
    time_with_ampm = f"{time_digits} {ampm}" if ampm else time_digits

    prefixes = []
    for match in re.finditer(r"[^\s/]+", title):
        prefix = re.sub(r"[\s/\-,;:]+$", "", title[:match.end()])
        if prefix and prefix not in prefixes:
            prefixes.append(prefix)

    for p in reversed(prefixes):
        if ampm:
            for candidate in (f"{p} - {time_with_ampm}", f"{p} {time_with_ampm}"):
                if len(candidate) <= max_length:
                    return candidate
        else:
            for candidate in (f"{p} - {time_digits}", f"{p} {time_digits}"):
                if len(candidate) <= max_length:
                    return candidate
        if ampm and len(f"{p} {time_digits}") <= max_length:
            return f"{p} {time_digits}"

    return time_with_ampm[:max_length]


def format_clock(dt: datetime.datetime) -> str:
    """Like Intl en-US {hour: 'numeric', minute: '2-digit'}, lowercased."""
    hour = dt.hour % 12 or 12
    return f"{hour}:{dt.minute:02d} {'am' if dt.hour < 12 else 'pm'}"


def event_sign_text(summary: str, end_iso: str) -> str:
    """What the dashboard shows for an event: title fitted with its end time."""
    try:
        end = datetime.datetime.fromisoformat(end_iso.replace("Z", "+00:00")).astimezone()
    except (AttributeError, ValueError):
        return summary
    return fit_event_sign_text(summary, format_clock(end))


def event_slot_preset(text: str, speed: int = 8) -> dict:
    """The slot-1 preset the dashboard saves for an event (see App.jsx)."""
    return {
        "mode": "text",
        "name": text,
        "text": text,
        "textColor": "#ffffff",
        "bgColor": "#000000",
        "animation": "continuous left shift",
        "speed": speed,
        "rotation": 0,
        "spacing": 1,
        "views": 1,
    }
