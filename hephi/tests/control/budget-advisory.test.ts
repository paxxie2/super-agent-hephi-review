import { describe, expect, it } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import { ADVISORY_BUDGET, advisoryBudgetWarnings, disciplineProblems, type ChangeSummary } from '../../src/control/discipline.js'
import { hephiTaskPrompt } from '../../src/control/worker-mount.js'

// B1.1/T03 合同聚焦验收：advisory budget 只记录不拒绝；显式 budget 才是硬边界。
// 单元级验证（直接构造 contract/changes，不走 git diff 路径）。

const acceptance = [{ id: 'a1', text: 'fix total()', check: 'tests', paths: ['src/**'] }]

function contract(task: ActivationContract['task']): ActivationContract {
  return { allowedPaths: ['src/**', 'tests/**'], task } as unknown as ActivationContract
}

function changes(files: string[], changedLines: number): ChangeSummary {
  return { files, changedLines, deleted: [], added: [] }
}

const manyFiles = Array.from({ length: ADVISORY_BUDGET.maxFiles + 1 }, (_, i) => `src/m${String(i).padStart(2, '0')}.js`)

describe('B1.1/T03 advisory budget — recorded, never a refusal', () => {
  it('ADVISORY_BUDGET keeps the documented defaults (single source of truth)', () => {
    expect(ADVISORY_BUDGET).toEqual({ maxFiles: 8, maxChangedLines: 400 })
  })

  it('without a budget, exceeding 8 files only warns: no discipline problem, no refusal', () => {
    const c = contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [] })
    const warnings = advisoryBudgetWarnings(c, changes(manyFiles, 10))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`touches ${manyFiles.length} files`)
    expect(warnings[0]).toContain('does not block delivery')
    expect(disciplineProblems(c, changes(manyFiles, 10))).toEqual([])
  })

  it('without a budget, exceeding 400 changed lines only warns: no discipline problem', () => {
    const c = contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [] })
    const warnings = advisoryBudgetWarnings(c, changes(['src/price.js'], ADVISORY_BUDGET.maxChangedLines + 1))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`${ADVISORY_BUDGET.maxChangedLines + 1} changed lines`)
    expect(warnings[0]).toContain('does not block delivery')
    expect(disciplineProblems(c, changes(['src/price.js'], ADVISORY_BUDGET.maxChangedLines + 1))).toEqual([])
  })

  it('within the advisory limits there is no warning at all', () => {
    const c = contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [] })
    expect(advisoryBudgetWarnings(c, changes(['src/price.js'], 40))).toEqual([])
  })

  it('a contract without a task card never produces advisory warnings', () => {
    const c = contract(undefined)
    expect(advisoryBudgetWarnings(c, changes(manyFiles, 500))).toEqual([])
  })
})

describe('B1.1/T03 explicit budget — the only hard limit', () => {
  it('an explicit budget over its limits becomes a discipline problem (refused)', () => {
    const c = contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [], budget: { maxFiles: 3, maxChangedLines: 100 } })
    const problems = disciplineProblems(c, changes(manyFiles, 500))
    expect(problems.some(p => p.includes('the task budget is 3'))).toBe(true)
    expect(problems.some(p => p.includes('the task budget is 100'))).toBe(true)
    // The explicit budget also suppresses the advisory warnings path.
    expect(advisoryBudgetWarnings(c, changes(manyFiles, 500))).toEqual([])
  })

  it('an explicit budget that is respected refuses nothing', () => {
    const c = contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [], budget: { maxFiles: 20, maxChangedLines: 1000 } })
    expect(disciplineProblems(c, changes(manyFiles, 500))).toEqual([])
  })
})

describe('B1.1/T03 worker prompt states the estimate, not a refusal', () => {
  it('without a budget the prompt advertises the advisory estimate as recorded-but-not-refused', () => {
    const prompt = hephiTaskPrompt(contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [] }))
    expect(prompt).toContain(`Advisory change budget, recorded but not refused: at most ${ADVISORY_BUDGET.maxFiles} files and ${ADVISORY_BUDGET.maxChangedLines} changed lines.`)
    expect(prompt).not.toContain('Exceeding it is refused')
  })

  it('with a budget the prompt states the hard boundary', () => {
    const prompt = hephiTaskPrompt(contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [], budget: { maxFiles: 3 } }))
    expect(prompt).toContain('at most 3 files')
    expect(prompt).toContain('Exceeding it is refused.')
  })
})
