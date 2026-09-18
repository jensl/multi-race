/**
 * The game screen's furniture: the problem, the typed answer, the clock, and
 * the scoreboard. Shared by single player and multiplayer because a player is
 * doing the same thing in both -- reading a sum and typing a number -- and the
 * only difference is whether anyone else is watching the same sum.
 *
 * Updates are targeted rather than a re-render: the clock moves every frame and
 * the scoreboard changes a handful of times a round, so this keeps a reference
 * to each node it will ever touch and writes to it directly.
 */
import { el, setText, toggleClass } from './dom.ts'
import { createKeypad, type Keypad, type KeypadHandlers } from './keypad.ts'
import { formatProblem, type Problem } from '../game/problem.ts'

export interface ScoreRow {
  /**
   * The player's identity. Rows are cached by this and not by name: two people
   * in the same room can pick the same name, and keying by it would show one
   * player's score on the other's row.
   */
  id: string
  name: string
  score: number
  /** Has answered this round correctly. */
  done: boolean
  isSelf: boolean
}

export interface ProblemView {
  readonly el: HTMLElement
  setMode(name: string): void
  setRound(text: string): void
  showProblem(problem: Problem): void
  /** Puts a line where the problem goes, for the countdown before it is shown. */
  setProblemText(text: string): void
  /** The digits typed so far; empty means the placeholder shows. */
  setInput(text: string): void
  setTimer(remainingMs: number, totalMs: number): void
  setStatus(text: string): void
  flash(kind: 'correct' | 'wrong'): void
  setScores(rows: readonly ScoreRow[]): void
  setKeypadEnabled(on: boolean): void
  /** Called when the input should be cleared, e.g. on a wrong answer. */
  clearInput(): void
  dispose(): void
}

export function createProblemView(handlers: KeypadHandlers): ProblemView {
  const modeLine = el('span', 'game-mode')
  const roundLine = el('span', 'game-round')
  const timerFill = el('div', 'timer-fill')
  const timerBar = el('div', 'timer', timerFill)

  const problemLine = el('p', 'problem')
  const answerLine = el('p', 'answer')
  const statusLine = el('p', 'status')

  const scores = el('ol', 'scores')
  scores.hidden = true
  const scoreRows = new Map<string, { root: HTMLElement; name: HTMLElement; points: HTMLElement }>()

  const keypad: Keypad = createKeypad(handlers)

  const body = el('div', 'game-body', problemLine, answerLine, statusLine)
  const root = el(
    'section',
    'game',
    el('header', 'game-head', modeLine, roundLine),
    timerBar,
    body,
    scores,
    keypad.el,
  )

  let flashTimer: ReturnType<typeof setTimeout> | null = null
  /** Last scoreboard drawn, so an unchanged one is not redrawn. */
  let lastScores = ''

  function clearFlash(): void {
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = null
    body.classList.remove('correct', 'wrong')
  }

  function flash(kind: 'correct' | 'wrong'): void {
    clearFlash()
    // Forces a reflow so the animation restarts even when two answers land in
    // quick succession -- without it the second flash simply does not play.
    void body.offsetWidth
    body.classList.add(kind)
    flashTimer = setTimeout(() => {
      body.classList.remove(kind)
      flashTimer = null
    }, kind === 'wrong' ? 420 : 260)
  }

  return {
    el: root,

    setMode(name) {
      setText(modeLine, name)
    },

    setRound(text) {
      setText(roundLine, text)
    },

    showProblem(problem) {
      setText(problemLine, `${formatProblem(problem)} =`)
    },

    setProblemText(text) {
      setText(problemLine, text)
    },

    setInput(text) {
      setText(answerLine, text)
      toggleClass(answerLine, 'empty', text.length === 0)
    },

    setTimer(remainingMs, totalMs) {
      const fraction = totalMs <= 0 ? 0 : Math.max(0, Math.min(1, remainingMs / totalMs))
      // scaleX rather than width: no layout, and it is the one thing on this
      // screen that changes on every frame.
      timerFill.style.transform = `scaleX(${fraction})`
      toggleClass(timerBar, 'urgent', fraction <= 0.25)
    },

    setStatus(text) {
      setText(statusLine, text)
    },

    flash,

    setScores(rows) {
      // Redrawing identical rows is not free -- it churns the DOM every time the
      // screen re-renders -- and the screen now re-renders on a timer as well as
      // on events, so an unchanged scoreboard is the common case, not a rarity.
      const signature = rows.map((r) => `${r.id}:${r.name}:${r.score}:${r.done}:${r.isSelf}`).join('|')
      if (signature === lastScores) return
      lastScores = signature

      scores.hidden = rows.length === 0
      scores.replaceChildren(
        ...rows.map((row) => {
          let cached = scoreRows.get(row.id)
          if (!cached) {
            const name = el('span', 'score-name')
            const points = el('span', 'score-points')
            const root = el('li', 'score', name, points)
            cached = { root, name, points }
            scoreRows.set(row.id, cached)
          }
          setText(cached.name, row.isSelf ? `${row.name} (you)` : row.name)
          setText(cached.points, row.done ? `✓ ${row.score}` : String(row.score))
          toggleClass(cached.root, 'done', row.done)
          toggleClass(cached.root, 'self', row.isSelf)
          return cached.root
        }),
      )
    },

    setKeypadEnabled(on) {
      keypad.setEnabled(on)
    },

    clearInput() {
      setText(answerLine, '')
      toggleClass(answerLine, 'empty', true)
    },

    dispose() {
      clearFlash()
      keypad.dispose()
    },
  }
}
