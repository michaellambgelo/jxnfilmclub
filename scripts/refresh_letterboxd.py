"""
Refresh data/watched.json from Letterboxd RSS.

For each member in data/members.json with a verified handle, fetch their
Letterboxd RSS feed and collect the last four watched films -> data/watched.json.

Attendance is no longer derived here. RSS does not expose diary tags, so
attendance is now self-reported via the events page (POST /events/:id/attend
on the worker, mirrored to data/attendance.json by update-attendance.yml).

RSS URL: https://letterboxd.com/<handle>/rss/

SCAFFOLD: this script walks members + writes empty objects for now. The
RSS field names need verification against a real feed.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import feedparser

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'


def load(name: str) -> Any:
    return json.loads((DATA / name).read_text())


def dump(name: str, value: Any) -> None:
    (DATA / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def extract_poster(description: str) -> str | None:
    m = re.search(r'<img\s[^>]*src="([^"]+)"', description or '')
    return m.group(1) if m else None


def last_four_watched(handle: str) -> list[dict]:
    feed = feedparser.parse(f'https://letterboxd.com/{handle}/rss/')
    out = []
    for entry in feed.entries[:4]:
        film: dict[str, Any] = {
            'title': entry.get('letterboxd_filmtitle', entry.title),
            'year':  entry.get('letterboxd_filmyear'),
            'link':  entry.link,
            'watched_date': entry.get('letterboxd_watcheddate'),
        }
        poster = extract_poster(entry.get('summary', ''))
        if poster:
            film['poster'] = poster
        out.append(film)
    return out


def main() -> None:
    members = load('members.json')
    watched: dict[str, list[dict]] = {}

    for m in members:
        handle = m.get('handle')
        if not handle:
            continue
        try:
            watched[handle] = last_four_watched(handle)
        except Exception as e:
            print(f'[warn] {handle}: {e}')

    dump('watched.json', watched)
    print(f'Refreshed watched.json for {len(watched)} member(s)')


if __name__ == '__main__':
    main()
