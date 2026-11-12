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

// How people get in. `admission` is the explicit, admin-set answer:
//   'free'     — nothing to buy
//   'ticketed' — the venue sells admission; the club coordinates (pre-sale queue)
//   'own'      — self-organized; everyone buys their own, no pre-sale queue
// Rows that predate the field fall back to what they always meant: the
// `ticketed` flag, then "a meetup is self-organized". 'free' is NEVER derived —
// a row nobody has answered the question for stays unlabelled ('').
//
// Mirrored in model/index.ts and admin/lib.js (the rsvpEnabled pattern); all
// three run against tests/fixtures/admission-cases.json.
export const ADMISSIONS = ['free', 'ticketed', 'own']
export function eventAdmission(e) {
  if (!e) return ''
  if (ADMISSIONS.includes(e.admission)) return e.admission
  if (e.ticketed) return 'ticketed'
  return e.kind === 'meetup' ? 'own' : ''
}

// Keep `admission` and the legacy `ticketed` flag in step on an admin write.
// `ticketed` is what the pre-sale queue reads (ticketsPending), so it stays the
// behavioural field and admission, when present, decides it. `value` is the
// validated merged row (mutated and returned); `input` is the raw request
// body, which is the only place "what did this write actually send" survives.
//
//   admission sent, valid      -> stored; ticketed = (admission === 'ticketed')
//   admission sent, '' / null  -> label removed; ticketed left alone
//   only ticketed sent         -> a client that predates the field. If the row
//                                 carries an admission that now disagrees,
//                                 true makes it 'ticketed' and false drops the
//                                 'ticketed' label, so the pair never conflicts
//   neither                    -> unchanged
export function reconcileAdmission(value, input = {}) {
  const sent = input.admission
  if (sent === '' || sent === null) {
    delete value.admission
  } else if (ADMISSIONS.includes(sent)) {
    value.admission = sent
    value.ticketed = sent === 'ticketed'
  } else if (typeof input.ticketed === 'boolean' && value.admission) {
    if (input.ticketed) value.admission = 'ticketed'
    else if (value.admission === 'ticketed') delete value.admission
  }
  return value
}
