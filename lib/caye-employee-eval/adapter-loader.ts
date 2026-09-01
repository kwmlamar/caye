import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EmployeeEvalAdapter } from './runner'

const DEFAULT_ADAPTER = join(__dirname, 'production-adapter.ts')

export async function loadEmployeeEvalAdapter(configuredPath = process.env.CAYE_EMPLOYEE_EVAL_ADAPTER_MODULE): Promise<EmployeeEvalAdapter> {
  const adapterPath = configuredPath
    ? (isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath))
    : DEFAULT_ADAPTER

  if (!existsSync(adapterPath)) {
    throw new Error(
      `Employee-behavior PR requires a real Employee Eval v1 adapter. Missing ${adapterPath}. ` +
      'Implement/export employeeEvalAdapter from lib/caye-employee-eval/production-adapter.ts (or set CAYE_EMPLOYEE_EVAL_ADAPTER_MODULE). ' +
      'A baseline replay is not a candidate evaluation.',
    )
  }

  const module = await import(pathToFileURL(adapterPath).href)
  const adapter = module.employeeEvalAdapter as EmployeeEvalAdapter | undefined
  if (!adapter?.reset || !adapter?.handle || !adapter?.snapshot) {
    throw new Error(`${adapterPath} must export employeeEvalAdapter implementing reset(), handle(), and snapshot().`)
  }
  return adapter
}
