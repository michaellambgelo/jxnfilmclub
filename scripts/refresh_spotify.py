"""
Refresh data/episodes.json from the JXN Film Club podcast RSS feed.

RSS URL: https://anchor.fm/s/6e584c10/podcast/rss
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from pathlib import Path
from typing import Any

import feedparser

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'

FEED_URL = 'https://anchor.fm/s/6e584c10/podcast/rss'
SHOW_ID = '6iL1D2abg8G8JQqvJa3XBp'


def load(name: str) -> Any:
    return json.loads((DATA / name).read_text())


def dump(name: str, value: Any) -> None:
    (DATA / name).write_text(json.dumps(value, indent=2) + '\n')


def fetch_episodes() -> list[dict]:
    feed = feedparser.parse(FEED_URL)
    episodes = []
    for entry in feed.entries:
        date = ''
        if entry.get('published_parsed'):
            date = time.strftime('%Y-%m-%d', entry.published_parsed)
        episodes.append({
            'title': entry.title,
            'date': date,
            'url': entry.link,
        })
    episodes.sort(key=lambda e: e['date'], reverse=True)
    return episodes


def fetch_featured_spotify_id() -> str | None:
    """Scrape the Spotify show embed page for the latest episode's ID.

    The embed page server-renders the current/latest episode ID, even though
    the public show page does not. Returns the first episode ID that isn't
    the show ID itself.
    """
    url = f'https://open.spotify.com/embed/show/{SHOW_ID}'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode()
    except Exception as e:
        print(f'[warn] could not fetch {url}: {e}')
        return None
    m = re.search(r'spotify:episode:([a-zA-Z0-9]{22})', html)
    return m.group(1) if m else None


def main() -> None:
    episodes = fetch_episodes()
    featured_id = fetch_featured_spotify_id()
    dump('episodes.json', {
        'featured_id': featured_id,
        'episodes': episodes,
    })
    print(f'Refreshed episodes.json with {len(episodes)} episode(s), featured_id={featured_id}')


if __name__ == '__main__':
    main()
