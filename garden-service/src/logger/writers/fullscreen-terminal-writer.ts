/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import cliCursor from "cli-cursor"
import elegantSpinner from "elegant-spinner"
import wrapAnsi from "wrap-ansi"
import chalk from "chalk"
import blessed from "neo-blessed"

import { formatForTerminal, leftPad, renderMsg, basicRender } from "../renderers"
import { LogEntry } from "../log-entry"
import { Logger } from "../logger"
import { LogLevel } from "../log-node"
import { getChildEntries } from "../util"
import { Writer } from "./base"
import { shutdown } from "../../util/util"

const INTERVAL_MS = 60
const THROTTLE_MS = 600

const spinnerStyle = chalk.cyan
const spinnerBytes = spinnerStyle(elegantSpinner()()).length

export type Coords = [number, number]

export interface TerminalEntry {
  key: string
  text: string
  lineNumber: number
  spinnerCoords?: Coords
}

export interface TerminalEntryWithSpinner extends TerminalEntry {
  spinnerCoords: Coords
}

export interface KeyHandler {
  keys: string[]
  listener: (key: string) => void
}

export class FullscreenTerminalWriter extends Writer {
  type = "fullscreen"

  private spinners: { [key: string]: Function }
  private intervalID: NodeJS.Timer | null
  private lastInterceptAt: number | null
  private updatePending: boolean
  private initialized: boolean
  private errorMessages: string[]
  private prevOutput: string[]
  private scrolling: boolean
  private logger: Logger

  public screen: any
  public main: any
  public bottom: any
  public keyHandlers: KeyHandler[]

  constructor(level: LogLevel = LogLevel.info) {
    super(level)
    this.intervalID = null
    this.spinners = {} // Each entry has it's own spinner
    this.lastInterceptAt = null
    this.updatePending = false
    this.initialized = false
    this.errorMessages = []
    this.scrolling = false
    this.prevOutput = []
    this.keyHandlers = []
  }

