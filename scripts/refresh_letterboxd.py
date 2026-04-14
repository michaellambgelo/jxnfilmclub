"""
Refresh data/watched.json and data/attendance.json from Letterboxd RSS.

For each member in data/members.json, fetch their Letterboxd RSS feed and:
  1. Collect the last four watched films -> data/watched.json
  2. Collect diary entries tagged `jxnfilmclub` and match them to known events
     in data/events.json -> data/attendance.json

RSS URL: https://letterboxd.com/<handle>/rss/

SCAFFOLD: this script walks members + writes empty objects for now. The
RSS parsing and event matching are TODO.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import feedparser

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'

TAG = 'jxnfilmclub'


def load(name: str) -> Any:
    return json.loads((DATA / name).read_text())


def dump(name: str, value: Any) -> None:
    (DATA / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def last_four_watched(handle: str) -> list[dict]:
    """TODO: parse RSS and return [{title, year, poster, watched_date}, ...]"""
    feed = feedparser.parse(f'https://letterboxd.com/{handle}/rss/')
    out = []
    for entry in feed.entries[:4]:
        out.append({
            'title': entry.get('letterboxd_filmtitle', entry.title),
            'year':  entry.get('letterboxd_filmyear'),
            'link':  entry.link,
            'watched_date': entry.get('letterboxd_watcheddate'),
        })
    return out


def tagged_entries(handle: str) -> list[dict]:
    """TODO: return diary entries tagged `jxnfilmclub` with film + watched_date."""
    feed = feedparser.parse(f'https://letterboxd.com/{handle}/rss/')
    out = []
    for entry in feed.entries:
        tags = [t.term.lower() for t in entry.get('tags', [])]
        if TAG in tags:
            out.append({
                'film': entry.get('letterboxd_filmtitle'),
                'year': entry.get('letterboxd_filmyear'),
                'date': entry.get('letterboxd_watcheddate'),
            })
    return out


def match_to_event(diary_entry: dict, events: list[dict]) -> str | None:
    """Match a diary entry to an event id by (film, date)."""
    for ev in events:
        if (diary_entry.get('film') == ev.get('film')
                and diary_entry.get('date') == ev.get('date')):
            return ev['id']
    return None


def main() -> None:
    members = load('members.json')
    events = load('events.json')

    watched: dict[str, list[dict]] = {}
    attendance: dict[str, list[str]] = {ev['id']: [] for ev in events}

    for m in members:
        handle = m['handle']
        try:
            watched[handle] = last_four_watched(handle)
            for entry in tagged_entries(handle):
                event_id = match_to_event(entry, events)
                if event_id:
                    attendance[event_id].append(handle)
        except Exception as e:
            print(f'[warn] {handle}: {e}')

    dump('watched.json', watched)
    dump('attendance.json', attendance)
    print(f'Refreshed {len(members)} members across {len(events)} events')


if __name__ == '__main__':
    main()
