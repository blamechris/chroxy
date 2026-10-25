"""UTC timestamps, parsed the way measures.py parses them."""
import re
from datetime import datetime, timezone


def parse_ts(value):
    """Parse an ISO-8601 timestamp to an aware UTC datetime; a value with no
    offset is UTC, never host-local. Fractions are cut to microseconds."""
    if not value:
        return None
    value = value.replace('Z', '+00:00')
    if '.' in value:
        head, tail = value.split('.', 1)
        match = re.match(r'(\d*)(.*)$', tail)
        frac, tz = match.group(1), match.group(2)
        value = f'{head}.{frac[:6].ljust(6, "0")}{tz}'
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def instant(value):
    """The moment an ISO-8601 timestamp names, or None when `value` is missing or cannot be read (a value that is no text, no
    timestamp, or so near the end of the calendar that its UTC time is out of range, such as 9999-12-31T23:59:59-05:00)."""
    try:
        return parse_ts(value)
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def iso(dt):
    """Format an aware datetime as `YYYY-MM-DDTHH:MM:SS[.mmm|.ffffff]Z` (milliseconds kept as three digits)."""
    dt = dt.astimezone(timezone.utc)
    text = dt.strftime('%Y-%m-%dT%H:%M:%S')
    if dt.microsecond % 1000 == 0 and dt.microsecond:
        text += f'.{dt.microsecond // 1000:03d}'
    elif dt.microsecond:
        text += f'.{dt.microsecond:06d}'
    return text + 'Z'


def now():
    return datetime.now(timezone.utc)


def minutes(a, b):
    ta, tb = parse_ts(a), parse_ts(b)
    if ta is None or tb is None:
        return None
    return (tb - ta).total_seconds() / 60.0
