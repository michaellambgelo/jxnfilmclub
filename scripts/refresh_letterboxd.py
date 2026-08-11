"""
Refresh data/watched.json and data/takes.json from Letterboxd RSS.

For each member in data/members.json with a verified handle, fetch their
Letterboxd RSS feed once and collect:
  - the last four watched films        -> data/watched.json
  - up to 3 recent reviews ("takes")   -> data/takes.json

Takes power the home page's Hot Takes section. List entries, spoiler-flagged
reviews, and plain diary entries ("Watched on ...") are skipped; review text
is flattened to plain text and truncated to ~300 chars.

Attendance is no longer derived here. RSS does not expose diary tags, so
attendance is now self-reported via the events page (POST /events/:id/attend
on the worker, periodically snapshotted to data/attendance.json by
snapshot-attendance.yml).

RSS URL: https://letterboxd.com/<handle>/rss/
"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any

import feedparser

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'

TAKES_PER_MEMBER = 3
SPOILER_RE = re.compile(r'This review may contain spoilers', re.I)
IMG_TAG_RE = re.compile(r'<img\s[^>]*>', re.I)
TAG_RE = re.compile(r'<[^>]+>')


def load(name: str) -> Any:
    return json.loads((DATA / name).read_text())


def dump(name: str, value: Any) -> None:
    (DATA / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def extract_poster(description: str) -> str | None:
    m = re.search(r'<img\s[^>]*src="([^"]+)"', description or '')
    return m.group(1) if m else None


def truncate(text: str, limit: int = 300) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(' ', 1)[0].rstrip('.,;:—-') + '…'


def extract_review(entry) -> str | None:
    """Plain-text review from an RSS entry, or None if it isn't a review."""
    if 'letterboxd-list' in (entry.get('id') or ''):
        return None
    desc = entry.get('summary', '') or ''
    if SPOILER_RE.search(desc):
        return None
    desc = IMG_TAG_RE.sub('', desc)
    text = re.sub(r'\s+', ' ', html.unescape(TAG_RE.sub(' ', desc))).strip()
    if not text or text.startswith('Watched on '):
        return None
    # the take card wraps reviews in decorative quotes, so drop any the
    # review already carries
    text = text.strip('"“”').strip()
    return truncate(text) if text else None


def refresh_member(handle: str) -> tuple[list[dict], list[dict]]:
    feed = feedparser.parse(f'https://letterboxd.com/{handle}/rss/')
    films = []
    for entry in feed.entries[:4]:
        film: dict[str, Any] = {
            'title': entry.get('letterboxd_filmtitle', entry.title),
            'year':  entry.get('letterboxd_filmyear'),
            'link':  entry.link,
            'watched_date': entry.get('letterboxd_watcheddate'),
        }
        rating = entry.get('letterboxd_memberrating')
        if rating:
            film['rating'] = rating
        if (entry.get('letterboxd_memberlike') or '').lower() == 'yes':
            film['liked'] = True
        poster = extract_poster(entry.get('summary', ''))
        if poster:
            film['poster'] = poster
        films.append(film)

    takes = []
    for entry in feed.entries:
        review = extract_review(entry)
        if not review:
            continue
        take: dict[str, Any] = {
            'handle': handle,
            'title':  entry.get('letterboxd_filmtitle', entry.title),
            'year':   entry.get('letterboxd_filmyear'),
            'link':   entry.link,
            'review': review,
            'watched_date': entry.get('letterboxd_watcheddate'),
        }
        rating = entry.get('letterboxd_memberrating')
        if rating:
            take['rating'] = rating
        if (entry.get('letterboxd_memberlike') or '').lower() == 'yes':
            take['liked'] = True
        poster = extract_poster(entry.get('summary', ''))
        if poster:
            take['poster'] = poster
        takes.append(take)
        if len(takes) >= TAKES_PER_MEMBER:
            break
    return films, takes


def main() -> None:
    members = load('members.json')
    watched: dict[str, list[dict]] = {}
    takes: list[dict] = []

    for m in members:
        handle = m.get('handle')
        if not handle:
            continue
        try:
            films, member_takes = refresh_member(handle)
            watched[handle] = films
            takes.extend(member_takes)
        except Exception as e:
            print(f'[warn] {handle}: {e}')

    takes.sort(key=lambda t: t.get('watched_date') or '', reverse=True)
    dump('watched.json', watched)
    dump('takes.json', takes)
    print(f'Refreshed watched.json for {len(watched)} member(s), {len(takes)} take(s)')


if __name__ == '__main__':
    main()
