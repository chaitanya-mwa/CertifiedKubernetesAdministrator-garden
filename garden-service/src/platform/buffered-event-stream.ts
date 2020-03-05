/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import axios from "axios"
import chalk from "chalk"
import { includes } from "lodash"
import { registerCleanupFunction } from "../util/util"
import { GardenEvents, GardenEventName, EventBus, loggerEventNames } from "../events"
import { LogEntryMetadata, LogEntry } from "../logger/log-entry"
import { chainMessages } from "../logger/renderers"

export type StreamEvent = {
  name: GardenEventName
  payload: GardenEvents[GardenEventName]
}

export interface LogEntryEvent {
  key: string
  parentKey: string | null
  revision: number
  msg: string | string[]
  data?: any
  section?: string
  metadata?: LogEntryMetadata
}

export function formatForEventStream(entry: LogEntry): LogEntryEvent {
  const { section, data } = entry.getMessageState()
  const { key, revision } = entry
  const parentKey = entry.parent ? entry.parent.key : null
  const metadata = entry.getMetadata()
  const msg = chainMessages(entry.getMessageStates() || [])
  return { key, parentKey, revision, msg, data, metadata, section }
}

export const FLUSH_INTERVAL_MSEC = 3000
export const MAX_BATCH_SIZE = 200

/**
 * Buffers events and log entries and periodically POSTs them to the platform.
 */
export class BufferedEventStream {
  private eventBus: EventBus
  public sessionId: string
  private platformUrl: string
  private clientAuthToken: string
  private intervalId: NodeJS.Timer | null

  private bufferedEvents: StreamEvent[]
  private bufferedLogEntries: LogEntryEvent[]

  constructor(eventBus: EventBus, sessionId: string, platformUrl: string, clientAuthToken: string) {
    this.eventBus = eventBus
    this.sessionId = sessionId
    this.platformUrl = platformUrl
    this.clientAuthToken = clientAuthToken
    this.bufferedEvents = []
    this.bufferedLogEntries = []

    this.eventBus.onAny((name, payload) => {
      if (includes(loggerEventNames, name)) {
        this.streamLogEntry(payload as LogEntryEvent)
      } else {
        this.streamEvent(name as GardenEventName, payload)
      }
    })

    this.intervalId = setInterval(() => {
      this.flushBuffered({ flushAll: false })
    }, FLUSH_INTERVAL_MSEC)

    registerCleanupFunction("flushAllBufferedEventsAndLogEntries", () => {
      if (this.intervalId) {
        clearInterval(this.intervalId)
        this.intervalId = null
      }
      this.flushBuffered({ flushAll: true })
    })
  }

  streamEvent<T extends GardenEventName>(name: T, payload: GardenEvents[T]) {
    this.bufferedEvents.push({
      name,
      payload,
    })
  }

  streamLogEntry(logEntry: LogEntryEvent) {
    this.bufferedLogEntries.push(logEntry)
  }

  flushBuffered({ flushAll = false }) {
    const eventsToFlush = this.bufferedEvents.splice(0, flushAll ? this.bufferedEvents.length : MAX_BATCH_SIZE)
    // console.log("-------------")
    // console.log("flushBuffered")

    if (eventsToFlush.length > 0) {
      const events = {
        // clientAuthToken: this.clientAuthToken,
        sessionId: this.sessionId,
        events: eventsToFlush,
      }
      console.log("")
      console.log(chalk.blue(`would post ${eventsToFlush.length} events`))
      // console.log(chalk.blue(`would post events: ${JSON.stringify(events)}`))
      console.log("")
      // axios.post(`${this.platformUrl}/events`, {
      //   clientAuthToken: this.clientAuthToken,
      //   sessionId: this.sessionId,
      //   events: eventsToFlush,
      // })
    }

    const logEntryFlushCount = flushAll ? this.bufferedLogEntries.length : MAX_BATCH_SIZE - eventsToFlush.length
    const logEntriesToFlush = this.bufferedLogEntries.splice(0, logEntryFlushCount)

    if (logEntriesToFlush.length > 0) {
      const logEntries = {
        // clientAuthToken: this.clientAuthToken,
        sessionId: this.sessionId,
        logEntries: logEntriesToFlush,
      }
      console.log(chalk.green(`would post ${logEntriesToFlush.length} log entries`))
      // console.log(chalk.green(`would post log entries: ${JSON.stringify(logEntries)}`))
      // axios.post(`${this.platformUrl}/log-entries`, {
      //   clientAuthToken: this.clientAuthToken,
      //   sessionId: this.sessionId,
      //   logEntries: logEntriesToFlush,
      // })
    }
  }
}