  private init() {
    this.screen = blessed.screen({
      title: "garden",
      smartCSR: true,
      autoPadding: false,
      warnings: true,
      fullUnicode: true,
      ignoreLocked: ["C-c", "C-z"],
    })

    this.main = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-2",
      content: "",
      scrollable: true,
      alwaysScroll: true,
      border: false,
      padding: {
        left: 1,
        top: 1,
        bottom: 0,
        right: 1,
      },
      style: {
        fg: "white",
      },
      scrollbar: {
        bg: "white",
      },
    })

    this.bottom = blessed.box({
      top: "100%-2",
      left: 0,
      content: this.renderCommandLine(),
      scrollable: false,
      border: false,
      padding: {
        left: 1,
        right: 1,
        bottom: 1,
        top: 0,
      },
      style: {
        fg: "white",
        border: {},
      },
    })

    // TODO: may need to revisit how we terminate
    this.addKeyHandler({
      keys: ["C-c"],
      listener: () => {
        this.cleanup()
        shutdown(0)
      },
    })

    this.addKeyHandler({
      keys: ["0", "1", "2", "3", "4"],
      listener: (key) => {
        this.changeLevel(parseInt(key, 10))
        this.bottom.setContent(this.renderCommandLine())
        this.flashMessage(`Set log level to ${chalk.white.bold(LogLevel[this.level])} [${this.level}]`)
        this.screen.render()
      },
    })

    // Add scroll handlers
    this.addKeyHandler({
      keys: ["pageup"],
      listener: () => {
        // this.bottom.setContent("pageup " + this.scrolling + " " + this.main.getScroll() + " " + this.main.height)
        this.scrolling = true
        this.main.scrollTo(this.main.getScroll() - this.main.height - 2)
        this.screen.render()
      },
    })

    this.addKeyHandler({
      keys: ["pagedown"],
      listener: () => {
        // this.bottom.setContent("pagedn " + this.scrolling + " " + this.main.getScroll() + " " + this.main.height)
        this.main.scrollTo(this.main.getScroll() + this.main.height - 2)
        if (this.main.getScrollPerc() === 100) {
          this.scrolling = false
        }
        this.screen.render()
      },
    })

    this.screen.append(this.main)
    this.screen.append(this.bottom)
    this.main.focus()
    this.screen.render()

    this.initialized = true
  }

  /**
   * Flash a log message in a box
   */
  flashMessage(message: string, duration = 2000) {
    const box = blessed.box({
      top: "center",
      left: "center",
      align: "center",
      shrink: true,
      content: message,
      scrollable: false,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
      },
      padding: {
        left: 1,
        right: 1,
        bottom: 0,
        top: 0,
      },
    })
    this.screen.append(box)
    this.screen.render()

    setTimeout(() => {
      this.screen.remove(box)
      this.screen.render()
    }, duration)
  }

  addKeyHandler(handler: KeyHandler) {
    this.keyHandlers.push(handler)
    this.screen.key(handler.keys, handler.listener)
  }

  removeKeyHandler(handler: KeyHandler) {
    this.screen.unkey(handler.keys, handler.listener)
  }

  changeLevel(level: LogLevel) {
    this.level = level

    // Do a full re-render (if anything has been rendered)
    if (this.logger && this.main) {
      this.prevOutput = []
      this.main.setContent("")
      this.render(this.fullRender(this.logger))
    }
  }

  cleanup() {
    this.screen.destroy()
    cliCursor.show(process.stdout)
    for (const line of this.errorMessages) {
      process.stdout.write(line)
    }
    this.errorMessages = []
  }

  private renderCommandLine() {
    const level = `${this.level}=${LogLevel[this.level]}`
    return chalk.gray(`[page-up/down]: scroll   [0-4]: set log level (${level})   [ctrl-c]: quit`)
  }

  private spin(entries: TerminalEntryWithSpinner[]): void {
    entries.forEach((e) => {
      const [x, y] = e.spinnerCoords
      const line = this.main.getLine(y)
      this.main.setLine(
        y,
        line.substring(0, x) + spinnerStyle(this.tickSpinner(e.key)) + line.substring(x + spinnerBytes)
      )
    })
    this.screen.render()
  }

  private startLoop(entries: TerminalEntryWithSpinner[]): void {
    this.stopLoop()
    this.intervalID = setInterval(() => this.spin(entries), INTERVAL_MS)
  }

  private stopLoop(): void {
    if (this.intervalID) {
      clearInterval(this.intervalID)
      this.intervalID = null
    }
  }

  private tickSpinner(key: string): string {
    if (!this.spinners[key]) {
      this.spinners[key] = elegantSpinner()
    }
    return this.spinners[key]()
  }

  private write(output: string[]) {
    let y = 0
    let changed = false

    for (const line of output) {
      if (this.prevOutput.length < y || this.prevOutput[y] !== line) {
        changed = true
        this.main.setLine(y, line)
      }
      y++
    }

    if (changed) {
      if (!this.scrolling) {
        this.main.setScrollPerc(100)
      }
      this.screen.render()
    }
  }

  private handleGraphChange(log: LogEntry, logger: Logger, didWrite: boolean = false) {
    this.updatePending = false
    this.logger = logger

    // Suspend processing and write immediately if a lot of data is being intercepted, e.g. when user is typing in input
    if (log.fromStdStream && !didWrite) {
      const now = Date.now()
      const throttleProcessing = this.lastInterceptAt && now - this.lastInterceptAt < THROTTLE_MS
      this.lastInterceptAt = now

      if (throttleProcessing) {
        this.stopLoop()
        // this.box.pushLine(renderMsg(log))
        this.updatePending = true

        // Resume processing if idle and original update is still pending
        setTimeout(() => {
          if (this.updatePending) {
            this.handleGraphChange(log, logger, true)
          }
        }, THROTTLE_MS)
        return
      }
    }

    const terminalEntries = this.fullRender(logger)
    const nextEntry = terminalEntries.find((e) => e.key === log.key)

    // Nothing to do, e.g. because entry level is higher than writer level
    if (!nextEntry) {
      return
    }

    this.render(terminalEntries, didWrite)
  }

  private render(terminalEntries: TerminalEntry[], didWrite = false) {
    const output = terminalEntries
      .map((e) => e.text)
      .join("")
      .split("\n")

    if (!didWrite) {
      this.write(output)
    }

    this.prevOutput = output

    const entriesWithspinner = <TerminalEntryWithSpinner[]>terminalEntries.filter((e) => e.spinnerCoords)

    if (entriesWithspinner.length > 0) {
      this.startLoop(entriesWithspinner)
    } else {
      this.stopLoop()
    }
  }

  private fullRender(logger: Logger): TerminalEntry[] {
    let currentLineNumber = 0

    return getChildEntries(logger)
      .filter((entry) => this.level >= entry.level)
      .reduce((acc: TerminalEntry[], entry: LogEntry): TerminalEntry[] => {
        let spinnerFrame = ""
        let spinnerX: number
        let spinnerCoords: Coords | undefined

        if (entry.getMessageState().status === "active") {
          spinnerX = leftPad(entry).length
          spinnerFrame = this.tickSpinner(entry.key)
          spinnerCoords = [spinnerX, currentLineNumber]
        } else {
          delete this.spinners[entry.key]
        }

        const text = [entry]
          .map((e) => (e.fromStdStream ? renderMsg(e) : formatForTerminal(e, "fancy")))
          .map((str) =>
            spinnerFrame ? `${str.slice(0, spinnerX)}${spinnerStyle(spinnerFrame)} ${str.slice(spinnerX)}` : str
          )
          .map((str) =>
            wrapAnsi(str, this.main.width - 2, {
              trim: false,
              hard: true,
            })
          )
          .pop()!

        if (text) {
          acc.push({
            key: entry.key,
            lineNumber: currentLineNumber,
            spinnerCoords,
            text,
          })
        }

        currentLineNumber += text.split("\n").length - 1

        return acc
      }, [])
  }

  public onGraphChange(entry: LogEntry, logger: Logger): void {
    if (entry.level === LogLevel.error) {
      const out = basicRender(entry, logger)
      if (out) {
        this.errorMessages.push(out)
      }
    }

    if (!this.initialized) {
      this.init()
    }

    this.handleGraphChange(entry, logger, false)
  }

  public stop(): void {
    this.stopLoop()
  }
}
