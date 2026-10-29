// Which events the open internet may see. Shared by the join API (index.js)
// and the site's link previews (site-meta.js) so the two can never disagree.
// venues.js keeps its own copy on purpose, to stay import-free.

// A screening at somebody's home is not advertised to the open internet. There
// is no per-event toggle: kind === 'house' IS the signal, so it cannot be
// misconfigured, and a host cannot forget to tick a box. Theater meetups
// (kind: 'meetup') and the club's own screenings (no host) stay public.
//
// Legacy rows predate the kind field: a hosted event without one was always a
// house screening, which is the same reading events-view uses.
export function isMembersOnly(event) {
  if (!event) return false
  return event.kind === 'house' || (!event.kind && !!event.hostId)
}
