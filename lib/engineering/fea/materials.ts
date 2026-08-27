/**
 * Deliberately small, curated V1 material catalog. Values are published
 * "typical" engineering handbook properties (ASM/MatWeb-class sources), not
 * mill-certified test data for a specific heat/lot. The LLM never invents or
 * edits these numbers — it can only reference a material by id, and an
 * unresolved id is a structured clarification error (see ../fea/spec.ts),
 * never a guess.
 *
 * Units: mm-N-MPa-tonne (CalculiX's standard consistent unit set), matching
 * the CadQuery geometry pipeline's mm convention.
 */
export type Material = {
  id: string
  displayName: string
  youngsModulusMpa: number
  poissonRatio: number
  densityTonnePerMm3: number
  /** Null when unknown — factor of safety must then be null too, never guessed. */
  yieldStrengthMpa: number | null
  source: string
}

const CATALOG: Record<string, Material> = {
  '6061-t6-aluminum': {
    id: '6061-t6-aluminum',
    displayName: '6061-T6 Aluminum',
    youngsModulusMpa: 68_900,
    poissonRatio: 0.33,
    densityTonnePerMm3: 2.7e-9,
    yieldStrengthMpa: 276,
    source: 'Published typical properties for 6061-T6 aluminum (ASM Aerospace Specification Metals / MatWeb). Not mill-certified data for a specific heat.',
  },
  'a36-steel': {
    id: 'a36-steel',
    displayName: 'A36 Structural Steel',
    youngsModulusMpa: 200_000,
    poissonRatio: 0.26,
    densityTonnePerMm3: 7.85e-9,
    yieldStrengthMpa: 250,
    source: 'Published typical properties for ASTM A36 structural steel (ASM / MatWeb). Not mill-certified data for a specific heat.',
  },
}

/** Never guesses: returns null for anything not in the curated catalog. */
export function resolveMaterial(materialId: unknown): Material | null {
  if (typeof materialId !== 'string') return null
  return CATALOG[materialId] ?? null
}

export function listMaterialIds(): string[] {
  return Object.keys(CATALOG)
}
