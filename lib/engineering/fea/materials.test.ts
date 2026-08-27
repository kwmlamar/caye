import { describe, expect, it } from 'vitest'
import { listMaterialIds, resolveMaterial } from './materials'

describe('FEA material catalog', () => {
  it('resolves curated catalog materials with cited provenance', () => {
    const aluminum = resolveMaterial('6061-t6-aluminum')
    expect(aluminum?.youngsModulusMpa).toBe(68_900)
    expect(aluminum?.yieldStrengthMpa).toBe(276)
    expect(aluminum?.source).toMatch(/published/i)

    const steel = resolveMaterial('a36-steel')
    expect(steel?.youngsModulusMpa).toBe(200_000)
    expect(steel?.yieldStrengthMpa).toBe(250)
  })
  it('never guesses: returns null for an unknown or malformed material id', () => {
    expect(resolveMaterial('titanium-grade-5')).toBeNull()
    expect(resolveMaterial(undefined)).toBeNull()
    expect(resolveMaterial(42)).toBeNull()
  })
  it('exposes the full catalog for listing', () => {
    expect(listMaterialIds()).toEqual(expect.arrayContaining(['6061-t6-aluminum', 'a36-steel']))
  })
})
