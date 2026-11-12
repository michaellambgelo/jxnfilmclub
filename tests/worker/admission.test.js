import { describe, expect, it } from 'vitest'
import cases from '../fixtures/admission-cases.json'
import { eventAdmission, reconcileAdmission } from '../../worker/src/event-visibility.js'

// One case table, three copies of the function (worker, model, admin). A drift
// in any copy fails its own project against the same rows.
describe('eventAdmission (worker copy)', () => {
  for (const c of cases) it(c.name, () => expect(eventAdmission(c.event)).toBe(c.want))
})

// `ticketed` is what the pre-sale queue reads, so it stays the behavioural
// field; `admission`, when present, decides it.
describe('reconcileAdmission', () => {
  it('a sent admission is stored and decides ticketed', () => {
    expect(reconcileAdmission({ admission: 'ticketed' }, { admission: 'ticketed' }))
      .toEqual({ admission: 'ticketed', ticketed: true })
    expect(reconcileAdmission({ admission: 'free', ticketed: true }, { admission: 'free' }))
      .toEqual({ admission: 'free', ticketed: false })
    expect(reconcileAdmission({ admission: 'own', ticketed: true }, { admission: 'own' }))
      .toEqual({ admission: 'own', ticketed: false })
  })

  it('a sent admission beats a ticketed flag sent alongside it', () => {
    expect(reconcileAdmission({ admission: 'free', ticketed: true }, { admission: 'free', ticketed: true }))
      .toEqual({ admission: 'free', ticketed: false })
  })

  it('clearing admission removes the label and leaves ticketed alone', () => {
    expect(reconcileAdmission({ admission: 'ticketed', ticketed: true }, { admission: '' }))
      .toEqual({ ticketed: true })
    expect(reconcileAdmission({ admission: 'free', ticketed: false }, { admission: null }))
      .toEqual({ ticketed: false })
  })

  it('a client that only knows ticketed behaves as before on an unlabelled row', () => {
    expect(reconcileAdmission({ ticketed: true }, { ticketed: true })).toEqual({ ticketed: true })
    expect(reconcileAdmission({ ticketed: false }, { ticketed: false })).toEqual({ ticketed: false })
  })

  it('a lone ticketed flag that disagrees with the stored label wins', () => {
    expect(reconcileAdmission({ admission: 'free', ticketed: true }, { ticketed: true }))
      .toEqual({ admission: 'ticketed', ticketed: true })
    expect(reconcileAdmission({ admission: 'ticketed', ticketed: false }, { ticketed: false }))
      .toEqual({ ticketed: false })
    // false on a row that was not 'ticketed' agrees with it already.
    expect(reconcileAdmission({ admission: 'own', ticketed: false }, { ticketed: false }))
      .toEqual({ admission: 'own', ticketed: false })
  })

  it('touches nothing when neither field is sent', () => {
    expect(reconcileAdmission({ admission: 'free', ticketed: false, title: 'x' }, { title: 'x' }))
      .toEqual({ admission: 'free', ticketed: false, title: 'x' })
    expect(reconcileAdmission({ title: 'x' }, {})).toEqual({ title: 'x' })
  })
})
