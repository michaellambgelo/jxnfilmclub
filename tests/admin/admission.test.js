import { describe, expect, it } from 'vitest'
import cases from '../fixtures/admission-cases.json'
import { eventAdmission } from '../../admin/lib.js'

// One case table, three copies of the function (worker, model, admin). A drift
// in any copy fails its own project against the same rows.
describe('eventAdmission (admin copy)', () => {
  for (const c of cases) it(c.name, () => expect(eventAdmission(c.event)).toBe(c.want))
})
