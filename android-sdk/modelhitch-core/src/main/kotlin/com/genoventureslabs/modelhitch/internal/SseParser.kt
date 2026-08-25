package com.genoventureslabs.modelhitch.internal

internal class SseParser {
    private val currentData = mutableListOf<String>()
    private var pending = ""

    fun accept(text: String): List<String> {
        pending += text
        val events = mutableListOf<String>()
        while (true) {
            val lineEnd = pending.indexOf('\n')
            if (lineEnd < 0) break
            val line = pending.substring(0, lineEnd).removeSuffix("\r")
            pending = pending.substring(lineEnd + 1)
            processLine(line, events)
        }
        return events
    }

    fun finish(): List<String> {
        val events = mutableListOf<String>()
        if (pending.isNotEmpty()) processLine(pending.removeSuffix("\r"), events)
        pending = ""
        emit(events)
        return events
    }

    private fun processLine(line: String, events: MutableList<String>) {
        if (line.isEmpty()) {
            emit(events)
            return
        }
        if (line.startsWith(":")) return
        if (line == "data") {
            currentData += ""
        } else if (line.startsWith("data:")) {
            currentData += line.substringAfter(':').removePrefix(" ")
        }
    }

    private fun emit(events: MutableList<String>) {
        if (currentData.isEmpty()) return
        val payload = currentData.joinToString("\n")
        currentData.clear()
        if (payload.isNotEmpty() && payload != "[DONE]") events += payload
    }
}