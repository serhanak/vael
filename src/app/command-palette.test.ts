import { describe, it, expect, vi, beforeEach } from 'vitest'
import './command-palette'
import type { CommandPalette } from './command-palette'
import type { Command } from './commands'

// Component-level tests for the palette's interaction wiring (keyboard nav +
// run + close). The ranking itself is covered in commands.test.ts; here we only
// assert that keys select and invoke the right command. Runs in vitest's jsdom
// environment (same as the renderer tests).

function cmd(id: string, title: string, enabled = true): Command {
  return { id, title, enabled, run: vi.fn() }
}

async function mount(commands: Command[]): Promise<CommandPalette> {
  const el = document.createElement('command-palette') as CommandPalette
  el.commands = commands
  el.open = true
  document.body.append(el)
  await el.updateComplete
  await el.updateComplete // second tick: `updated(open)` resets selection/query
  return el
}

function key(el: CommandPalette, k: string) {
  const input = el.shadowRoot!.querySelector('input')!
  input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
}

describe('<command-palette> interaction', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('runs the first command on Enter and asks the host to close', async () => {
    const cmds = [cmd('a', 'Alpha'), cmd('b', 'Bravo')]
    const el = await mount(cmds)
    const closed = vi.fn()
    el.addEventListener('close', closed)

    key(el, 'Enter')
    expect((cmds[0] as any).run).toHaveBeenCalledOnce()
    expect((cmds[1] as any).run).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('ArrowDown moves selection before running', async () => {
    const cmds = [cmd('a', 'Alpha'), cmd('b', 'Bravo')]
    const el = await mount(cmds)

    key(el, 'ArrowDown')
    await el.updateComplete
    key(el, 'Enter')
    expect((cmds[1] as any).run).toHaveBeenCalledOnce()
    expect((cmds[0] as any).run).not.toHaveBeenCalled()
  })

  it('skips a disabled first command when selecting the initial row', async () => {
    const cmds = [cmd('a', 'Alpha', false), cmd('b', 'Bravo', true)]
    const el = await mount(cmds)

    key(el, 'Enter')
    expect((cmds[1] as any).run).toHaveBeenCalledOnce()
    expect((cmds[0] as any).run).not.toHaveBeenCalled()
  })

  it('Escape closes without running anything', async () => {
    const cmds = [cmd('a', 'Alpha')]
    const el = await mount(cmds)
    const closed = vi.fn()
    el.addEventListener('close', closed)

    key(el, 'Escape')
    expect(closed).toHaveBeenCalledOnce()
    expect((cmds[0] as any).run).not.toHaveBeenCalled()
  })

  it('filters as the query narrows the list', async () => {
    const cmds = [cmd('open', 'Open File'), cmd('save', 'Save'), cmd('exp', 'Export HTML')]
    const el = await mount(cmds)
    const input = el.shadowRoot!.querySelector('input')!
    input.value = 'exp'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await el.updateComplete

    const titles = [...el.shadowRoot!.querySelectorAll('li .title')].map((n) => n.textContent)
    expect(titles).toHaveLength(1)
    expect(titles[0]).toContain('Export HTML')
  })
})
